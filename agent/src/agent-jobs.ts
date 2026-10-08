import { UpdateFailure } from "./update-budget.js";
import { randomUUID } from "node:crypto";
import { AGENT_JOB_RESULT_RETENTION_MS, agentJobProgressSchema, type AgentJobProgress,
  type AgentJobsQuery, type AgentJobsResponse, type StopIntentTarget } from "contract";

export const AGENT_RECENT_JOB_LIMIT = 256;
export const AGENT_ACTIVE_JOB_LIMIT = 64;
const key = (target: unknown) => JSON.stringify(target);

type Entry = { progress: AgentJobProgress; targets: StopIntentTarget[]; cancel: () => boolean };

// Restore registers its own progress and cancellation boundary in the same store.
export class AgentJobs {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly known: (target: StopIntentTarget) => boolean, private readonly now = Date.now) {}
  nextId(): string { return randomUUID(); }
  register(progress: AgentJobProgress, targets: StopIntentTarget[], cancel: () => boolean): void {
    this.prune();
    if ([...this.entries.values()].filter((entry) => entry.progress.phase !== "completed").length >= AGENT_ACTIVE_JOB_LIMIT) {
      throw new UpdateFailure("action-queue-timeout");
    }
    if (this.entries.has(progress.jobId)) throw new Error("Duplicate job ID");
    this.entries.set(progress.jobId, { progress: agentJobProgressSchema.parse(progress), targets: structuredClone(targets), cancel });
  }
  update(progress: AgentJobProgress): void {
    const entry = this.entries.get(progress.jobId);
    if (!entry) throw new Error("Unknown job ID");
    entry.progress = agentJobProgressSchema.parse(progress);
    this.prune();
  }
  private visible(entry: Entry): boolean { return entry.targets.length > 0 && entry.targets.every(this.known); }
  get(id: string): AgentJobProgress | null {
    this.prune(); const entry = this.entries.get(id);
    return entry && this.visible(entry) ? structuredClone(entry.progress) : null;
  }
  targets(id: string): StopIntentTarget[] | null {
    this.prune(); const entry = this.entries.get(id);
    return entry && this.visible(entry) ? structuredClone(entry.targets) : null;
  }
  cancel(id: string): boolean { const entry = this.entries.get(id); return Boolean(entry && this.visible(entry) && entry.cancel()); }
  list(query: AgentJobsQuery = {}): AgentJobsResponse {
    this.prune();
    const jobs = [...this.entries.values()].filter((entry) => this.visible(entry)
      && (!query.kind || entry.progress.kind === query.kind)
      && (!query.target || key(query.target) === key(entry.progress.target))).map((entry) => entry.progress);
    return structuredClone({ active: jobs.filter((job) => job.phase !== "completed"),
      recent: jobs.filter((job) => job.phase === "completed").sort((a, b) => b.completedAt!.localeCompare(a.completedAt!)) });
  }
  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (entry.progress.completedAt && this.now() - Date.parse(entry.progress.completedAt) >= AGENT_JOB_RESULT_RETENTION_MS) this.entries.delete(id);
    }
    const recent = [...this.entries.values()].reverse().filter((entry) => entry.progress.completedAt)
      .sort((a, b) => b.progress.completedAt!.localeCompare(a.progress.completedAt!));
    for (const entry of recent.slice(AGENT_RECENT_JOB_LIMIT)) this.entries.delete(entry.progress.jobId);
  }
}
