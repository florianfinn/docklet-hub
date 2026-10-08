import { randomUUID } from "node:crypto";
import { MUTATION_QUEUE_POLICY, UPDATE_PREVIEW_TIMEOUT_MS, UPDATE_PRECHECK_TIMEOUT_MS, UPDATE_PULL_TIMEOUT_MS,
  UPDATE_READBACK_TIMEOUT_MS, updateExchangeTimeoutMs, updateRollbackTimeoutMs, updateProgressSchema,
  type UpdatePreviewRequest, type UpdatePreviewResponse, type UpdateStartRequest, type UpdateServicePreview,
  type UpdateProgress, type UpdatePhase, type UpdateResult, type UpdateServiceResult, type UpdateError } from "contract";
import { AgentJobs } from "./agent-jobs.js";
import { KeyedMutex } from "./concurrency.js";
import type { RawInspect } from "./engine.js";
import { runtimeStateOf } from "./runtime-actions.js";
import { UpdateBudget, UpdateFailure } from "./update-budget.js";

class UpdateCancelled extends Error {}

export const UPDATE_PREVIEW_RETENTION_MS = 5 * 60_000;
export type UpdateSnapshot = { preview: UpdateServicePreview; raw: RawInspect; definition: unknown; dependencies: string[] };
export type UpdateOps = {
  prepare(selection: UpdatePreviewRequest["services"][number], actor: string | null, budget: UpdateBudget): Promise<UpdateSnapshot>;
  manifest(snapshot: UpdateSnapshot, budget: UpdateBudget): Promise<string | null>;
  pull(snapshot: UpdateSnapshot, budget: UpdateBudget): Promise<{ imageId: string; digest: string | null }>;
  exchange(snapshot: UpdateSnapshot, imageId: string, budget: UpdateBudget, verify: () => void, beginExchange: () => void): Promise<RawInspect>;
  rollback(snapshot: UpdateSnapshot, budget: UpdateBudget): Promise<RawInspect>;
  read(snapshot: UpdateSnapshot, budget: UpdateBudget): Promise<RawInspect>;
  intentional(snapshots: UpdateSnapshot[]): () => void;
  finished(result: UpdateResult, actor: string | null): void;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function updateOrder(snapshots: UpdateSnapshot[]): UpdateSnapshot[] {
  const ordered: UpdateSnapshot[] = []; const visited = new Set<UpdateSnapshot>(); const visiting = new Set<UpdateSnapshot>();
  const byService = new Map(snapshots.filter((s) => s.preview.target.kind === "compose").map((s) =>
    [(s.preview.target as { serviceName: string }).serviceName, s]));
  const visit = (snapshot: UpdateSnapshot) => {
    if (visited.has(snapshot)) return;
    if (visiting.has(snapshot)) throw new UpdateFailure("update-preview-stale");
    visiting.add(snapshot);
    for (const name of snapshot.dependencies) { const dependency = byService.get(name); if (dependency) visit(dependency); }
    visiting.delete(snapshot); visited.add(snapshot); ordered.push(snapshot);
  };
  snapshots.forEach(visit); return ordered;
}
export function updateResultConsistent(result: Pick<UpdateResult, "outcome" | "updateError" | "rollbackError">): boolean {
  if (["updated", "unchanged", "cancelled"].includes(result.outcome)) return !result.updateError && !result.rollbackError;
  if (result.outcome === "rollback-failed") return Boolean(result.updateError && result.rollbackError);
  return Boolean(result.updateError && !result.rollbackError);
}
export class UpdateRunner {
  private readonly previews = new Map<string, { at: number; response: UpdatePreviewResponse }>();
  constructor(private readonly jobs: AgentJobs, private readonly locks: KeyedMutex, private readonly ops: UpdateOps,
    private readonly now = Date.now) {}
  async preview(request: UpdatePreviewRequest, actor: string | null, budget = new UpdateBudget(UPDATE_PREVIEW_TIMEOUT_MS)): Promise<UpdatePreviewResponse> {
    const services = await budget.run(() => Promise.all(request.services.map(async (selection) => {
      const snapshot = await this.ops.prepare(selection, actor, budget);
      const preview = snapshot.preview;
      if (!preview.blocker) {
        try { preview.offeredDigest = await this.ops.manifest(snapshot, budget); }
        catch { preview.offeredDigest = null; }
        if (!preview.offeredDigest) preview.blocker = "manifest-query-failed";
      }
      return preview;
    })));
    const response: UpdatePreviewResponse = { previewId: randomUUID(), target: request.target, digestSource: "registry-manifest", services };
    for (const [id, value] of this.previews) if (this.now() - value.at >= UPDATE_PREVIEW_RETENTION_MS) this.previews.delete(id);
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(response.previewId, { at: this.now(), response: structuredClone(response) });
    return response;
  }
  start(request: UpdateStartRequest, actor: string | null): { jobId: string } {
    const cached = this.previews.get(request.previewId);
    if (!cached || this.now() - cached.at >= UPDATE_PREVIEW_RETENTION_MS || !same(cached.response.target, request.target)
      || cached.response.services.length !== request.services.length || request.services.some((service, index) => {
        const preview = cached.response.services[index];
        return preview.blocker !== null || !same(service.target, preview.target) || !same(service.expectedContainer, preview.expectedContainer)
          || service.offeredDigest !== preview.offeredDigest || service.definitionHash !== preview.definitionHash
          || service.startDeadlineSeconds !== preview.startDeadlineSeconds || !same(service.backup, preview.backup);
      })) throw new UpdateFailure("update-preview-stale");
    const jobId = this.jobs.nextId(); let cancelled = false;
    let progress: UpdateProgress = { jobId, kind: "update", target: request.target, service: null, phase: "queued",
      phaseStartedAt: new Date(this.now()).toISOString(), phaseDeadlineAt: new Date(this.now() + MUTATION_QUEUE_POLICY.update).toISOString(),
      completedAt: null, cancelAllowed: true, firstExchangeStarted: false, result: null };
    this.jobs.register(progress, request.services.map((s) => s.target), () => {
      if (!progress.cancelAllowed) return false;
      cancelled = true; return true;
    });
    this.previews.delete(request.previewId);
    const phase = (name: UpdatePhase, snapshot: UpdateSnapshot | null, ms: number) => {
      progress = { ...progress, phase: name, service: snapshot?.preview.target ?? null,
        phaseStartedAt: new Date(this.now()).toISOString(), phaseDeadlineAt: new Date(this.now() + ms).toISOString(),
        cancelAllowed: !progress.firstExchangeStarted && !["exchange", "verify", "rollback", "resume", "completed"].includes(name) };
      this.jobs.update(progress);
    };
    const results: UpdateServiceResult[] = cached.response.services.map((s) => ({ target: s.target, outcome: "unchanged",
      state: s.initialState, imageId: s.rollbackImageId, definitionHash: s.definitionHash, backupId: null,
      updateError: null, rollbackError: null, resumeError: null }));
    const resultFor = (s: UpdateSnapshot) => results.find((r) => same(r.target, s.preview.target))!;
    const lockKey = request.target.kind === "container" ? `container:${request.target.containerName}` : request.target.projectName;
    const execute = async (): Promise<UpdateResult> => {
      const snapshots: UpdateSnapshot[] = []; const exchanged: UpdateSnapshot[] = []; const images = new Map<UpdateSnapshot, string>();
      let failure: UpdateError | null = null; let rollbackError: UpdateError | null = null; let current: UpdateSnapshot | null = null;
      let finishIntent = () => {};
      try {
        for (const selection of request.services) {
          if (cancelled) break;
          const budget = new UpdateBudget(UPDATE_PRECHECK_TIMEOUT_MS);
          current = { preview: cached.response.services[snapshots.length], raw: {} as RawInspect, definition: null, dependencies: [] };
          phase("precheck", current, UPDATE_PRECHECK_TIMEOUT_MS);
          current = await budget.run(() => this.ops.prepare(selection, actor, budget));
          snapshots.push(current);
          if (current.preview.blocker) throw new UpdateFailure("update-preview-stale");
          if (current.preview.definitionHash !== selection.definitionHash
            || !same(current.preview.expectedContainer, selection.expectedContainer)) throw new UpdateFailure("state-changed");
          if (await budget.run(() => this.ops.manifest(current!, budget)) !== selection.offeredDigest) throw new UpdateFailure("update-digest-changed");
        }
        const ordered = updateOrder(snapshots);
        for (const snapshot of ordered) {
          if (cancelled) break;
          current = snapshot;
          const offered = request.services.find((s) => same(s.target, snapshot.preview.target))!.offeredDigest;
          if (offered === snapshot.preview.currentDigest) continue;
          phase("pull", snapshot, UPDATE_PULL_TIMEOUT_MS);
          let pulled;
          try { const budget = new UpdateBudget(UPDATE_PULL_TIMEOUT_MS); pulled = await budget.run(() => this.ops.pull(snapshot, budget)); }
          catch (error) { if (error instanceof UpdateFailure) throw error; throw new UpdateFailure("update-pull-failed"); }
          if (pulled.digest !== offered) throw new UpdateFailure("update-digest-changed");
          images.set(snapshot, pulled.imageId);
        }
        if (!cancelled) {
          finishIntent = this.ops.intentional(ordered);
          for (const snapshot of ordered) {
            const image = images.get(snapshot); if (!image) continue;
            current = snapshot;
            // Backup is supplied by step C. Unsupported requests never reach this boundary.
            if (cancelled && !progress.firstExchangeStarted) break;
            const ms = updateExchangeTimeoutMs(snapshot.preview.startDeadlineSeconds);
            phase("precheck", snapshot, UPDATE_PRECHECK_TIMEOUT_MS);
            const precheckBudget = new UpdateBudget(UPDATE_PRECHECK_TIMEOUT_MS);
            const fresh = await precheckBudget.run(() => this.ops.prepare(snapshot.preview, actor, precheckBudget));
            if (fresh.preview.blocker || fresh.preview.definitionHash !== snapshot.preview.definitionHash
              || !same(fresh.preview.expectedContainer, snapshot.preview.expectedContainer)) throw new UpdateFailure("state-changed");
            if (cancelled && !progress.firstExchangeStarted) break;
            const budget = new UpdateBudget(ms);
            const raw = await budget.run(() => this.ops.exchange(snapshot, image, budget, () => {
              const deadline = progress.phaseDeadlineAt; phase("verify", snapshot, Math.max(1, Date.parse(deadline) - this.now()));
            }, () => {
              if (cancelled && !progress.firstExchangeStarted) throw new UpdateCancelled();
              progress = { ...progress, firstExchangeStarted: true, cancelAllowed: false };
              exchanged.push(snapshot); phase("exchange", snapshot, budget.remaining());
            }));
            Object.assign(resultFor(snapshot), { outcome: "updated", state: runtimeStateOf(raw), imageId: raw.Image ?? null });
          }
        }
        const readBudget = new UpdateBudget(UPDATE_READBACK_TIMEOUT_MS);
        for (const snapshot of snapshots) {
          current = snapshot;
          const raw = await readBudget.run(() => this.ops.read(snapshot, readBudget));
          const result = resultFor(snapshot);
          if (result.outcome === "updated" && raw.Image !== images.get(snapshot)) throw new UpdateFailure("update-state-mismatch");
          Object.assign(result, { state: runtimeStateOf(raw), imageId: raw.Image ?? null });
        }
      } catch (error) {
        failure = error instanceof UpdateCancelled ? null : error instanceof UpdateFailure ? error.code : error instanceof Error && error.message === "action-queue-timeout"
          ? "action-queue-timeout" : "update-exchange-failed";
        if (current && failure) Object.assign(resultFor(current), { outcome: "failed", updateError: failure });
        for (const snapshot of [...exchanged].reverse()) {
          const ms = updateRollbackTimeoutMs(snapshot.preview.startDeadlineSeconds); phase("rollback", snapshot, ms);
          const result = resultFor(snapshot); result.updateError ??= failure;
          try {
            const budget = new UpdateBudget(ms);
            const raw = await budget.run(() => this.ops.rollback(snapshot, budget));
            Object.assign(result, { outcome: "rolled-back", state: runtimeStateOf(raw), imageId: raw.Image ?? null });
          } catch {
            rollbackError = "update-rollback-failed";
            Object.assign(result, { outcome: "rollback-failed", rollbackError });
          }
        }
      } finally {
        const readBudget = new UpdateBudget(UPDATE_READBACK_TIMEOUT_MS);
        if (failure) for (const snapshot of snapshots) {
          try {
            const raw = await readBudget.run(() => this.ops.read(snapshot, readBudget));
            Object.assign(resultFor(snapshot), { state: runtimeStateOf(raw), imageId: raw.Image ?? null });
          } catch {
            if (exchanged.includes(snapshot)) {
              failure ??= "update-state-mismatch"; rollbackError = "update-rollback-failed";
              Object.assign(resultFor(snapshot), { outcome: "rollback-failed", updateError: failure, rollbackError });
            }
          }
        }
        finishIntent();
      }
      return { target: request.target, services: results, updateError: failure, rollbackError,
        outcome: rollbackError ? "rollback-failed" : failure ? exchanged.length ? "rolled-back" : "failed"
          : cancelled ? "cancelled" : images.size ? "updated" : "unchanged" };
    };
    void this.locks.runExclusive(lockKey, execute, { waitMs: MUTATION_QUEUE_POLICY.update }).catch((error: unknown): UpdateResult => ({
      target: request.target, outcome: "failed", services: results, updateError: error instanceof Error && error.message === "action-queue-timeout"
        ? "action-queue-timeout" : "update-exchange-failed", rollbackError: null
    })).then((result) => {
      if (!updateResultConsistent(result) || !result.services.every(updateResultConsistent)) throw new Error("Inconsistent update result");
      progress = { ...progress, phase: "completed", completedAt: new Date(this.now()).toISOString(), cancelAllowed: false, result };
      this.jobs.update(updateProgressSchema.parse(progress)); this.ops.finished(result, actor);
    }).catch((error: unknown) => { console.error("[agent] update job completion failed", error instanceof Error ? error.name : "Error"); });
    return { jobId };
  }
}
