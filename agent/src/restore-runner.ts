import { randomUUID } from "node:crypto";
import { MUTATION_QUEUE_POLICY, UPDATE_PREVIEW_TIMEOUT_MS, UPDATE_MUTATION_RESERVE_MS, restorePhaseTimeoutMs,
  backupErrorSchema, restoreProgressSchema, type RestorePreviewRequest, type RestorePreviewResponse,
  type RestoreStartRequest, type RestoreResult, type RestoreProgress, type RestorePhase, type BackupError } from "contract";
import { AgentJobs } from "./agent-jobs.js";
import { KeyedMutex } from "./concurrency.js";
import { projectLockKey } from "./project-lock.js";
import { UpdateBudget, UpdateFailure } from "./update-budget.js";
import type { RawInspect } from "./engine.js";
import { runtimeStateOf } from "./runtime-actions.js";

export type RestoreSnapshot = { raw: RawInspect; preview: RestorePreviewResponse; data: unknown };
export type RestoreOps = {
  prepare(request: RestorePreviewRequest, actor: string | null, budget: UpdateBudget): Promise<RestoreSnapshot>;
  validate(snapshot: RestoreSnapshot, budget: UpdateBudget): Promise<void>;
  stop(snapshot: RestoreSnapshot, budget: UpdateBudget): Promise<void>;
  extract(snapshot: RestoreSnapshot, budget: UpdateBudget): Promise<void>;
  resume(snapshot: RestoreSnapshot, budget: UpdateBudget): Promise<RawInspect>;
  read(snapshot: RestoreSnapshot, budget: UpdateBudget): Promise<RawInspect>;
  intentional(snapshot: RestoreSnapshot): () => void;
  finished(result: RestoreResult, actor: string | null): void;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function failure(error: unknown, fallback: BackupError): BackupError {
  if (error instanceof UpdateFailure && error.code === "update-phase-deadline-exceeded") return "restore-deadline-exceeded";
  const parsed = backupErrorSchema.safeParse(error instanceof UpdateFailure ? error.code : error instanceof Error ? error.message : null);
  return parsed.success ? parsed.data : fallback;
}
export function restoreResultConsistent(result: RestoreResult): boolean {
  const failed = result.restoreError !== null || result.resumeError !== null;
  return result.ok === (result.outcome === "restored" && !failed) && (result.outcome === "failed" ? failed : !failed);
}
export class RestoreRunner {
  private readonly previews = new Map<string, { at: number; snapshot: RestoreSnapshot }>();
  constructor(private readonly jobs: AgentJobs, private readonly locks: KeyedMutex, private readonly ops: RestoreOps, private readonly now = Date.now) {}
  async preview(request: RestorePreviewRequest, actor: string | null): Promise<RestorePreviewResponse> {
    const budget = new UpdateBudget(UPDATE_PREVIEW_TIMEOUT_MS);
    const snapshot = await this.ops.prepare(request, actor, budget);
    await this.ops.validate(snapshot, budget);
    snapshot.preview.previewId = randomUUID();
    for (const [id, value] of this.previews) if (this.now() - value.at > 300_000) this.previews.delete(id);
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(snapshot.preview.previewId, { at: this.now(), snapshot });
    return structuredClone(snapshot.preview);
  }
  start(request: RestoreStartRequest, actor: string | null): { jobId: string } {
    const cached = this.previews.get(request.previewId);
    if (!cached || this.now() - cached.at > 300_000 || !same(request.target, cached.snapshot.preview.target)
      || request.backupId !== cached.snapshot.preview.backupId || !same(request.mounts, cached.snapshot.preview.mounts)
      || !same(request.expectedContainer, cached.snapshot.preview.expectedContainer)) throw new UpdateFailure("state-changed");
    let cancelled = false; const jobId = this.jobs.nextId(); let snapshot = cached.snapshot;
    let progress: RestoreProgress = { jobId, kind: "restore", target: request.target, phase: "queued", extractStarted: false,
      phaseStartedAt: new Date(this.now()).toISOString(), phaseDeadlineAt: new Date(this.now() + MUTATION_QUEUE_POLICY.restore).toISOString(),
      completedAt: null, cancelAllowed: true, result: null };
    this.jobs.register(progress, [request.target], () => { if (!progress.cancelAllowed) return false; cancelled = true; return true; });
    this.previews.delete(request.previewId);
    const phase = (name: RestorePhase, ms: number) => {
      progress = { ...progress, phase: name, extractStarted: progress.extractStarted || name === "extract",
        cancelAllowed: ["queued", "stop"].includes(name), phaseStartedAt: new Date(this.now()).toISOString(),
        phaseDeadlineAt: new Date(this.now() + ms).toISOString() };
      this.jobs.update(progress);
    };
    const result: RestoreResult = { target: request.target, backupId: request.backupId, ok: false, outcome: "cancelled",
      state: runtimeStateOf(snapshot.raw), restoreError: null, resumeError: null };
    const execute = async () => {
      let finishIntent = () => {}; let stopAttempted = false;
      try {
        if (cancelled) return result;
        const budget = new UpdateBudget(restorePhaseTimeoutMs(request.startDeadlineSeconds));
        snapshot = await this.ops.prepare(request, actor, budget);
        if (!same(snapshot.preview.expectedContainer, request.expectedContainer)
          || !same(snapshot.preview.targets, cached.snapshot.preview.targets)
          || !same(snapshot.preview.backup, cached.snapshot.preview.backup)) throw new UpdateFailure("state-changed");
        await this.ops.validate(snapshot, budget);
        if (cancelled) return result;
        finishIntent = this.ops.intentional(snapshot);
        phase("stop", UPDATE_MUTATION_RESERVE_MS); stopAttempted = true;
        await this.ops.stop(snapshot, new UpdateBudget(UPDATE_MUTATION_RESERVE_MS));
        if (!cancelled) {
          phase("extract", restorePhaseTimeoutMs(request.startDeadlineSeconds));
          await this.ops.extract(snapshot, new UpdateBudget(restorePhaseTimeoutMs(request.startDeadlineSeconds)));
          result.outcome = "restored";
        }
      } catch (error) { result.restoreError = failure(error, progress.extractStarted ? "restore-extract-failed" : "stop-failed"); }
      finally {
        if (stopAttempted) {
          phase("resume", UPDATE_MUTATION_RESERVE_MS);
          try { result.state = runtimeStateOf(await this.ops.resume(snapshot, new UpdateBudget(UPDATE_MUTATION_RESERVE_MS))); }
          catch (error) { result.resumeError = failure(error, "resume-failed"); }
        }
        try { result.state = runtimeStateOf(await this.ops.read(snapshot, new UpdateBudget(30_000))); }
        catch { result.restoreError ??= "state-changed"; }
        finishIntent();
        if (result.restoreError || result.resumeError) result.outcome = "failed";
        result.ok = result.outcome === "restored";
      }
      return result;
    };
    const key = projectLockKey(request.target.kind === "compose" ? { projectName: request.target.projectName } : { containerName: request.target.containerName });
    void this.locks.runExclusive(key, execute, { waitMs: MUTATION_QUEUE_POLICY.restore }).catch((error: unknown) => {
      result.restoreError = failure(error, "restore-extract-failed"); result.outcome = "failed"; return result;
    }).then((value) => {
      if (!restoreResultConsistent(value)) throw new Error("Inconsistent restore result");
      progress = { ...progress, phase: "completed", completedAt: new Date(this.now()).toISOString(), cancelAllowed: false, result: value };
      this.jobs.update(restoreProgressSchema.parse(progress)); this.ops.finished(value, actor);
    }).catch(() => console.error("[agent] restore job completion failed"));
    return { jobId };
  }
}
