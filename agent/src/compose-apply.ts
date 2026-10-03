// The choreography around `docker compose up` (stage 5c).
//
// It replaces the rollback choreography from 5a (recreate.ts: stop → rename
// old → create new → remove old). The reason for that cumbersomeness was that
// the old definition existed ONLY in memory: had it been deleted together with
// the old container, there would have been nothing left to restore the
// container from.
//
// With the file as the source of truth, that reason goes away. Rolling back now
// means: write back the previous version of the file and call `up` once more.
// That is not only shorter, it is also more robust — the old definition
// survives a crash of the agent in the middle of the operation.
//
// What does NOT go away is checking the result. On the contrary: now that a
// hand-editable file is in play, it matters more than before. What is checked
// is the RUNNING container, against the same hardening rules as the
// inventory — not the file. A file can claim anything.

import {
  emitComposeYaml,
  type ComposeLocation
} from "./compose.js";
import {
  ensureBindSources,
  ensureProjectDir,
  readComposeFile,
  restoreComposeFile,
  writeComposeFile
} from "./compose-store.js";
import type { ContainerSpec } from "./spec.js";

export type ApplyOps = {
  up(projectDir: string): Promise<string>;
  down(projectDir: string): Promise<string>;
  resolveContainerId(projectDir: string, serviceName: string): Promise<string | null>;
  // Hardening violations of the RUNNING container that stop this path:
  // delegation lock and warning, not the mere hints (S9,
  // `selfCheckViolations`). Empty array = all right.
  blockingViolations(containerId: string): Promise<string[]>;
  // Is the container really running, or is it restarting in a loop?
  runState(containerId: string): Promise<{ running: boolean; restarting: boolean; exitCode: number }>;
};

export type ApplyOutcome =
  | {
      ok: true;
      containerId: string;
      composeHash: string;
      projectDir: string;
      serviceName: string;
      // ⚠️ Not the same as "ok". The container is created and the definition
      // is in place — but it can still be restarting in a loop.
      //
      // Seen live 2026-07-21: a redis with `cap_drop: ALL` fails at the chown
      // of its data directory and restarts endlessly. `compose up --wait` saw
      // it running in the first moment and reported success.
      //
      // This is REPORTED and not rolled back: the definition is exactly what
      // the operator needs now to fix the error. Throwing it away because the
      // first start failed would be the worse help — unlike a failed `up`,
      // after which nothing usable at all would remain.
      running: boolean;
      restartLooping: boolean;
    }
  | {
      ok: false;
      reason: string;
      // Whether the previous state could be restored. A false here is the only
      // situation in which someone has to look by hand — and that is why it is
      // in the response and in the audit log instead of getting lost in a
      // generic "did not work".
      rolledBack: boolean;
      detail?: string;
    };

export type ApplyOptions = {
  location: ComposeLocation;
  spec: ContainerSpec;
  imageRef: string;
  basePath: string;
  // null = create (there must not be a file yet).
  // Hash = edit (the file must look exactly as when last read).
  expectedHash: string | null;
};

export async function applyCompose(ops: ApplyOps, options: ApplyOptions): Promise<ApplyOutcome> {
  const { location, basePath, expectedHash } = options;

  ensureProjectDir(location.projectDir, basePath);
  // Before the `up`, not after: otherwise the daemon has long since created the
  // source as root.
  ensureBindSources(
    options.spec.volumes.filter((volume) => volume.type === "bind").map((volume) => volume.source),
    basePath
  );

  const yaml = emitComposeYaml(options.spec, { imageRef: options.imageRef });
  // The write protection of compose-store kicks in here a second time. The
  // caller already checks the drift beforehand (checkDrift) so that the
  // refusal comes without side effects — but that is not relied upon: there is
  // time between check and write, and during that time someone can save via
  // SSH.
  const written = writeComposeFile(location.projectDir, yaml, { expectedHash, basePath });
  if (!written.ok) {
    // Nothing was touched, so there is nothing to roll back either.
    return { ok: false, reason: written.reason, rolledBack: true };
  }

  const previousContent = written.previousContent;

  const rollback = async (): Promise<boolean> => {
    try {
      restoreComposeFile(location.projectDir, previousContent);
      if (previousContent === null) {
        // On create there was nothing before. The half-created stack has to
        // go — a container that occupies the name and is not running is worse
        // than none.
        await ops.down(location.projectDir);
      } else {
        await ops.up(location.projectDir);
      }
      return true;
    } catch {
      return false;
    }
  };

  try {
    await ops.up(location.projectDir);
  } catch (error) {
    return {
      ok: false,
      reason: "compose-up-failed",
      rolledBack: await rollback(),
      detail: error instanceof Error ? error.message : undefined
    };
  }

  const containerId = await ops.resolveContainerId(location.projectDir, location.serviceName);
  if (!containerId) {
    return { ok: false, reason: "container-not-resolvable", rolledBack: await rollback() };
  }

  // Self-check on the result. The spec check before can only judge what was
  // written into the file; only here is it certain what actually became of
  // it.
  const blocking = await ops.blockingViolations(containerId);
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: `hardening-violated: ${blocking.join(",")}`,
      rolledBack: await rollback()
    };
  }

  const state = await ops.runState(containerId);

  return {
    ok: true,
    containerId,
    composeHash: written.hash,
    projectDir: location.projectDir,
    serviceName: location.serviceName,
    running: state.running && !state.restarting,
    restartLooping: state.restarting
  };
}

// The case "the file is not as the caller last saw it" is not an execution
// error but a statement about the state — and it must be answered BEFORE any
// intervention. That is why it stands here as its own function and not as a
// special case in applyCompose.
export type DriftCheck =
  | { ok: true; currentHash: string | null; currentContent: string | null }
  | { ok: false; reason: "file-changed-externally" | "file-already-exists" | "file-missing"; currentHash: string | null };

export function checkDrift(
  projectDir: string,
  expectedHash: string | null,
  // Adopted stacks bring their own file name (stage 5d); the default applies
  // to everything the dashboard wrote itself.
  composeFileName?: string
): DriftCheck {
  const state = readComposeFile(projectDir, composeFileName);
  if (expectedHash === null) {
    if (state.exists) return { ok: false, reason: "file-already-exists", currentHash: state.hash };
    return { ok: true, currentHash: null, currentContent: null };
  }
  if (!state.exists) return { ok: false, reason: "file-missing", currentHash: null };
  if (state.hash !== expectedHash) {
    return { ok: false, reason: "file-changed-externally", currentHash: state.hash };
  }
  return { ok: true, currentHash: state.hash, currentContent: state.content };
}
