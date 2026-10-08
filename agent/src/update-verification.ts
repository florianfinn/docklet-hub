import { UPDATE_STABILITY_WINDOW_MS, type UpdateServicePreview } from "contract";
import type { RawInspect } from "./engine.js";
import { runtimeStateOf } from "./runtime-actions.js";
import { UpdateBudget, UpdateFailure } from "./update-budget.js";

export type VerificationClock = { now: () => number; sleep: (ms: number) => Promise<void> };
const clock: VerificationClock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
export function effectiveHealthcheck(raw: RawInspect): boolean {
  const test = raw.Config?.Healthcheck?.Test;
  return Boolean(test?.length && test[0] !== "NONE");
}
function actualStart(raw: RawInspect, requestedAt: number, now: number): number {
  const observed = Date.parse(raw.State?.StartedAt ?? "");
  return Number.isFinite(observed) && observed >= requestedAt && observed <= now ? observed : requestedAt;
}

export async function verifyUpdate(read: () => Promise<RawInspect>, preview: UpdateServicePreview, imageId: string,
  budget: UpdateBudget, startedAt: number, time: VerificationClock = clock): Promise<RawInspect> {
  let first: RawInspect | null = null;
  for (;;) {
    const raw = await budget.run(read); first ??= raw;
    if (raw.Image !== imageId) throw new UpdateFailure("update-state-mismatch");
    if (preview.acceptance === "created") {
      if (raw.State?.Running || !["created", "exited"].includes(raw.State?.Status ?? "")) throw new UpdateFailure("update-state-mismatch");
      return raw;
    }
    const elapsed = time.now() - actualStart(first, startedAt, time.now());
    if (preview.acceptance === "completion-job") {
      if (raw.State?.Status === "exited") {
        if (elapsed > preview.startDeadlineSeconds * 1000 || raw.State.ExitCode !== 0) throw new UpdateFailure("update-completion-failed");
        return raw;
      }
      if (elapsed >= preview.startDeadlineSeconds * 1000) throw new UpdateFailure("update-completion-failed");
    } else {
      if (!raw.State?.Running) throw new UpdateFailure("update-container-exited");
      if (raw.State.Restarting || (raw.RestartCount ?? 0) !== 0
        || raw.State.StartedAt !== first.State?.StartedAt) throw new UpdateFailure("update-container-restarted");
      if (effectiveHealthcheck(raw)) {
        if (elapsed <= preview.startDeadlineSeconds * 1000 && raw.State.Health?.Status === "healthy") return raw;
        if (elapsed >= preview.startDeadlineSeconds * 1000) throw new UpdateFailure("update-health-timeout");
      } else if (elapsed >= UPDATE_STABILITY_WINDOW_MS) return raw;
    }
    await budget.run(() => time.sleep(Math.min(1000, budget.remaining())));
  }
}
export function rollbackStateMatches(raw: RawInspect, previous: RawInspect): boolean {
  const status = runtimeStateOf(previous).status;
  if (raw.Image !== previous.Image) return false;
  if (status === "paused") return runtimeStateOf(raw).status === "paused";
  if (["running", "restarting"].includes(status ?? "")) return raw.State?.Running === true
    && (status === "restarting" || previous.State?.Health?.Status !== "healthy" || raw.State.Health?.Status === "healthy");
  return raw.State?.Running !== true && ["created", "exited"].includes(raw.State?.Status ?? "");
}

export async function verifyRollback(read: () => Promise<RawInspect>, snapshot: UpdateServicePreview, previous: RawInspect,
  budget: UpdateBudget, startedAt: number, time: VerificationClock = clock): Promise<RawInspect> {
  let first: RawInspect | null = null;
  for (;;) {
    const raw = await budget.run(read); first ??= raw;
    if (raw.Image !== previous.Image) throw new UpdateFailure("update-rollback-failed");
    if (rollbackStateMatches(raw, previous)) return raw;
    if (time.now() - actualStart(first, startedAt, time.now()) >= snapshot.startDeadlineSeconds * 1000) throw new UpdateFailure("update-rollback-failed");
    await budget.run(() => time.sleep(Math.min(1000, budget.remaining())));
  }
}
