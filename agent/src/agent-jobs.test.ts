import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_JOB_RESULT_RETENTION_MS, type UpdateProgress, type RestoreProgress } from "contract";
import { AgentJobs, AGENT_RECENT_JOB_LIMIT, AGENT_ACTIVE_JOB_LIMIT } from "./agent-jobs.js";
const target = { kind: "container", containerName: "demo" } as const;
const at = "2026-10-08T00:00:00.000Z";
function progress(id: string): UpdateProgress { return { kind: "update", jobId: id, target, service: null, phase: "queued",
  phaseStartedAt: at, phaseDeadlineAt: at, completedAt: null, cancelAllowed: true, firstExchangeStarted: false, result: null }; }
function completed(id: string): UpdateProgress { return { ...progress(id), phase: "completed", completedAt: at, cancelAllowed: false,
  result: { target, outcome: "unchanged", services: [], updateError: null, rollbackError: null } }; }

test("all stable targets must still be known for list, ID lookup and cancellation", () => {
  const known = new Set(["demo", "worker"]);
  const jobs = new AgentJobs((value) => value.kind === "container" && known.has(value.containerName));
  jobs.register(progress("job"), [target, { kind: "container", containerName: "worker" }], () => true);
  assert.equal(jobs.list({ kind: "update", target }).active.length, 1);
  known.delete("worker");
  assert.deepEqual(jobs.list(), { active: [], recent: [] }); assert.equal(jobs.get("job"), null);
  assert.equal(jobs.targets("job"), null); assert.equal(jobs.cancel("job"), false);
});
test("completed jobs expire at 24 hours, active jobs do not", () => {
  let now = Date.parse(at); const jobs = new AgentJobs(() => true, () => now);
  jobs.register(progress("active"), [target], () => true); jobs.register(completed("done"), [target], () => false);
  now += AGENT_JOB_RESULT_RETENTION_MS - 1; assert.equal(jobs.list().recent.length, 1);
  now++; assert.equal(jobs.get("done"), null); assert.equal(jobs.get("active")?.phase, "queued");
});
test("recent results have an implementation cap without changing contract 13", () => {
  const jobs = new AgentJobs(() => true, () => Date.parse(at));
  for (let i = 0; i < AGENT_RECENT_JOB_LIMIT + 5; i++) jobs.register(completed(String(i)), [target], () => false);
  assert.equal(jobs.list().recent.length, AGENT_RECENT_JOB_LIMIT);
});
test("the same store accepts restore progress and its own cancellation callback", () => {
  const jobs = new AgentJobs(() => true); let cancelled = false;
  const restore: RestoreProgress = { jobId: "restore", kind: "restore", target, phase: "queued", phaseStartedAt: at,
    phaseDeadlineAt: at, completedAt: null, cancelAllowed: true, extractStarted: false, result: null };
  jobs.register(restore, [target], () => { cancelled = true; return true; });
  assert.equal(jobs.list({ kind: "update" }).active.length, 0);
  assert.equal(jobs.list({ kind: "restore" }).active.length, 1); assert.equal(jobs.cancel("restore"), true); assert.equal(cancelled, true);
});

test("active capacity rejects with the existing queue error", () => {
  const jobs = new AgentJobs(() => true);
  for (let i = 0; i < AGENT_ACTIVE_JOB_LIMIT; i++) jobs.register(progress(String(i)), [target], () => false);
  assert.throws(() => jobs.register(progress("overflow"), [target], () => false), { code: "action-queue-timeout" });
  assert.equal(jobs.list().active.length, AGENT_ACTIVE_JOB_LIMIT);
});
