import { projectLockKey } from "../project-lock.js";
import { recreateRequestSchema } from "contract";
import { actionFailureOf } from "../action-failure.js";
import { parseImageRef } from "../image-ref.js";
import { recreateContainer } from "../recreate.js";
import {
  composeContextFindingOf
} from "../compose.js";
import {
  composeDown,
  composePs,
  composeRm,
  composeUp,
  type ComposeProject
} from "../compose-cli.js";
import { checkDrift } from "../compose-apply.js";
import {
  removeUpdateRollbackOverride,
  writeUpdateRollbackOverride
} from "../compose-store.js";
import { updateComposeServiceWithRollback } from "../compose-update.js";
import { engine, registry, audit, stackLocks } from "../runtime/state.js";
import {
  composeBasePath,
  composeContextFor,
  violationKey,
  resolveFullContainerId
} from "../runtime/containers.js";
import { send, readJsonBody, parseRequest, rejectRequest, ContainerRouteContext } from "../runtime/http.js";
import { gate } from "../runtime/gate.js";

// --- Recreate (destructive) -----------------------------------------------
// remove + create. If the create fails, the container is gone — which is why
// the old one is not deleted but renamed, and only removed once the new one
// is running. Every failure rolls back.
export async function handleRecreate(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, actor, containerId, action } = ctx;
  const parsedBody = parseRequest(recreateRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "recreate", containerId, containerName: null }, parsedBody.rejection);
    return;
  }
  const body = parsedBody.value;
  const result = await gate(containerId, { mutating: true, action, actor });
  const containerName = result.ok ? (result.inspect.Name ?? "").replace(/^\//, "") : null;
  if (!result.ok) {
    audit.write({
      action: "recreate",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
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
    // Without the image present locally, create would pull — and do so
    // unchecked. Pull first, then confirm, then recreate.
    audit.write({
      action: "recreate",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "image-not-local"
    });
    send(response, 409, { error: "image-not-local" });
    return;
  }

  // TOCTOU latch: what was confirmed is a concrete image id. If anything
  // changed between preview and execution, the request is rejected — the new
  // one is not silently taken.
  const acknowledged = body.acknowledgeImageId;
  if (acknowledged !== targetImageId) {
    audit.write({
      action: "recreate",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "image-confirmation-mismatch"
    });
    send(response, 409, {
      error: "image-confirmation-mismatch",
      targetImageId
    });
    return;
  }

  // Stage 5c: if the container lives in a compose directory below the base
  // path, it is recreated via `docker compose up` instead of via the engine
  // choreography from 5a.
  //
  // This is not a matter of taste. An engine recreate produces a container
  // that compose no longer recognises as its own (the config-hash label no
  // longer matches) — the next `up`, by hand or from the dashboard, would
  // silently replace it once more. Exactly this kind of "works, disappears
  // later" is what the stage is meant to eliminate.
  //
  // ⚠️ BUT: `up` executes what IS IN the file — not what the dashboard once
  // wrote into it. Without reference to a known state, recreate would
  // therefore be a way to execute a smuggled-in definition (security review
  // 5c, 2026-07-21: a container with access to its own project directory
  // could make itself privileged that way).
  //
  // The compose path therefore ONLY applies with a matching hash sent along.
  // If it is missing — say for an existing container that the dashboard does
  // not manage and for which there is no known state —, the choreography from
  // 5a still runs, based on the definition of the RUNNING container. That is
  // independent of the file and therefore unaffected by it.
  const composeFinding = composeContextFindingOf(result.inspect.Config?.Labels ?? undefined, composeBasePath);
  const composeContext = composeContextFor(
    containerName ?? "",
    result.inspect.Config?.Labels ?? undefined
  );
  const expectedHash = body.expectedComposeHash;
  let composeDir: string | null = null;
  let composeProject: ComposeProject | null = null;
  if (composeContext && expectedHash) {
    const drift = checkDrift(
      composeContext.projectDir,
      expectedHash,
      composeContext.composeFileName
    );
    if (!drift.ok) {
      audit.write({
        action: "recreate",
        containerId,
        containerName,
        actor,
        outcome: "denied",
        reason: drift.reason
      });
      send(response, 409, {
        error: drift.reason,
        projectDir: composeContext.projectDir,
        actualComposeHash: drift.currentHash
      });
      return;
    }
    composeDir = composeContext.projectDir;
    composeProject = {
      projectDir: composeContext.projectDir,
      composeFileName: composeContext.composeFileName,
      projectName: composeContext.project
    };
  }

  // For the guided update, S12 deliberately no longer has a silent fallback
  // to the engine reconstruction: without an unambiguously established
  // compose file, neither would the file be the place of truth nor would the
  // digest rollback be possible. The manual recreate path keeps its
  // historical fallback; only the flagged update call refuses.
  //
  // ⚠️ #468: The reason is NAMED and logged. Previously a blanket
  // "update-compose-erforderlich" went out here — the same name the main
  // API's pre-check uses. The audit log thus had nothing at all on the agent
  // side and, on the server side, a sentence that sent the search to the
  // wrong place.
  if (body.rollbackOnUnhealthy && (!composeDir || !composeProject || !composeContext)) {
    // The context is right, but the main API did not send a state: then
    // it is the point of comparison that is missing, not the anchor.
    const reason = composeContext || composeFinding.ok ? "compose-hash-missing" : composeFinding.reason;
    const projectDir = composeContext?.projectDir ?? (composeFinding.ok
      ? composeFinding.context.projectDir : composeFinding.projectDir);
    audit.write({
      action: "recreate",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: reason
    });
    send(response, 409, {
      error: reason,
      // Both paths belong in the response: "outside the base path"
      // cannot be verified without the two values, and that was exactly the
      // live case.
      projectDir,
      composeBasePath
    });
    return;
  }

  audit.write({
    action: "recreate",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason: `${expected} -> ${targetImageId.slice(0, 19)}${composeDir ? ` (compose up in ${composeDir})` : ""}`
  });

  // ⚠️ #48: BOTH routes of this endpoint go through this handler. Without
  // it, every throw from the engine or compose falls into the global handler
  // and becomes `500 {"error":"internal-error"}` — the response that on
  // 2026-09-01 led four containers to be considered broken, even though the
  // choreography had cleanly rolled them back (and healed them in the
  // process). The safe actions have had the same handler since v0.13.0; the
  // recreate path was not brought along at the time.
  const recreateFailed = (error: unknown): void => {
    const failure = actionFailureOf(error);
    // Not a known failure but a programming error: that belongs further
    // up and stays a 500.
    if (!failure) throw error;
    audit.write({
      action: "recreate-done",
      containerId,
      containerName,
      actor,
      outcome: "error",
      reason: failure.auditReason
    });
    send(response, failure.status, failure.body);
  };

  if (composeDir && composeProject && composeContext) {
    await stackLocks.runExclusive(projectLockKey({ registryProject: registry.get(containerId)?.compose?.projectName, projectName: composeContext.project }), async () => {
    if (!registry.isAllowed(containerId)) {
      audit.write({
        action: "recreate",
        containerId,
        containerName,
        actor,
        outcome: "denied",
        reason: "stack-anchor-stale"
      });
      send(response, 409, { error: "stack-anchor-stale" });
      return;
    }
    const lockedDrift = checkDrift(
      composeContext.projectDir,
      expectedHash,
      composeContext.composeFileName
    );
    if (!lockedDrift.ok) {
      audit.write({
        action: "recreate",
        containerId,
        containerName,
        actor,
        outcome: "denied",
        reason: lockedDrift.reason
      });
      send(response, 409, {
        error: lockedDrift.reason,
        projectDir: composeContext.projectDir,
        actualComposeHash: lockedDrift.currentHash
      });
      return;
    }
    // ⚠️ Restrict to the named service as soon as there is more than one in
    // the directory (security review 5d).
    //
    // Authorisation is per container — `gate()` above checked exactly ONE
    // container. An `up` without a service argument, on the other hand, acts
    // on the whole file: a recreate on `homepage` would have started
    // `homepage_code-server` along with it, even though the caller never named
    // it, it does not have to be allowlisted and the hardening check below
    // only looks at the resolved target container.
    //
    // Up to 5c this coincided (one service per directory). The remove path
    // already has the same latch (composeRm); it was missing here.
    let newId: string;
    // The update path is always service-scoped. The historical manual
    // recreate may still treat the whole project in a genuine single-service
    // project; only there is the value cleared below.
    let onlyThisService: string | undefined = composeContext.serviceName;
    const rollbackOnUnhealthy = body.rollbackOnUnhealthy;
    if (rollbackOnUnhealthy) {
      const previousImageId = result.inspect.Image ?? "";
      if (!/^sha256:[a-f0-9]{64}$/i.test(previousImageId)) {
        send(response, 409, { error: "rollback-image-missing", projectDir: composeDir });
        return;
      }

      // S12: update and any rollback stay under the same project mutex.
      // The structured failure result is intentional: even a successful
      // rollback can produce a new container id, which agent and main API
      // have to follow atomically.
      const updateOutcome = await updateComposeServiceWithRollback(
        {
          up: composeUp,
          resolveContainerId: resolveFullContainerId,
          inspect: (id) => engine.inspect(id),
          writeRollbackOverride: (serviceName, imageId) => {
            writeUpdateRollbackOverride(composeDir, serviceName, imageId, composeBasePath);
          },
          removeRollbackOverride: () => {
            removeUpdateRollbackOverride(composeDir, composeBasePath);
          }
        },
        {
          project: composeProject,
          serviceName: composeContext.serviceName,
          originalContainerId: containerId,
          previousImageId,
          targetImageId
        }
      );
      newId = updateOutcome.finalContainerId;

      if (updateOutcome.anchorResolved && newId !== containerId) {
        registry.replaceContainerId(containerId, newId);
      }
      if (!updateOutcome.ok) {
        const warning = updateOutcome.cleanupFailed && updateOutcome.rolledBack
          ? "The previous image was restored, but the temporary override file could not be removed. Check by hand before the next compose action."
          : updateOutcome.cleanupFailed
            ? "Update and rollback both failed; in addition, the temporary override file could not be removed. Check the stack by hand immediately."
          : updateOutcome.rolledBack
            ? "The new image did not become healthy. The previous image is running again."
            : "Update and automatic rollback both failed. Check the stack by hand immediately.";
        audit.write({
          action: "recreate-done",
          containerId: newId,
          containerName,
          actor,
          outcome: "error",
          reason: `${updateOutcome.reason ?? "compose-update-failed"} (rolledBack: ${updateOutcome.rolledBack})`
        });
        send(response, 200, {
          ok: false,
          newContainerId: newId,
          imageRef: parsed.fullRef,
          imageId: updateOutcome.finalImageId,
          composeManaged: true,
          projectDir: composeDir,
          rolledBack: updateOutcome.rolledBack,
          reason: updateOutcome.reason ?? "compose-update-failed",
          updateReason: updateOutcome.updateReason,
          rollbackReason: updateOutcome.rollbackReason,
          cleanupFailed: updateOutcome.cleanupFailed,
          anchorResolved: updateOutcome.anchorResolved,
          warning
        });
        return;
      }
    } else {
      const inStack = await composePs(composeProject);
      onlyThisService = inStack.length > 1 ? composeContext.serviceName : undefined;
      // removeOrphans: false — the hash above confirmed that the file is
      // unchanged, so this `up` cannot create an orphan at all. And for an
      // adopted stack the flag would remove services the dashboard does not
      // know.
      await composeUp(composeProject, {
        removeOrphans: false,
        serviceName: onlyThisService,
        pullNever: true,
        noDeps: Boolean(onlyThisService),
        // Otherwise `up` leaves an unchanged container standing.
        // `recreate` has to deliver a new id even with the same image.
        forceRecreate: true
      });
      const resolved = await resolveFullContainerId(composeProject, composeContext.serviceName);
      if (!resolved) {
        send(response, 409, { error: "container-not-resolvable", projectDir: composeDir });
        return;
      }
      newId = resolved;
    }
    // ⚠️ BEFORE/AFTER instead of absolute (S9, §21.5 point 3).
    //
    // Up to here the question was "does the new container violate blocking
    // rules?" — and for dozzle, homepage and upsnap the answer was always
    // yes. A guided update on one of these containers would have removed the
    // freshly created one right away. Exactly this mechanism triggered the
    // #176 bug.
    //
    // The right question is the one the raw editor asks as well: does THIS
    // update introduce something new? The comparison runs on the normalised
    // host path, so that the same docker.sock does not count as new just
    // because `compose up` writes it differently.
    //
    // The before state comes from `result.inspect` — the container that was
    // running before the `up`.
    const before = new Set(await violationKey(result.inspect, containerId));
    const after = await violationKey(await engine.inspect(newId), newId);
    const newlyAdded = after.filter((keys) => !before.has(keys));
    if (newlyAdded.length > 0) {
      // At this point the container is already running — and through this
      // update it has gained a property it did not have before. LETTING it
      // run and only reporting 409 would be the most dangerous of all
      // variants: the action counts as rejected, but the state has been
      // established anyway.
      //
      // So take it down — but with the same restriction as above: `down`
      // shuts down the whole project and, for an adopted stack, takes along
      // the neighbours that have nothing to do with this finding. `rm --stop`
      // only hits the one service.
      //
      // Directory and data stay in place in both cases.
      //
      // With the hash check above this case should no longer be able to
      // occur. That is exactly why it is here: if it does, an assumption is
      // wrong, and then nothing is left running.
      let cleanedUp = true;
      try {
        if (onlyThisService) await composeRm(composeProject, onlyThisService);
        else await composeDown(composeProject);
      } catch {
        cleanedUp = false;
      }
      audit.write({
        action: "recreate-done",
        containerId: newId,
        containerName,
        actor,
        outcome: "error",
        reason: `hardening-newly-violated: ${newlyAdded.join(",")} (cleaned up: ${cleanedUp})`
      });
      send(response, 409, {
        // The same shape as in the raw editor (raw-apply.ts): the reason is
        // machine-readable, the keys are in their own field. Appending them
        // to the reason string would run into the main API's translation
        // (parseHardeningDenial) and produce "unknown hardening rule"
        // there — the keys carry the host path.
        error: "hardening-newly-violated",
        newViolations: newlyAdded,
        cleanedUp,
        ...(cleanedUp
          ? {}
          : {
              warning:
                "The newly created container gained a hardening property and " +
                "could NOT be cleaned up. It is running. Check by hand."
            })
      });
      return;
    }

    registry.replaceContainerId(containerId, newId);
    audit.write({
      action: "recreate-done",
      containerId: newId,
      containerName,
      actor,
      outcome: "allowed",
      reason: `alt ${containerId.slice(0, 12)} -> neu ${newId.slice(0, 12)} (compose)`
    });
    send(response, 200, {
      ok: true,
      newContainerId: newId,
      imageRef: parsed.fullRef,
      imageId: targetImageId,
      composeManaged: true,
      projectDir: composeDir
    });
    }).catch(recreateFailed);
    return;
  }

  // Existing containers without their own directory (Dockge, up to stage
  // 5d): still the choreography from 5a.
  const engineRecreate = async (): Promise<void> => {
    if (composeContext && !registry.isAllowed(containerId)) {
      send(response, 409, { error: "stack-anchor-stale" });
      return;
    }
    const recreated = await recreateContainer(engine, result.inspect, {
      imageRef: parsed.fullRef,
      expectedImageId: targetImageId
    });

    // The allowlist points to a container id, and that is now a
    // different one. Without this step the container would have vanished
    // from management after its own recreate.
    registry.replaceContainerId(containerId, recreated.newContainerId);

    audit.write({
      action: "recreate-done",
      containerId: recreated.newContainerId,
      containerName,
      actor,
      outcome: "allowed",
      reason: `alt ${containerId.slice(0, 12)} -> neu ${recreated.newContainerId.slice(0, 12)}`
    });
    send(response, 200, { ok: true, ...recreated });
  };
  // Stable names keep standalone recreates inside the update mutation boundary.
  const lockKey = projectLockKey({ registryProject: registry.get(containerId)?.compose?.projectName, projectName: composeContext?.project, containerName });
  await stackLocks.runExclusive(lockKey, engineRecreate).catch(recreateFailed);
  return;
}
