// S12: Compose-native image update with health gate and digest rollback.
//
// The caller runs the whole operation under the project mutex:
//
//   compose up --wait -> check state
//     -> on failure: write override pointing to the previous image id
//     -> compose up --wait --force-recreate
//     -> remove override in any case
//
// The structured result matters in the failure case too. A successful rollback
// regularly produces a new container id; the main API must be able to carry it
// over together with grants, Compose pointer and notification state.

import type { RawInspect } from "./engine.js";
import type { ComposeProject, UpOptions } from "./compose-cli.js";

export type ComposeUpdateOps = {
  up(project: ComposeProject, options: UpOptions): Promise<string>;
  resolveContainerId(project: ComposeProject, serviceName: string): Promise<string | null>;
  inspect(containerId: string): Promise<RawInspect>;
  writeRollbackOverride(serviceName: string, previousImageId: string): void;
  removeRollbackOverride(): void;
};

export type ComposeUpdateInput = {
  project: ComposeProject;
  serviceName: string;
  originalContainerId: string;
  previousImageId: string;
  targetImageId: string;
};

export type ComposeUpdateOutcome = {
  ok: boolean;
  rolledBack: boolean;
  reason: string | null;
  updateReason: string | null;
  rollbackReason: string | null;
  cleanupFailed: boolean;
  finalContainerId: string;
  finalImageId: string;
  anchorResolved: boolean;
};

class ComposeUpdateStateError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ComposeUpdateStateError";
  }
}

type CurrentState = { containerId: string; inspect: RawInspect };

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof ComposeUpdateStateError ? error.reason : fallback;
}

function assertUsableState(state: CurrentState, expectedImageId: string): void {
  if (state.inspect.Image !== expectedImageId) {
    throw new ComposeUpdateStateError("update-image-mismatch");
  }
  if (state.inspect.State?.Running !== true || state.inspect.State.Restarting === true) {
    throw new ComposeUpdateStateError("container-not-running");
  }
  const health = state.inspect.State.Health?.Status;
  // After `compose up --wait`, "starting" is not a reliable success. Without a
  // healthcheck, on the other hand, there is deliberately no artificial HTTP
  // probe substitute.
  if (health && health !== "healthy") {
    throw new ComposeUpdateStateError("container-unhealthy");
  }
}

async function currentState(
  ops: ComposeUpdateOps,
  input: ComposeUpdateInput
): Promise<CurrentState> {
  const containerId = await ops.resolveContainerId(input.project, input.serviceName);
  if (!containerId) throw new ComposeUpdateStateError("container-not-resolvable");
  return { containerId, inspect: await ops.inspect(containerId) };
}

async function bestEffortCurrentState(
  ops: ComposeUpdateOps,
  input: ComposeUpdateInput
): Promise<CurrentState | null> {
  try {
    return await currentState(ops, input);
  } catch {
    return null;
  }
}

function upOptions(input: ComposeUpdateInput, rollback: boolean): UpOptions {
  return {
    removeOrphans: false,
    // The update endpoint is authorized per container. That is why even a
    // single-service project stays explicitly limited to this service; a
    // neighbouring definition added later or currently missing must not come
    // into being as a side effect.
    serviceName: input.serviceName,
    pullNever: true,
    noDeps: true,
    // For a single service, force-recreate is part of the S12 contract — in the
    // update as in the rollback.
    forceRecreate: true,
    rollbackOverride: rollback
  };
}

export async function updateComposeServiceWithRollback(
  ops: ComposeUpdateOps,
  input: ComposeUpdateInput
): Promise<ComposeUpdateOutcome> {
  try {
    await ops.up(input.project, upOptions(input, false));
    const state = await currentState(ops, input);
    assertUsableState(state, input.targetImageId);
    return {
      ok: true,
      rolledBack: false,
      reason: null,
      updateReason: null,
      rollbackReason: null,
      cleanupFailed: false,
      finalContainerId: state.containerId,
      finalImageId: input.targetImageId,
      anchorResolved: true
    };
  } catch (updateError) {
    const updateReason = reasonOf(updateError, "compose-update-failed");
    let rollbackState: CurrentState | null = null;
    let rollbackReason: string | null = null;
    let cleanupFailed = false;

    try {
      ops.writeRollbackOverride(input.serviceName, input.previousImageId);
      await ops.up(input.project, upOptions(input, true));
      rollbackState = await currentState(ops, input);
      assertUsableState(rollbackState, input.previousImageId);
    } catch (rollbackError) {
      rollbackReason = reasonOf(rollbackError, "compose-rollback-failed");
    } finally {
      try {
        ops.removeRollbackOverride();
      } catch {
        cleanupFailed = true;
      }
    }

    // Compose can still return an error after the mutation has completed.
    // That is why the actual state is looked at once more before the rollback
    // counts as failed. Only the old digest actually running counts.
    const finalState = rollbackState ?? (await bestEffortCurrentState(ops, input));
    let rolledBack = false;
    if (finalState) {
      try {
        assertUsableState(finalState, input.previousImageId);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }

    const reason = cleanupFailed
      ? "rollback-override-cleanup-failed"
      : rolledBack
        ? updateReason
        : "update-rollback-failed";

    return {
      ok: false,
      rolledBack,
      reason,
      updateReason,
      rollbackReason,
      cleanupFailed,
      finalContainerId: finalState?.containerId ?? input.originalContainerId,
      finalImageId: finalState?.inspect.Image ?? input.previousImageId,
      anchorResolved: finalState !== null
    };
  }
}
