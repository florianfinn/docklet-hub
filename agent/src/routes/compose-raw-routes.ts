import {
  COMPOSE_FILE_NAME,
  isInsideBase,
  isValidComposeFileName,
  isValidProjectName,
  locationFor
} from "../compose.js";
import { forcedManagement } from "../stacks.js";
import {
  composeConfig
} from "../compose-cli.js";
import {
  readComposeFile
} from "../compose-store.js";
import {
  serviceNamesFromConfig
} from "../compose-raw.js";
import {
  type RawLocation
} from "../raw-apply.js";
import { rawComposeLocation } from "../raw-compose-location.js";
import { externallyManagedServices } from "../raw-ownership.js";
import { sendLine } from "../ndjson-line.js";
import { config, engine, registry, audit, openStreams } from "../runtime/state.js";
import { composeBasePath, selectedComposeContext, resolveFullContainerId } from "../runtime/containers.js";
import {
  rawOps,
  rawReason,
  RawExecution,
  executeRaw,
  inventoryViolationsOf,
  previewRaw
} from "../runtime/raw-ops.js";
import {
  composeRawPreviewRequestSchema,
  composeRawWriteRequestSchema,
  type ComposeApplyStreamLine
} from "contract";
import { send, readJsonBody, parseRequest, rejectRequest, ContainerRouteContext } from "../runtime/http.js";

// --- Raw compose editor (stage 7) -----------------------------------------
//
// The anchor is an allowlisted container, the work piece is its FILE — and
// with it the whole stack. This shift in granularity is the most dangerous
// part of the stage (lesson from 5d), which is why it has its own check
// here: every service with a running container must be on the agent's
// allowlist, not just the one named.
//
// As everywhere, the directory comes from the agent's OWN copy and never
// from the request (security review 5c, finding 4).
//
// Four entry points, ONE front section: read (GET), dry run (#85), write
// and write with live output (#86) share every check up to and including
// "every service of this stack is on the allowlist". A separate front
// section per entry point would be the construction that finding S1 came
// from — a control that has to be maintained in two places drifts apart.
export async function handleComposeRaw(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, actor, tier, parsedTier, containerId, action } = ctx;
  const previewing = action === "compose-raw-preview";
  const streaming = action === "compose-raw-stream";
  // ⚠️ The streamed route falls under `writing` here without exception — it
  // IS the applying. Kill switch, hash latch and the typed confirmation
  // therefore apply to it just as to the synchronous one; no branch below
  // exempts it.
  const writing = !previewing && request.method === "POST";

  // ⚠️ The dry run also falls under the kill switch, even though it writes
  // nothing lasting. Two reasons, each sufficient on its own: it puts the
  // draft as a file into the project directory (otherwise
  // `docker compose config` does not read it), and a read-only agent would
  // reject the apply anyway — a preview of an operation this agent does not
  // carry out would be information about nothing.
  if ((writing || previewing) && config.readOnly) {
    send(response, 503, { error: rawReason("agent-read-only") });
    return;
  }
  if (!registry.isAllowed(containerId)) {
    send(response, 404, { error: rawReason("not-allowlisted") });
    return;
  }

  const entry = registry.get(containerId);
  const anchorName = entry?.containerName ?? "";
  const inspect = await engine.inspect(containerId);
  if (anchorName !== (inspect.Name ?? "").replace(/^\//, "")) {
    send(response, 409, { error: rawReason("stack-anchor-stale") });
    return;
  }
  const labels = inspect.Config?.Labels ?? undefined;
  const selected = selectedComposeContext(anchorName, labels);
  const resolved = rawComposeLocation(anchorName, entry?.compose, labels, selected, composeBasePath,
    (projectDir, fileName) => readComposeFile(projectDir, fileName).exists);
  if (!resolved.ok) {
    const reason = resolved.reason === "compose-anchor-outside-base-path"
      ? rawReason("compose-anchor-outside-base-path")
      : resolved.reason === "compose-anchor-file-ambiguous"
        ? rawReason("compose-anchor-file-ambiguous")
        : resolved.reason === "name-not-usable-as-directory"
          ? rawReason("name-not-usable-as-directory")
          : rawReason("compose-anchor-labels-missing");
    send(response, resolved.reason === "name-not-usable-as-directory" ? 400 : 409,
      { error: reason, projectDir: resolved.projectDir });
    return;
  }
  const location: RawLocation = resolved.location;
  // Both values come from the agent's own copy and are checked anyway —
  // the same reasoning as on the resolve path: a guarantee that counts
  // here should not depend on the sync path having been clean.
  if (!isValidComposeFileName(location.composeFileName)) {
    send(response, 400, { error: rawReason("invalid-compose-file-name") });
    return;
  }
  if (!isValidProjectName(location.projectName)) {
    send(response, 409, { error: rawReason("compose-project-name-missing-or-invalid") });
    return;
  }
  if (!isInsideBase(location.projectDir, composeBasePath)) {
    send(response, 400, { error: rawReason("project-dir-outside-base-path") });
    return;
  }
  // Self-management lock (5d), here on the DIRECTORY instead of on the
  // single container: the editor writes the file of the whole stack.
  // gate() does not apply on this path, because the unit of work here is
  // not one container.
  if (forcedManagement(location.projectDir) === "read-only") {
    audit.write({
      action: "compose-raw",
      containerId,
      containerName: anchorName,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: `self-management-locked: ${location.projectDir}`
    });
    send(response, 403, {
      error: rawReason("self-management-locked"),
      projectDir: location.projectDir
    });
    return;
  }

  const file = readComposeFile(location.projectDir, location.composeFileName);
  if (!file.exists) {
    send(response, 409, { error: rawReason("compose-file-missing"), projectDir: location.projectDir });
    return;
  }

  // ⚠️ The actual state is the existing CONTAINERS, not the services the
  // file names.
  //
  // This is not a subtlety. `docker compose up` creates every service in
  // the file — including one for which no container exists yet. If the
  // actual state were taken from the file, such a service would be neither
  // "new" nor require confirmation, and a container would come into being
  // whose permissions nobody ever decided on. That is exactly what the
  // confirmation is meant to prevent.
  //
  // `composePs` runs with --all, so stopped containers count as well: an
  // existing service that is merely stopped is rightly not considered new.
  const running = await rawOps.containerIds(location);
  const currentServices = [...running.keys()].sort();

  // For display only: what the file currently names. If it differs from
  // the existing containers, that is a statement about the state and not
  // an error — an unreadable existing file is in fact the most common
  // reason to need the editor at all.
  let fromFile: string[] = [];
  try {
    fromFile = serviceNamesFromConfig(await composeConfig(location)) ?? [];
  } catch {
    // Stays empty; the response says so via `fileReadable`.
  }

  // ⚠️ The second line of defence for this stage's decision ("permissions
  // on EVERY service of the file"). The main API checks the grants — it
  // knows them. The agent cannot do that, but it can check that every
  // service of this stack is on its allowlist at all. Without this, ONE
  // allowlisted container would be enough to reach all the others in the
  // same directory via the shared file.
  const notAllowlisted = [...running.entries()]
    .filter(([, id]) => !registry.isAllowed(id))
    .map(([serviceName]) => serviceName)
    .sort();
  if (notAllowlisted.length > 0) {
    audit.write({
      action: "compose-raw",
      containerId,
      containerName: anchorName,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: `stack-service-not-allowlisted: ${notAllowlisted.join(",")}`
    });
    send(response, 403, {
      error: rawReason("stack-service-not-allowlisted"),
      services: notAllowlisted
    });
    return;
  }

  // The manager of an externally managed service owns the file's definition.
  // Preview and apply are refused here with a real status and again under the
  // project lock (runtime/raw-ops.ts); reading stays open.
  const managed = writing || previewing
    ? externallyManagedServices(containerId, running, (id) => registry.isExternallyManaged(id))
    : null;
  if (managed !== null) {
    audit.write({
      action: previewing ? "compose-raw-preview" : "compose-raw",
      containerId,
      containerName: anchorName,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: `externally-managed: ${managed.join(",")}`
    });
    send(response, 403, { error: rawReason("externally-managed"), services: managed });
    return;
  }

  // The directory name is the identity of the stack — and what gets typed
  // for confirmation (3.11).
  const stackName = location.projectDir.slice(location.projectDir.lastIndexOf("/") + 1);

  // The dry run (#85). The same body as applying, just without the
  // confirmation fields — it decides nothing, so nobody confirms anything
  // either.
  if (previewing) {
    // As below: the table binds this route as internal, the branch is
    // unreachable and exists only for the type guarantee.
    if (!parsedTier) {
      send(response, 400, { error: rawReason("tier-missing") });
      return;
    }
    const preview = parseRequest(composeRawPreviewRequestSchema, await readJsonBody(request));
    if (!preview.ok) {
      rejectRequest(ctx, { action: "compose-raw-preview", containerId, containerName: anchorName }, preview.rejection);
      return;
    }
    const result = await previewRaw({
      location,
      // The same reading as when applying (`content` defaults to "" in both
      // schemas). It has to be the same, otherwise the preview would judge a
      // different text than the one about to be written.
      content: preview.value.content,
      actor,
      tier: parsedTier,
      containerId,
      stackName
    });
    send(response, result.status, result.body);
    return;
  }

  if (!writing) {
    // What is ALREADY violated NOW. Without this list a UI would see
    // violations after saving that it had not announced before — and the
    // operator would take existing problems for a consequence of their
    // edit.
    const inventory = await inventoryViolationsOf(running);
    audit.write({
      action: "compose-raw-read",
      containerId,
      containerName: anchorName,
      actor,
      networkTier: tier,
      outcome: "allowed",
      reason: location.projectDir
    });
    send(response, 200, {
      projectDir: location.projectDir,
      composeFileName: location.composeFileName,
      stackName,
      content: file.content,
      // Exactly this hash has to be confirmed along with the save.
      composeHash: file.hash,
      // The services with an existing container — that is the actual state
      // the diff runs against when saving.
      services: currentServices,
      // What the file names. A difference is a statement about state, not an
      // error (e.g. a service that is defined but was never created — on save
      // it counts as new and has to be confirmed).
      servicesInFile: fromFile,
      fileReadable: fromFile.length > 0,
      // The id per service, so that the main API can map its grants onto
      // it.
      containerIds: Object.fromEntries(running),
      inventoryViolations: inventory
    });
    return;
  }

  // A missing or blank hash is refused by the schema with
  // `compose-hash-missing`, the key this route gave for it before #272.
  const parsedBody = parseRequest(composeRawWriteRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "compose-raw", containerId, containerName: anchorName }, parsedBody.rejection);
    return;
  }
  const { content, expectedComposeHash: expectedHash, confirmName, ...confirmations } = parsedBody.value;
  // Typed confirmation (3.11). Deliberately the directory name and not the
  // container name: what is edited is the file of the stack, not a
  // container.
  if (confirmName !== stackName) {
    audit.write({
      action: "compose-raw",
      containerId,
      containerName: anchorName,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: "confirmation-missing"
    });
    send(response, 400, { error: rawReason("confirmation-missing"), expected: stackName });
    return;
  }

  // As above: the table binds this route as internal, the branch is
  // unreachable and exists only for the type guarantee.
  if (!parsedTier) {
    send(response, 400, { error: rawReason("tier-missing") });
    return;
  }
  const execution: RawExecution = {
    location,
    content,
    expectedHash,
    currentServices,
    confirmations,
    actor,
    tier: parsedTier,
    containerId,
    stackName
  };

  // The streamed route (#86).
  //
  // It runs THE SAME `executeRaw` as the line below and passes its response
  // through unchanged as the last line. That is the whole construction, and
  // it is the reason why the 24 error keys of this route cannot get lost
  // here: there is no second place where a response could arise. A stream
  // that folded the error into a text line would be a step backwards for
  // the caller compared with the synchronous JSON.
  //
  // ⚠️ A dropped connection does NOT abort the operation — unlike the pull
  // stream, where exactly that is intended. Between writing the file and
  // the `up`, an abort would be a half-edited stack without rollback.
  // Whoever is listening decides nothing here; they only watch.
  if (streaming) {
    // R3: the same pool as the log and pull streams. It is the longest-lived
    // of them all — up to ten minutes — and it is rejected BEFORE anything
    // has started: a 429 here costs nothing.
    const releaseStreamSlot = openStreams.tryAcquire();
    if (!releaseStreamSlot) {
      audit.write({
        action: "compose-raw",
        containerId,
        containerName: anchorName,
        actor,
        networkTier: tier,
        outcome: "denied",
        reason: "too-many-streams"
      });
      send(response, 429, { error: rawReason("too-many-streams") });
      return;
    }
    // Fallback as with the other streams: `close` fires on every path, the
    // release only counts once.
    response.once("close", releaseStreamSlot);

    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await executeRaw({
        ...execution,
        // Only here is the status fixed (200) — see the reasoning at
        // `onLocked`.
        onLocked: () => {
          response.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store, no-transform"
          });
          sendLine(response, {
            kind: "start",
            projectDir: location.projectDir,
            composeFileName: location.composeFileName,
            stackName
          } satisfies ComposeApplyStreamLine);
        },
        onStep: (step, detail) => {
          sendLine(response, {
            kind: "step",
            step,
            ...(detail === undefined ? {} : { detail })
          } satisfies ComposeApplyStreamLine);
        }
      });
    } catch (error) {
      // Before the first line the response is still a real status: the
      // outer error handler turns it into `409 stack-busy` or a
      // 500 — just as on the synchronous route.
      if (!response.headersSent) throw error;
      // Not any more after that. ⚠️ `kind: "error"` means something different
      // from a result with `error`: there the outcome is named and
      // `rolledBack` says where the stack stands. Here it is UNKNOWN —
      // the exception came from a call that never reached its verdict.
      // The caller has to re-read the state.
      console.error("[agent] compose-raw-stream:", error);
      sendLine(response, { kind: "error", reason: rawReason("compose-raw-failed") } satisfies ComposeApplyStreamLine);
      response.end();
      return;
    }
    // The final line: verbatim the response the synchronous route would
    // have delivered as a whole — status and body unchanged.
    sendLine(response, { kind: "result", status: result.status, body: result.body } satisfies ComposeApplyStreamLine);
    response.end();
    return;
  }

  const result = await executeRaw(execution);
  send(response, result.status, result.body);
  return;
}

// --- Re-resolve container id (stage 5c, gap 6.3.1) ------------------------
//
// Every recreate that the dashboard does not trigger — Dockge, a manual
// `docker compose up`, a stack restart — assigns a new container id. Up
// to 5b that meant: the container disappears from the dashboard and the
// grants are orphaned on the old id.
//
// The anchor is now directory + service. This route looks up the current
// id through it, so that the main API can update its rows instead of
// letting the container vanish without a word.
//
// Deliberately NO gate(): the container behind the old id no longer
// exists — inspecting it would be exactly the error this route is meant
// to fix. Allowlist and tier are checked anyway.
export async function handleResolve(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, tier, containerId } = ctx;
  if (!registry.isAllowed(containerId)) {
    send(response, 404, { error: "not-allowlisted" });
    return;
  }

  // ⚠️ The name comes from the agent's OWN allowlist copy, not from the
  // request (security review 5c, 2026-07-21).
  //
  // Previously the agent accepted `body.containerName` and moved the
  // allowlist entry to the container that was running in THIS directory.
  // A caller with a single legitimately allowlisted container could thus
  // re-hang the entry onto any other stack — Traefik, say — and then run
  // remove/recreate on it.
  //
  // That contradicts the very reason the second allowlist copy exists:
  // the agent is the last authority and must not assume that the main
  // API filtered correctly. A field it takes over unchecked makes its own
  // copy worthless.
  const entry = registry.get(containerId);
  const name = entry?.containerName ?? "";

  // Two origins, one anchor (stage 5d):
  //   * adopted         — the anchor is in the entry, because for existing
  //                       containers it cannot be derived from the name.
  //   * dashboard-owned — no anchor in the entry; locationFor(name) still
  //                       applies there.
  //
  // The stored path is checked against the base path anyway. It comes
  // from the agent's own copy and not from the request, but a guarantee
  // that counts here should not depend on the sync path having been
  // clean.
  const location = entry?.compose
    ? {
        projectDir: entry.compose.projectDir,
        serviceName: entry.compose.serviceName,
        composeFileName: entry.compose.composeFileName
      }
    : (() => {
        const own = locationFor(name, composeBasePath);
        return own
          ? {
              projectDir: own.projectDir,
              serviceName: own.serviceName,
              composeFileName: COMPOSE_FILE_NAME
            }
          : null;
      })();

  if (!location) {
    send(response, 400, { error: "name-not-usable-as-directory" });
    return;
  }
  // The file name is checked just like the directory next to it.
  //
  // Both come from the agent's own copy and not from the request; the
  // directory is cross-checked anyway — so the file name should not be the
  // one value that is believed unchecked. A value containing "/" or ".."
  // would, when joined, yield a path outside the project directory, and
  // `--file` would follow it.
  if (!isValidComposeFileName(location.composeFileName)) {
    send(response, 400, { error: "invalid-compose-file-name" });
    return;
  }
  if (!isInsideBase(location.projectDir, composeBasePath)) {
    send(response, 400, { error: "project-dir-outside-base-path" });
    return;
  }
  if (!readComposeFile(location.projectDir, location.composeFileName).exists) {
    send(response, 404, { error: "compose-file-missing", projectDir: location.projectDir });
    return;
  }

  const resolved = await resolveFullContainerId(location, location.serviceName);
  if (!resolved) {
    send(response, 404, { error: "container-not-resolvable", projectDir: location.projectDir });
    return;
  }

  // Cross-check on the resolved container: it must carry the name of the
  // entry. Via `docker compose ps` in the project directory it can hardly
  // miss that — but an allowlist entry is the permission to modify a
  // container, and that should rest on a check instead of on an
  // inference.
  const resolvedName = (await engine.inspect(resolved)).Name?.replace(/^\//, "") ?? "";
  if (resolvedName !== name) {
    audit.write({
      action: "resolve",
      containerId,
      containerName: name,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: `name-mismatch: ${resolvedName}`
    });
    send(response, 409, { error: "name-mismatch", expected: name });
    return;
  }

  const moved = registry.replaceContainerId(containerId, resolved);
  audit.write({
    action: "resolve",
    containerId: resolved,
    containerName: name,
    actor,
    networkTier: tier,
    outcome: "allowed",
    reason: `alt ${containerId.slice(0, 12)} -> neu ${resolved.slice(0, 12)}${moved ? "" : " (unverändert)"}`
  });
  send(response, 200, { ok: true, containerId: resolved, changed: moved });
  return;
}
