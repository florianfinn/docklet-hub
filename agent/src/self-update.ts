// Self-update of the agent (#36): pull, verify the signature, swap the
// container, roll back on a failed start.
//
// ⚠️ THIS SEQUENCE DOES NOT RUN IN THE AGENT. It runs in the watcher — a
// second container from the same image that sits next to the agent. The reason
// is mechanical and not negotiable: during the swap the engine stops the agent
// container and with it every process inside. If the agent performed the swap
// itself, the operation would break off between `stop` and `create` — the most
// dangerous moment of the whole sequence, of all things without supervision.
//
// What the agent does is therefore exactly one thing: write a job file into
// the shared `/state`. It gets no new Docker privilege for that.
//
// The order below is the actual content: EVERYTHING that can reject comes
// BEFORE the swap. Pull, version label, signature and downgrade bolt run while
// the old agent keeps running unchanged — an abort there costs nothing but a
// log entry. Only once all four have passed is anything touched.

import type { RawInspect } from "./engine.js";
import { parseImageRef } from "./image-ref.js";
import { repoOfRef } from "./update.js";

// The job the agent leaves behind. It names the initial state, because the
// watcher can no longer ask for it later: after the swap the agent that placed
// the job is gone.
export type SelfUpdateJob = {
  jobId: string;
  requestedBy: string;
  requestedAt: string;
  agentContainerId: string;
  imageRef: string;
  runningVersion: string;
  runningImageId: string;
};

// `unchanged` is deliberately NOT an error and not a success either: the pull
// ran, the result was the same image, nothing was touched. That is the most
// common outcome when someone presses the button twice.
//
// `aborted` means: a preliminary check rejected, the agent kept running the
// whole time. `failed` means: something went wrong during or after the swap.
// Keeping the two apart is the difference between "nothing happened" and
// "someone has to look here".
//
// ⚠️ The five values have been English since v0.24.0 (#80). They are WRITTEN
// to disk and read back by the NEXT version — the status file by construction
// comes from the watcher before the update, the reader runs in the agent
// afterwards. A one-sided rename would have slipped through the former
// `outcome as SelfUpdateOutcome` without anything tripping: only at the place
// where someone compares. `readStatus` (self-update-state.ts) therefore maps
// the old wordings AND checks the result against this list instead of
// casting it.
export const SELF_UPDATE_OUTCOMES = [
  "ok",
  "unchanged",
  "aborted",
  "rolled-back",
  "failed"
] as const;

export type SelfUpdateOutcome = (typeof SELF_UPDATE_OUTCOMES)[number];

export type SelfUpdateStatus = {
  jobId: string;
  outcome: SelfUpdateOutcome;
  reason: string | null;
  fromVersion: string;
  toVersion: string | null;
  fromImageId: string;
  toImageId: string | null;
  digest: string | null;
  startedAt: string;
  finishedAt: string;
};

export type ImageFinding = {
  // From the label `org.opencontainers.image.version`.
  version: string | null;
  // The ref WITH digest ("…/agent@sha256:…"). cosign verifies a digest, never
  // a tag: a tag is movable and therefore says nothing about what was
  // signed.
  digestRef: string | null;
};

export type SelfUpdateOps = {
  pull(imageRef: string): Promise<void>;
  imageId(imageRef: string): Promise<string | null>;
  // Both together: the id names the image, the ref says under which
  // repository its digest is to be looked up (an image can be known under
  // several).
  imageFinding(imageId: string, imageRef: string): Promise<ImageFinding>;
  checkSignature(digestRef: string, version: string): Promise<{ ok: boolean; reason: string | null }>;
  inspect(containerId: string): Promise<RawInspect>;
  // Swaps the container to a new image and returns the new id. The
  // choreography behind it (stop, park the old one, create, start, remove the
  // old one) is the same as for the guided update of managed containers.
  swap(raw: RawInspect, imageRef: string, expectedImageId: string): Promise<string>;
  // Waits until the NEW agent has reported in. Not "is the container running"
  // but "has the process inside written its start into the state" — an agent
  // that aborts immediately because of an unwritable audit log is, after all,
  // still running as far as Docker is concerned (exactly the reason why the
  // Compose files carry a healthcheck).
  waitForStart(expectedVersion: string, sinceMs: number): Promise<{ ok: boolean; reason: string | null }>;
  logLine(line: string): void;
  now(): number;
};

const VERSIONS_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// The version label is the identity cosign verifies against
// (`…release.yml@refs/tags/vX.Y.Z`). If it is missing or unreadable, there is
// nothing to verify — then the run aborts and does NOT, say, run against an
// empty identity. The documented manual procedure has the same bolt.
export function versionFromLabel(label: string | null | undefined): string | null {
  if (typeof label !== "string") return null;
  const value = label.trim();
  return VERSIONS_PATTERN.test(value) ? value : null;
}

function partsVersion(value: string): { numbers: number[]; prerelease: string | null } | null {
  const match = VERSIONS_PATTERN.exec(value.startsWith("v") ? value : `v${value}`);
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null
  };
}

// Negative if a is older. `null` if either of the two is unreadable — then
// "older or newer" is not a finding but a guess, and the caller has to treat
// it as such.
//
// Pre-release versions (`v1.0.0-rc1`) count AS OLDER than the final release
// under semver. That is no formality here: the downgrade bolt below would
// otherwise let an rc through against the release.
export function compareVersions(a: string, b: string): number | null {
  const left = partsVersion(a);
  const right = partsVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

// The bolt that the README has known only as a paragraph since v0.11.0.
//
// Why it is needed at all: `:latest` says "the newest", but the signature
// only confirms AUTHENTICITY, not DIRECTION. An older, genuinely signed image
// would pass the check without complaint. Without this comparison an "Update"
// button that silently downgrades would be a possible outcome — and nobody
// would notice, because everything runs afterwards.
//
// Unreadable values do NOT count as a downgrade: the rejection for those
// already sits in versionFromLabel(), and rejecting twice would mean making
// the reason worse.
export function isRegression(runningVersion: string, newVersion: string): boolean {
  const comparison = compareVersions(newVersion, runningVersion);
  return comparison !== null && comparison < 0;
}

export type TargetRefResolution = { ok: true; imageRef: string } | { ok: false; reason: string };

// The target of a self-update: the own ref or the one the caller names.
//
// Up to v0.29.1 there was only the own ref. An agent running pinned to a
// digest (`…:v0.29.1@sha256:…`, which is how the hub sets up its arms) thus
// always pulled the same image and reported `unchanged` — the button had no
// effect there. Since v0.30.0 the hub therefore names the target itself.
//
// ⚠️ Only within the SAME repository. The watcher rejects a foreign one at
// pull time anyway (watcher.ts, `pull`), but only after the 202 — here the
// refusal comes immediately and with a reason. The actual bolts remain the
// ones in the watcher: version label, signature against the fixed configured
// identity, and the downgrade bolt. A named ref bypasses none of them.
export function resolveTargetRef(ownRef: string, requested: string | null | undefined): TargetRefResolution {
  if (requested === undefined || requested === null) return { ok: true, imageRef: ownRef };
  if (!parseImageRef(requested)) {
    return { ok: false, reason: "target-image-ref-unreadable" };
  }
  const imageRef = requested.trim();
  if (repoOfRef(imageRef) !== repoOfRef(ownRef)) {
    return { ok: false, reason: "target-foreign-repository" };
  }
  return { ok: true, imageRef };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function executeSelfUpdateFrom(
  ops: SelfUpdateOps,
  job: SelfUpdateJob
): Promise<SelfUpdateStatus> {
  const startMs = ops.now();
  const skeleton = {
    jobId: job.jobId,
    fromVersion: job.runningVersion,
    fromImageId: job.runningImageId,
    startedAt: iso(startMs)
  };
  const end = (
    outcome: SelfUpdateOutcome,
    reason: string | null,
    extra: Partial<SelfUpdateStatus> = {}
  ): SelfUpdateStatus => ({
    ...skeleton,
    toVersion: null,
    toImageId: null,
    digest: null,
    ...extra,
    outcome,
    reason: reason,
    finishedAt: iso(ops.now())
  });

  // --- 1. Pull ------------------------------------------------------------
  ops.logLine(`[self-update] ${job.jobId}: pulling ${job.imageRef}`);
  try {
    await ops.pull(job.imageRef);
  } catch (failure) {
    return end("failed", `pull: ${errorText(failure)}`);
  }

  const newImageId = await ops.imageId(job.imageRef);
  if (!newImageId) {
    return end("failed", "pull: image not found after pulling");
  }

  // The most common outcome of all. It comes BEFORE any further check,
  // because a swap to the same image can change nothing but the container
  // id — an outage with nothing in return.
  if (newImageId === job.runningImageId) {
    ops.logLine(`[self-update] ${job.jobId}: already on this image`);
    return end("unchanged", "already on this image", { toImageId: newImageId });
  }

  // --- 2. Version label ---------------------------------------------------
  const finding = await ops.imageFinding(newImageId, job.imageRef);
  const newVersion = versionFromLabel(finding.version);
  if (!newVersion) {
    return end("aborted", `version-label-unreadable: ${finding.version ?? "missing"}`, {
      toImageId: newImageId
    });
  }
  if (!finding.digestRef) {
    // Without a digest there is nothing a signature could refer to. The case
    // occurs with locally built images — and those are exactly what this
    // check does not want to let through.
    return end("aborted", "digest-undeterminable", {
      toImageId: newImageId,
      toVersion: newVersion
    });
  }

  // --- 3. Signature -------------------------------------------------------
  ops.logLine(`[self-update] ${job.jobId}: verifying signature for ${newVersion}`);
  const signature = await ops.checkSignature(finding.digestRef, newVersion);
  if (!signature.ok) {
    return end("aborted", `signature: ${signature.reason ?? "verification failed"}`, {
      toImageId: newImageId,
      toVersion: newVersion,
      digest: finding.digestRef
    });
  }

  // --- 4. Downgrade -------------------------------------------------------
  if (isRegression(job.runningVersion, newVersion)) {
    return end(
      "aborted",
      `downgrade: ${job.runningVersion} -> ${newVersion}`,
      { toImageId: newImageId, toVersion: newVersion, digest: finding.digestRef }
    );
  }

  const decided = {
    toImageId: newImageId,
    toVersion: newVersion,
    digest: finding.digestRef
  };

  // --- 5. Swap ------------------------------------------------------------
  // From here on things get touched. The state of the running container is
  // read and recorded BEFOREHAND: it is the template for the new container AND
  // the template for the way back.
  let template: RawInspect;
  try {
    template = await ops.inspect(job.agentContainerId);
  } catch (failure) {
    return end("failed", `inspect: ${errorText(failure)}`, decided);
  }
  const oldImageId = template.Image ?? job.runningImageId;

  ops.logLine(
    `[self-update] ${job.jobId}: swapping to ${newVersion} (${newImageId.slice(0, 19)})`
  );
  const swapStarted = ops.now();
  let newContainerId: string;
  try {
    newContainerId = await ops.swap(template, job.imageRef, newImageId);
  } catch (failure) {
    // The swap choreography cleans up after itself (remove the half-finished
    // new one, rename the old one back and start it). If it fails, the agent is
    // back where it was — hence `failed` and not `rolled-back`: no swap ever
    // happened.
    return end("failed", `swap: ${errorText(failure)}`, decided);
  }

  // --- 6. Health-Gate -----------------------------------------------------
  const started = await ops.waitForStart(newVersion, swapStarted);
  if (started.ok) {
    ops.logLine(`[self-update] ${job.jobId}: ${newVersion} running`);
    return end("ok", null, decided);
  }

  // --- 7. Way back --------------------------------------------------------
  // Deliberately to the old IMAGE ID and not to the ref: at exactly this
  // moment the ref points to the image that is failing to start.
  ops.logLine(
    `[self-update] ${job.jobId}: no start (${started.reason ?? "?"}) — rolling back`
  );
  const rollbackStatus = { ...decided, toVersion: job.runningVersion, toImageId: oldImageId };
  try {
    const broken = await ops.inspect(newContainerId);
    const backStarted = ops.now();
    await ops.swap(broken, oldImageId, oldImageId);
    const back = await ops.waitForStart(job.runningVersion, backStarted);
    if (!back.ok) {
      return end(
        "failed",
        `no start (${started.reason ?? "?"}), rollback not confirmed either (${
          back.reason ?? "?"
        })`,
        rollbackStatus
      );
    }
    return end("rolled-back", started.reason ?? "no start confirmed", rollbackStatus);
  } catch (failure) {
    return end(
      "failed",
      `no start (${started.reason ?? "?"}), rollback failed: ${errorText(failure)}`,
      rollbackStatus
    );
  }
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
