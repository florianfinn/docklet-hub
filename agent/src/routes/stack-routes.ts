import {
  containerCreateRequestSchema,
  stackActionRequestSchema,
  stackAdoptRequestSchema,
  stackRawPreviewRequestSchema,
  stackRawRequestSchema
} from "contract";
import {
  EngineError
} from "../engine.js";
import { parseImageRef } from "../image-ref.js";
import {
  composeContextOf,
  locationFor,
  servicesFromComposeConfig
} from "../compose.js";
import { discoverStacks, forcedManagement } from "../stacks.js";
import {
  composeConfig,
  composeDependencySafeRestart,
  composeDown,
  composePs,
  composeRestart,
  composeStart,
  composeStop,
  composeUp
} from "../compose-cli.js";
import { applyCompose } from "../compose-apply.js";
import {
  directoryOccupied,
  hasComposeFile,
  readComposeFile,
  directoriesWithComposeFile
} from "../compose-store.js";
import {
  normalizeSpec,
  specViolatesHardening,
  checkSpec
} from "../spec.js";
import {
  expectedStackMatches,
  isStackAction,
  stackActionDeny,
  stackNeedsDependencySafeRestart,
  type StackAction
} from "../stack-control.js";
import { config, engine, registry, audit, stackLocks } from "../runtime/state.js";
import { composeBasePath } from "../runtime/containers.js";
import { applyOps, rawReason } from "../runtime/raw-ops.js";
import { createProject, previewProject } from "../runtime/project-create.js";
import { send, readJsonBody, parseRequest, rejectRequest, RouteContext } from "../runtime/http.js";
import {
  StackEndpointError,
  stackProjectFromRegistry,
  prepareStack,
  ensureCreateScopeAllowlisted,
  ensureCreateScopeNotExternallyManaged,
  reanchorStackRegistry,
  containerIdsOf
} from "../runtime/stack.js";

// --- Stack discovery (stage 5d) -----------------------------------------
//
// Shows what actually lies on the host: Compose projects with their services,
// PLUS the cases that cannot be assigned cleanly. Like /host-containers,
// whoever sees the inventory also sees containers nobody has a permission for.
export async function handleStackList(ctx: RouteContext): Promise<void> {
  const { response, actor } = ctx;

  const result = discoverStacks({
    containers: await engine.listWithComposeLabels(),
    basePath: composeBasePath,
    directoryHasFile: hasComposeFile,
    directoriesWithFile: directoriesWithComposeFile(composeBasePath)
  });

  audit.write({
    action: "stack-discovery",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `${result.stacks.length} Stacks, ${result.findings.length} Befunde`
  });
  send(response, 200, result);
  return;
}

// --- Adoption of an existing stack (stage 5d) ---------------------------
//
// ⚠️ The caller names a CONTAINER ID, never a directory. Everything else —
// project directory, file name, service name — the agent reads off the labels
// of the running container. That is the same traversal guard as in 5c: there
// is no way to give the agent a path that it then touches. The information is
// self-proving, because only the daemon sets it.
//
// Adoption is explicitly READ-ONLY with respect to the file: it is read and
// hashed, never written. The survey for 5d showed that none of the inventory
// files would have survived a regeneration.
export async function handleStackAdopt(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;

  const adopt = parseRequest(stackAdoptRequestSchema, await readJsonBody(request));
  if (!adopt.ok) {
    rejectRequest(ctx, { action: "stack-adopt", containerId: null, containerName: null }, adopt.rejection);
    return;
  }
  const { containerId } = adopt.value;

  let inspect;
  try {
    inspect = await engine.inspect(containerId);
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      send(response, 404, { error: "container-gone" });
      return;
    }
    throw error;
  }

  const context = composeContextOf(inspect.Config?.Labels ?? undefined, composeBasePath);
  if (!context) {
    send(response, 409, { error: "no-compose-directory-in-base-path" });
    return;
  }

  const file = readComposeFile(context.projectDir, context.composeFileName);
  if (!file.exists) {
    // The case of the four projects whose directory no longer exists. Without
    // a file there is nothing to adopt — that is a finding, not an empty
    // response.
    send(response, 409, {
      error: "compose-file-missing",
      projectDir: context.projectDir,
      composeFileName: context.composeFileName
    });
    return;
  }

  // The file is read with Compose's own parser. What comes out is NOT
  // validated — it is the current state of a file someone wrote by hand.
  // `unsupportedKeys` says per service what the model does not represent.
  let services: unknown = null;
  let readError: string | null = null;
  try {
    const normalized = await composeConfig(context);
    const read = servicesFromComposeConfig(normalized);
    if (read.ok) services = read.services;
    else readError = read.reason;
  } catch (error) {
    readError = "compose-config-failed";
    console.error("[agent] compose config during adoption failed:", error);
  }
  if (!services) {
    send(response, 409, { error: readError ?? "compose-not-readable", projectDir: context.projectDir });
    return;
  }

  // Which containers are currently running for this project? That is the
  // authoritative mapping service -> container id, and it comes from Compose
  // itself instead of from a derivation via names.
  //
  // ⚠️ `docker compose ps` returns the SHORT id (12 characters), `inspect`
  // everywhere else the full one. There is only ONE form: the full one.
  //
  // Found live 2026-07-21 — and for the second time: the same trap had
  // already struck in 5c. Here the consequence would have been that adoption
  // writes short ids into the database while every route works with the full
  // id. The pointer container -> stack would then never have matched: the
  // server's read-only lock would have been ineffective (the agent caught
  // it), the Compose anchor would never have reached the agent, and
  // duplicates would have appeared in the allowlist.
  const runningShort = await composePs(context);
  const running = [];
  for (const entry of runningShort) {
    if (!entry.ID) continue;
    try {
      running.push({ ...entry, ID: (await engine.inspect(entry.ID)).Id });
    } catch (error) {
      // Vanished container: the service stays in the response, just without
      // an id. A guessed id would be worse than none.
      if (error instanceof EngineError && error.status === 404) continue;
      throw error;
    }
  }

  const management = forcedManagement(context.projectDir);

  audit.write({
    action: "stack-adopt",
    containerId,
    containerName: (inspect.Name ?? "").replace(/^\//, ""),
    actor,
    outcome: "allowed",
    reason: `${context.projectDir} (${management})`
  });

  send(response, 200, {
    projectDir: context.projectDir,
    projectName: context.project,
    composeFileName: context.composeFileName,
    // Exactly this hash is the reference point for later foreign changes.
    composeHash: file.hash,
    content: file.content,
    management: management,
    services,
    running: running.map((entry) => ({
      serviceName: entry.Service ?? "",
      containerName: entry.Name ?? "",
      containerId: entry.ID ?? "",
      state: entry.State ?? ""
    }))
  });
  return;
}

// --- List (allowlisted containers only): handled in src/index.ts ---------
// --- New stack from raw text (stage 7) ----------------------------------
//
// Not an operation of its own but the same as editing — just with an empty
// starting set and without an expected hash. That is exactly why the shared
// flow lives in executeRaw: a second track next to the same controls is the
// failure mode that 5d produced four times.
//
// The location follows from the NAME (locationFor), never from anything the
// caller states — the same traversal guard as when creating from a spec.
export async function handleStackRaw(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;
  if (config.readOnly) {
    send(response, 503, { error: rawReason("agent-read-only") });
    return;
  }

  const parsedBody = parseRequest(stackRawRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "compose-raw", containerId: null, containerName: null }, parsedBody.rejection);
    return;
  }
  const { name, content, confirmExternalSources, ...confirmations } = parsedBody.value;
  const result = await createProject({
    name,
    content,
    confirmations,
    confirmExternalSources,
    actor
  });
  send(response, result.status, result.body);
  return;
}

// The dry run of a new project (#128). The answer names host paths.
export async function handleStackRawPreview(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;
  // The dry run creates and removes a directory under the base path.
  if (config.readOnly) {
    send(response, 503, { error: rawReason("agent-read-only") });
    return;
  }
  const parsedBody = parseRequest(stackRawPreviewRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "compose-raw-preview", containerId: null, containerName: null }, parsedBody.rejection);
    return;
  }
  const result = await previewProject({ ...parsedBody.value, actor });
  send(response, result.status, result.body);
  return;
}

// --- Create a container from a spec (stage 5b, via Compose since 5c) -----
//
// Honest limit: on CREATE the agent has nothing of its own to check against —
// there is no allowlist entry yet, creating IS the introduction. Its promise
// here is therefore not "the API was allowed to ask that" (the API decides
// that via its scope), but: **what comes into being here obeys
// the hardening rules.** The spec has no field for privileged, capabilities or
// devices, and the self-check checks the result once more against the same
// rules that apply to the inventory.
//
// Stage 5c: the container no longer comes into being via a create call to the
// engine, but via a written Compose file and `docker compose up`. The result
// is the same container — but afterwards the definition lies in
// /home/docker/<name>/compose.yaml and no longer only in the app database. A
// backup of this directory contains definition AND data, and a
// `docker compose up` via SSH does exactly the same as the dashboard.
export async function handleContainerCreate(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;
  if (config.readOnly) {
    send(response, 503, { error: "agent-read-only" });
    return;
  }

  const parsedBody = parseRequest(containerCreateRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "create", containerId: null, containerName: null }, parsedBody.rejection);
    return;
  }
  // Stage 5e: on CREATE the class "gesichert" (secured) comes with the
  // request. That is permissible because here it is ONLY a tightening — the
  // universe /home/docker/<name> is a subset of the base path. A "wrong"
  // secured can therefore unlock nothing, only restrict additionally. For
  // running containers, on the other hand, the agent reads the class from its
  // own copy (hardeningOptionsFor), never from the request.
  const { secured } = parsedBody.value;
  const checked = checkSpec(parsedBody.value.spec, { bindBasePath: config.bindBasePath, secured });
  if (!checked.ok) {
    send(response, 400, { error: "invalid-spec", errors: checked.errors });
    return;
  }
  const spec = checked.spec;

  const parsed = parseImageRef(spec.imageRef);
  if (!parsed) {
    send(response, 400, { error: "image-ref-unreadable" });
    return;
  }

  const blocking = specViolatesHardening(spec, config.bindBasePath, secured);
  if (blocking.length > 0) {
    // Should no longer occur after validation — if it does, something has
    // slipped in the model, and then nothing is created.
    audit.write({
      action: "create",
      containerId: null,
      containerName: spec.name,
      actor,
      outcome: "denied",
      reason: `hardening-violated: ${blocking.join(",")}`
    });
    send(response, 403, { error: `hardening-violated: ${blocking.join(",")}` });
    return;
  }

  // The location follows from the name. There is deliberately no way to NAME
  // a directory to the agent — otherwise every call would be a possible
  // traversal attempt.
  const location = locationFor(spec.name, composeBasePath);
  if (!location) {
    send(response, 400, { error: "name-not-usable-as-directory" });
    return;
  }

  // Occupancy check (6.2): if a new container claims the name of an existing
  // directory, it is refused. That is the alternative to random ids in the
  // path — it solves the same collision question without sacrificing the
  // readable backup path.
  if (directoryOccupied(location.projectDir)) {
    audit.write({
      action: "create",
      containerId: null,
      containerName: spec.name,
      actor,
      outcome: "denied",
      reason: "directory-taken"
    });
    send(response, 409, {
      error: "directory-taken",
      projectDir: location.projectDir
    });
    return;
  }

  // If the image is not present locally, Compose would silently pull it on
  // `up`. The generated file therefore carries `pull_policy: never`, and the
  // pull happens here explicitly and logged: it is the moment foreign code
  // arrives on the host.
  let imageId = await engine.imageId(parsed.fullRef);
  if (!imageId) {
    audit.write({
      action: "create-pull",
      containerId: null,
      containerName: spec.name,
      actor,
      outcome: "allowed",
      reason: parsed.fullRef
    });
    await engine.pull(parsed);
    imageId = await engine.imageId(parsed.fullRef);
    if (!imageId) {
      send(response, 409, { error: "image-unavailable" });
      return;
    }
  }

  audit.write({
    action: "create",
    containerId: null,
    containerName: spec.name,
    actor,
    outcome: "allowed",
    reason: `${parsed.fullRef} (${imageId.slice(0, 19)}) -> ${location.projectDir}`
  });

  const outcome = await stackLocks.runExclusive(spec.name, () =>
    applyCompose(applyOps, {
      location,
      spec,
      imageRef: parsed.fullRef,
      basePath: composeBasePath,
      // null means: there must not be a file here yet.
      expectedHash: null
    })
  );

  if (!outcome.ok) {
    audit.write({
      action: "create-failed",
      containerId: null,
      containerName: spec.name,
      actor,
      outcome: "error",
      reason: `${outcome.reason} (rolled back: ${outcome.rolledBack})`
    });
    send(response, 409, {
      error: outcome.reason,
      rolledBack: outcome.rolledBack,
      projectDir: location.projectDir
    });
    return;
  }

  audit.write({
    action: "create-done",
    containerId: outcome.containerId,
    containerName: spec.name,
    actor,
    outcome: "allowed",
    reason: location.projectDir
  });
  // The NORMALIZED spec goes back — since 5c it is only the checked and stored
  // INPUT; the source of truth is the file, and the hash stands for that.
  send(response, 200, {
    ok: true,
    containerId: outcome.containerId,
    name: spec.name,
    imageId,
    projectDir: outcome.projectDir,
    serviceName: outcome.serviceName,
    composeHash: outcome.composeHash,
    // Named honestly: created does not mean running.
    running: outcome.running,
    restartLooping: outcome.restartLooping,
    spec: normalizeSpec(spec)
  });
  return;
}

export async function handleStackContext(ctx: RouteContext, stackContextMatch: RegExpMatchArray): Promise<void> {
  const { response, actor } = ctx;
  const anchorContainerId = decodeURIComponent(stackContextMatch[1]);
  try {
    const project = stackProjectFromRegistry(anchorContainerId);
    const prepared = await stackLocks.runExclusive(project.projectName, () => {
      if (!registry.isAllowed(anchorContainerId)) {
        throw new StackEndpointError(409, "stack-anchor-stale");
      }
      return prepareStack(project, {
        mutating: false,
        action: "stack-context",
        actor
      });
    });
    audit.write({
      action: "stack-context",
      containerId: anchorContainerId,
      containerName: project.anchorEntry.containerName,
      actor,
      outcome: "allowed",
      reason: project.projectName
    });
    send(response, 200, prepared.context);
  } catch (error) {
    if (!(error instanceof StackEndpointError)) throw error;
    audit.write({
      action: "stack-context",
      containerId: anchorContainerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: error.code
    });
    send(response, error.status, { error: error.code, ...error.details });
  }
  return;
}

export async function handleStackAction(ctx: RouteContext, stackActionMatch: RegExpMatchArray): Promise<void> {
  const { request, response, actor } = ctx;
  const anchorContainerId = decodeURIComponent(stackActionMatch[1]);
  const requestedAction = decodeURIComponent(stackActionMatch[2]);
  if (!isStackAction(requestedAction)) {
    send(response, 400, { error: "invalid-stack-action" });
    return;
  }
  const action: StackAction = requestedAction;
  // Invalid JSON is answered centrally (`400 invalid-json`), as everywhere.
  const parsedBody = parseRequest(stackActionRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: `stack-${action}`, containerId: anchorContainerId, containerName: null }, parsedBody.rejection);
    return;
  }
  const body = parsedBody.value;

  try {
    const project = stackProjectFromRegistry(anchorContainerId);
    const outcome = await stackLocks.runExclusive(project.projectName, async () => {
      if (!registry.isAllowed(anchorContainerId)) {
        throw new StackEndpointError(409, "stack-anchor-stale");
      }
      const gateAction = action === "apply" || action === "down" ? `stack-${action}` : action;
      const prepared = await prepareStack(project, {
        mutating: true,
        action: gateAction,
        actor
      });
      if (
        !prepared.context.services.every((service) => {
          const anchor = prepared.entriesByService.get(service.serviceName);
          const effectiveContainerId = service.containerId ?? anchor?.containerId ?? null;
          return Boolean(anchor) && anchor?.containerId === effectiveContainerId;
        }) ||
        !expectedStackMatches(body.expectedStack, {
          projectName: project.projectName,
          projectDir: project.projectDir,
          composeFileName: project.composeFileName,
          services: prepared.context.services.map((service) => ({
            serviceName: service.serviceName,
            containerId:
              service.containerId ?? prepared.entriesByService.get(service.serviceName)?.containerId ?? null
          }))
        })
      ) {
        // The expectation authorizes nothing and is never used as a path. It
        // merely binds the previously checked server view, under the same
        // project lock, to the immediately following CLI call.
        throw new StackEndpointError(409, "stack-expectation-mismatch");
      }
      const usedFallbackUp = action === "start" && prepared.context.missingServices.length > 0;

      const denied = stackActionDeny({
        action,
        missingServices: prepared.context.missingServices,
        projectName: project.projectName,
        confirmation: body.confirmation,
        allowFallbackUp: body.allowFallbackUp
      });
      if (denied) throw new StackEndpointError(denied.status, denied.code);
      if (action === "apply" || usedFallbackUp) {
        ensureCreateScopeAllowlisted(prepared);
        ensureCreateScopeNotExternallyManaged(prepared);
      }

      let composeFailed = false;
      try {
        if (action === "start" && !usedFallbackUp) {
          await composeStart(project);
        } else if (action === "start" || action === "apply") {
          // The only creating S11 path: no build, no pull, no removal of
          // orphans. Missing images make the action fail visibly instead of
          // fetching foreign code onto the host on the side.
          //
          // ⚠️ `forceRecreate` exists ONLY for `apply`, and only because
          // `up -d` alone does not heal a broken case: Compose only replaces
          // containers with a changed configuration or a changed image.
          // Whoever hangs on a just-replaced X via `network_mode:
          // container:<X>` is left behind — in a netns that no longer
          // exists, and Docker keeps reporting it as `running`. That is
          // exactly how `arr_stack` lost three containers on 2026-08-25; only
          // a manual `down`+`up` brought them back.
          //
          // The reach does NOT grow because of this: `apply` touches the
          // whole stack anyway and requires `compose.raw`. The
          // flag only changes whether Compose leaves unchanged containers
          // alone — and exactly that is the bug here, not the protection.
          await composeUp(project, {
            removeOrphans: false,
            pullNever: true,
            forceRecreate: action === "apply" && body.forceRecreate
          });
        } else if (action === "stop") {
          await composeStop(project);
        } else if (action === "restart") {
          if (stackNeedsDependencySafeRestart(prepared.definition.couplings)) {
            await composeDependencySafeRestart(project);
          } else {
            await composeRestart(project);
          }
        } else {
          // composeDown() sets neither --volumes nor --remove-orphans.
          await composeDown(project);
        }
      } catch (error) {
        composeFailed = true;
        // stderr can contain host paths and image refs and stays in the agent
        // log. Only the stable error code plus the already redacted current
        // context goes outside.
        console.error(`[agent] stack action ${action} for ${project.projectName} failed:`, error);
      }

      // Even a failed `up --wait` may already have recreated containers. That
      // is why ids are always updated before the error goes to the server.
      await reanchorStackRegistry(prepared);
      const after = await prepareStack(project, {
        mutating: false,
        action: "stack-context",
        actor
      });
      const containerIds = containerIdsOf(after.context);
      if (composeFailed) {
        throw new StackEndpointError(409, "compose-stack-action-failed", {
          action,
          containerIds,
          context: after.context
        });
      }
      return { usedFallbackUp, context: after.context, containerIds };
    });

    audit.write({
      action: `stack-${action}`,
      containerId: anchorContainerId,
      containerName: project.anchorEntry.containerName,
      actor,
      outcome: "allowed",
      reason: `${project.projectName}${outcome.usedFallbackUp ? " (start->up)" : ""}`
    });
    send(response, 200, {
      ok: true,
      action,
      usedFallbackUp: outcome.usedFallbackUp,
      containerIds: outcome.containerIds,
      context: outcome.context
    });
  } catch (error) {
    if (!(error instanceof StackEndpointError)) throw error;
    audit.write({
      action: `stack-${action}`,
      containerId: anchorContainerId,
      containerName: null,
      actor,
      outcome: error.code === "compose-stack-action-failed" ? "error" : "denied",
      reason: error.code
    });
    send(response, error.status, { error: error.code, ...error.details });
  }
  return;
}
