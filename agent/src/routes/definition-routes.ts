import { projectLockKey } from "../project-lock.js";
import { RuntimeBudget } from "../runtime-budget.js";
import { runContainerAction } from "../container-action.js";
import { actionConnection } from "../runtime/action-connection.js";
import { applySpecRequestSchema, containerActionRequestSchema, type RuntimeAction, ACTION_QUEUE_WAIT_MS } from "contract";
import {
  EngineError
} from "../engine.js";
import { parseImageRef } from "../image-ref.js";
import {
  composeContextOf,
  locationFor
} from "../compose.js";
import {
  composeDown,
  composePs,
  composeRm,
  type NamedComposeProject
} from "../compose-cli.js";
import { applyCompose, checkDrift } from "../compose-apply.js";
import {
  readComposeFile
} from "../compose-store.js";
import {
  normalizeSpec,
  specViolatesHardening,
  checkSpec
} from "../spec.js";
import { config, engine, registry, audit, stackLocks } from "../runtime/state.js";
import { composeBasePath } from "../runtime/containers.js";
import { applyOps } from "../runtime/raw-ops.js";
import { send, readJsonBody, parseRequest, rejectRequest, ContainerRouteContext } from "../runtime/http.js";
import { gate } from "../runtime/gate.js";

// --- Structured editing (stage 5b, via Compose since 5c) --------------
//
// Since 5c, editing means: rewrite the Compose file and call
// `docker compose up`. The difference to 5b is not cosmetic — there the
// Compose file next to it stayed unchanged, which is why 5b honestly had to
// refuse editing Compose-managed containers. Now the file IS what gets
// edited, and the restriction goes away.
//
// The image ref deliberately does NOT come from the spec but from the agent's
// allowlist. Which image may run is a statement of the registry (stage plan
// 3.6) — otherwise "change ports" would be a way to swap the image on the
// side.
export async function handleApplySpec(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, actor, containerId, action } = ctx;
  // A missing hash is refused here already (`compose-hash-missing`): there is
  // no "don't care" value, see the drift check further down.
  const parsedBody = parseRequest(applySpecRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "apply-spec", containerId, containerName: null }, parsedBody.rejection);
    return;
  }
  const body = parsedBody.value;
  const result = await gate(containerId, { mutating: true, action, actor });
  const containerName = result.ok ? (result.inspect.Name ?? "").replace(/^\//, "") : null;
  if (!result.ok) {
    audit.write({
      action: "apply-spec",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }

  // ⚠️ Adopted files are never written (stage 5d) — and the agent checks that
  // here ITSELF, from its own copy of the allowlist.
  //
  // The main API already refuses the same case. But that is exactly what the
  // agent is not supposed to rely on: it is the last authority. Without these
  // lines, a bug in the server guard would have been enough for an adopted
  // stack whose file happens to be called `compose.yaml` and whose service,
  // container and directory names match up to pass the directory check further
  // down — and for applyCompose to overwrite the operator's file.
  const ownEntry = registry.get(containerId);
  if (ownEntry?.compose?.origin === "adopted") {
    audit.write({
      action: "apply-spec",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "adopted-not-writable"
    });
    send(response, 409, { error: "adopted-not-writable" });
    return;
  }

  // Stage 5e: when editing, the "secured" class comes from the agent's OWN
  // registry copy (ownEntry), never from the request — otherwise a caller
  // could lower it from "secured" to "normal" with every edit and thus get
  // back the neighbour mount the class excludes (security review 5c, finding
  // 4). Because the name is immutable (check right below), the universe is the
  // same as at creation.
  const secured = ownEntry?.secured === true;
  const checked = checkSpec(body.spec, { bindBasePath: config.bindBasePath, secured });
  if (!checked.ok) {
    send(response, 400, { error: "invalid-spec", errors: checked.errors });
    return;
  }
  const spec = checked.spec;
  if (spec.name !== containerName) {
    // Renaming is not editing: the name is the key that allowlist, grants,
    // audit log — and since 5c also the directory — hang off.
    send(response, 400, { error: "name-immutable", expected: containerName });
    return;
  }

  const blocking = specViolatesHardening(spec, config.bindBasePath, secured);
  if (blocking.length > 0) {
    send(response, 403, { error: `hardening-violated: ${blocking.join(",")}` });
    return;
  }

  // The directory is read off the container, not accepted from the caller.
  const context = composeContextOf(result.inspect.Config?.Labels ?? undefined, composeBasePath);
  if (!context) {
    send(response, 409, { error: "no-compose-directory-in-base-path" });
    return;
  }
  const location = locationFor(spec.name, composeBasePath);
  if (!location || location.projectDir !== context.projectDir) {
    // The container lives somewhere other than its name suggests. That is not
    // a case to bend into shape: then it is not certain which file is meant.
    send(response, 409, {
      error: "directory-does-not-match-name",
      projectDir: context.projectDir
    });
    return;
  }

  // The latch against blind overwriting (open point 4 from 6.2). The caller
  // has to send along the hash it last read; if someone saved alongside via
  // SSH, the request is refused instead of overwriting. If the hash is
  // missing, the schema has refused it already — there is no "don't care"
  // value.
  const expectedHash = body.expectedComposeHash;
  const drift = checkDrift(context.projectDir, expectedHash);
  if (!drift.ok) {
    audit.write({
      action: "apply-spec",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: drift.reason
    });
    send(response, 409, {
      error: drift.reason,
      projectDir: context.projectDir,
      actualComposeHash: drift.currentHash
    });
    return;
  }

  const expected = registry.expectedImageRef(containerId);
  const parsed = expected ? parseImageRef(expected) : null;
  if (!parsed) {
    send(response, 409, { error: expected ? "image-ref-unreadable" : "no-image-ref" });
    return;
  }
  const targetImageId = await engine.imageId(parsed.fullRef);
  if (!targetImageId) {
    // The generated file carries `pull_policy: never`; without a local image
    // the `up` would run into an error. Pull first, then edit.
    send(response, 409, { error: "image-not-local" });
    return;
  }

  audit.write({
    action: "apply-spec",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason: `${parsed.fullRef} (${targetImageId.slice(0, 19)}) in ${context.projectDir}`
  });

  const lockedOutcome = await stackLocks.runExclusive(projectLockKey({ registryProject: registry.get(containerId)?.compose?.projectName, projectName: context.project, containerId }), async () => {
    // Gate/inspect happened before waiting for the project lock. If an
    // immediately preceding stack action moved the id anchor, this request
    // must not continue with the old grant.
    const fresh = await gate(containerId, { mutating: true, action: "apply-spec", actor });
    if (!fresh.ok) return { stale: true as const };
    const currentContext = composeContextOf(fresh.inspect.Config?.Labels ?? undefined, composeBasePath);
    if (!currentContext || currentContext.project !== context.project || currentContext.projectDir !== context.projectDir) return { stale: true as const };
    const outcome = await applyCompose(applyOps, {
      location,
      spec,
      imageRef: parsed.fullRef,
      basePath: composeBasePath,
      expectedHash
    });
    if (outcome.ok) registry.replaceContainerId(containerId, outcome.containerId);
    return { stale: false as const, outcome };
  }, { waitMs: ACTION_QUEUE_WAIT_MS });
  if (lockedOutcome.stale) {
    audit.write({
      action: "apply-spec",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "stack-anchor-stale"
    });
    send(response, 409, { error: "stack-anchor-stale" });
    return;
  }
  const outcome = lockedOutcome.outcome;

  if (!outcome.ok) {
    audit.write({
      action: "apply-spec-failed",
      containerId,
      containerName,
      actor,
      outcome: "error",
      reason: `${outcome.reason} (rolled back: ${outcome.rolledBack})`
    });
    send(response, 409, {
      error: outcome.reason,
      rolledBack: outcome.rolledBack,
      projectDir: context.projectDir
    });
    return;
  }

  audit.write({
    action: "apply-spec-done",
    containerId: outcome.containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason: `alt ${containerId.slice(0, 12)} -> neu ${outcome.containerId.slice(0, 12)}`
  });
  send(response, 200, {
    ok: true,
    newContainerId: outcome.containerId,
    imageRef: parsed.fullRef,
    imageId: targetImageId,
    composeManaged: true,
    projectDir: outcome.projectDir,
    serviceName: outcome.serviceName,
    composeHash: outcome.composeHash,
    running: outcome.running,
    restartLooping: outcome.restartLooping,
    spec: normalizeSpec(spec)
  });
  return;
}

// --- Remove (destructive) ---------------------------------------------
export async function handleRemove(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId, action } = ctx;
  const result = await gate(containerId, { mutating: true, action, actor });
  const containerName = result.ok ? (result.inspect.Name ?? "").replace(/^\//, "") : null;
  if (!result.ok) {
    audit.write({
      action: "remove",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }

  // Since 5c: if the container lives in a Compose directory below the base
  // path, the stack is shut down instead of removing the container on its own.
  // Otherwise the file would remain and the next `up` — by hand or from the
  // dashboard — brought it back without a word.
  const context = composeContextOf(result.inspect.Config?.Labels ?? undefined, composeBasePath);
  const viaCompose = Boolean(
    context && readComposeFile(context.projectDir, context.composeFileName).exists
  );

  // ⚠️ How many services live in this directory?
  //
  // Until 5c the answer was always "one", and `down` was therefore synonymous
  // with "remove this container". With adopted stacks that no longer holds:
  // `down` shuts down the whole PROJECT. A remove of homepage would have
  // cleared away homepage_code-server along with it — a container the caller
  // never named and for which it possibly has no permission at all.
  const removeProject: NamedComposeProject | null = viaCompose && context
    ? {
        projectDir: context.projectDir,
        composeFileName: context.composeFileName,
        projectName: context.project
      }
    : null;

  audit.write({
    action: "remove",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason: `${result.inspect.Config?.Image ?? ""}${viaCompose ? ` (compose down in ${context!.projectDir})` : ""}`
  });

  const performRemove = async (): Promise<boolean> => {
    if (!registry.isAllowed(containerId)) return false;
    const stackServices = removeProject ? await composePs(removeProject) : [];
    const aloneInStack = stackServices.length <= 1;
  if (removeProject && aloneInStack) {
    // `down` without --volumes: the data survives. The DIRECTORY stays as
    // well — with the Compose file and data in it. That is exactly the point
    // of the direction decision: what gets deleted is the running container,
    // not the backup-capable artefact. Whoever really wants to delete the
    // directory does so deliberately and by hand.
    await composeDown(removeProject);
  } else if (removeProject) {
    // Several services in the stack: remove only this one, the neighbours
    // keep running.
    //
    // The service stays declared in the file — the next `up`, by hand or from
    // the dashboard, brought it back. That is the honest consequence of
    // adopted files not being written by the dashboard (stage 5d): getting rid
    // of the service permanently means editing the file, and that is stage 7.
    await composeRm(removeProject, context!.serviceName);
  } else {
    // Stop first, then remove. `force` would kill a running container hard —
    // for databases that is the difference between a clean shutdown and a
    // recovery.
    try {
      await engine.stop(containerId);
    } catch (error) {
      // Already stopped is not an error.
      if (!(error instanceof EngineError) || error.status !== 304) throw error;
    }
    await engine.remove(containerId);
  }
    return true;
  };
  const removed = removeProject
    ? await stackLocks.runExclusive(projectLockKey({ registryProject: registry.get(containerId)?.compose?.projectName, projectName: removeProject.projectName, containerId }), performRemove)
    : await performRemove();
  if (!removed) {
    audit.write({
      action: "remove",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "stack-anchor-stale"
    });
    send(response, 409, { error: "stack-anchor-stale" });
    return;
  }

  // The entry now points into the void. It deliberately stays (the allowlist
  // is a decision, not a mirror of state), but the caller learns about it.
  send(response, 200, {
    ok: true,
    registryEntryStale: registry.isAllowed(containerId),
    viaCompose,
    ...(viaCompose ? { projectDir: context!.projectDir } : {})
  });
  return;
}

export async function handleSafeAction(ctx: ContainerRouteContext): Promise<void> {
  const budget = new RuntimeBudget();
  const { request, response, actor, containerId, action } = ctx;
  const parsed = parseRequest(containerActionRequestSchema, await readJsonBody(request));
  if (!parsed.ok) {
    rejectRequest(ctx, { action, containerId, containerName: null }, parsed.rejection);
    return;
  }
  const connection = actionConnection(request, response);
  try {
    const result = await runContainerAction(containerId, action as RuntimeAction, parsed.value.expectedContainer, actor, connection.signal, undefined, budget);
    if (!response.destroyed) send(response, result.status, result.body);
  } finally {
    connection.dispose();
  }
}
