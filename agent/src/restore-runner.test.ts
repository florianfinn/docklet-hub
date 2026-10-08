import test from "node:test";
import assert from "node:assert/strict";
import { type RestorePreviewRequest, type RestoreResult, type RestoreStartRequest } from "contract";
import { RestoreRunner, restoreResultConsistent, type RestoreOps, type RestoreSnapshot } from "./restore-runner.js";
import { AgentJobs } from "./agent-jobs.js";
import { KeyedMutex } from "./concurrency.js";
import { UpdateFailure } from "./update-budget.js";
const target = { kind: "container", containerName: "demo" } as const;
function fixture(overrides: Partial<RestoreOps> = {}) {
  const trace: string[] = []; const jobs = new AgentJobs(() => true); const locks = new KeyedMutex();
  let finish!: (result: RestoreResult) => void; const completed = new Promise<RestoreResult>((resolve) => { finish = resolve; });
  const raw = { Id: "replacement", Name: "/demo", State: { Status: "running", Running: true, StartedAt: "seen" } };
  const request: RestorePreviewRequest = { target, backupId: "backup", mounts: [{ sourceId: "stable-source" }] };
  const ops: RestoreOps = {
    prepare: async (body) => ({ raw, data: null, preview: { ...body, previewId: "preview",
      expectedContainer: { containerId: raw.Id, status: "running", startedAt: "seen" },
      backup: { backupId: body.backupId, target: body.target, completedAt: "2026-10-08T00:00:00Z", mode: "stop",
        archives: [{ sourceId: "stable-source", mountTarget: "/data", archiveId: "archive", bytes: 1024 }] },
      targets: [{ service: "", kind: "external", source: "/synthetic/data", target: "/data", sourceId: "stable-source", readOnly: false,
        shared: false, readable: true, writable: true, writeBlocker: null, estimatedBytes: null, backupEligible: true, restoreEligible: true,
        protection: "none", ownership: "exclusive" }], warnings: ["data-overwrite", "database-consistency-not-guaranteed"] } }),
    validate: async () => { trace.push("validate"); }, stop: async () => { trace.push("stop"); }, extract: async () => { trace.push("extract"); },
    resume: async () => { trace.push("resume"); return raw; }, read: async () => raw,
    intentional: () => { trace.push("intent"); return () => trace.push("intent-end"); },
    ...overrides, finished: (result) => { overrides.finished?.(result, null); finish(result); }
  };
  const runner = new RestoreRunner(jobs, locks, ops);
  const input = async (): Promise<RestoreStartRequest> => {
    const preview = await runner.preview(request, null); trace.length = 0;
    return { ...request, expectedContainer: preview.expectedContainer, previewId: preview.previewId, startDeadlineSeconds: 120, confirmed: true };
  };
  return { raw, runner, jobs, locks, request, trace, ops, input, completed };
}
test("K22/R10/R12: independent confirmed restore job orders stop, extract and resume", async () => {
  const f = fixture(); const id = f.runner.start(await f.input(), "operator");
  assert.deepEqual(Object.keys(id), ["jobId"]);
  const result = await f.completed;
  assert.equal(result.ok, true); assert.equal(result.outcome, "restored"); assert.equal(restoreResultConsistent(result), true);
  assert.deepEqual(f.trace, ["validate", "intent", "stop", "extract", "resume", "intent-end"]);
  const progress = f.jobs.get(id.jobId)!; assert.equal(progress.kind, "restore");
  if (progress.kind === "restore") assert.equal(progress.extractStarted, true);
});
for (const phase of ["queued", "stop", "extract", "resume"] as const) test(`K22: cancellation in ${phase} obeys the extract boundary and restores state`, async () => {
  const f = fixture(); let id = ""; let accepted = false;
  if (phase !== "queued") {
    const operation = f.ops[phase];
    Object.assign(f.ops, { [phase]: async (snapshot: RestoreSnapshot, budget: Parameters<RestoreOps["resume"]>[1]) => {
      accepted = f.jobs.cancel(id); return operation(snapshot, budget);
    } });
  }
  let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  const held = phase === "queued" ? f.locks.runExclusive("container:demo", () => waiting) : null;
  id = f.runner.start(await f.input(), null).jobId;
  if (phase === "queued") { accepted = f.jobs.cancel(id); release(); await held; }
  const result = await f.completed;
  assert.equal(accepted, ["queued", "stop"].includes(phase));
  assert.equal(result.outcome, accepted ? "cancelled" : "restored");
  assert.equal(f.trace.includes("extract"), !accepted);
  assert.equal(f.trace.includes("resume"), phase !== "queued");
  const progress = f.jobs.get(id)!;
  if (progress.kind === "restore") assert.equal(progress.extractStarted, !accepted);
});
for (const phase of ["stop", "extract", "resume"] as const) test(`K22/R10: ${phase} errors remain distinct and cannot report restored`, async () => {
  const f = fixture(); f.ops[phase] = async () => { throw new UpdateFailure(phase === "stop" ? "stop-failed" : phase === "extract" ? "restore-extract-failed" : "resume-failed"); };
  const id = f.runner.start(await f.input(), null).jobId; const result = await f.completed;
  assert.equal(result.ok, false); assert.equal(result.outcome, "failed"); assert.equal(restoreResultConsistent(result), true);
  assert.equal(result.restoreError, phase === "resume" ? null : phase === "stop" ? "stop-failed" : "restore-extract-failed");
  assert.equal(result.resumeError, phase === "resume" ? "resume-failed" : null);
  const progress = f.jobs.get(id)!;
  if (progress.kind === "restore") assert.equal(progress.extractStarted, phase !== "stop");
});
test("K22/R8: target, current container and mount changes invalidate confirmation before stopping", async () => {
  const f = fixture(); const input = await f.input();
  for (const changed of [{ ...input, target: { kind: "container", containerName: "other" } }, { ...input, expectedContainer: { ...input.expectedContainer, containerId: "old" } },
    { ...input, mounts: [{ sourceId: "other" }] }]) assert.throws(() => f.runner.start(changed as RestoreStartRequest, null), /state-changed/);
  const prepare = f.ops.prepare;
  f.ops.prepare = async (...args) => { const snapshot = await prepare(...args); snapshot.preview.expectedContainer.containerId = "changed"; return snapshot; };
  f.runner.start(input, null); const result = await f.completed;
  assert.equal(result.restoreError, "state-changed"); assert.equal(f.trace.includes("stop"), false);
});
test("K22: validation rejects unsafe archives before any stop or extract", async () => {
  const f = fixture(); const input = await f.input();
  f.ops.validate = async () => { throw new UpdateFailure("restore-path-unsafe"); };
  f.runner.start(input, null); const result = await f.completed;
  assert.equal(result.restoreError, "restore-path-unsafe"); assert.equal(f.trace.includes("stop"), false); assert.equal(f.trace.includes("extract"), false);
});

test("K22: restore uses the bounded shared mutation queue", async (t) => {
  const f = fixture(); let release!: () => void;
  const held = f.locks.runExclusive("container:demo", () => new Promise<void>((resolve) => { release = resolve; }));
  const input = await f.input(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = f.runner.start(input, null).jobId;
  assert.equal(f.jobs.get(id)?.phase, "queued"); t.mock.timers.tick(60_001);
  const result = await f.completed; assert.equal(result.restoreError, "action-queue-timeout");
  assert.equal(f.trace.includes("stop"), false); release(); await held;
});
