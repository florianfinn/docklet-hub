import test from "node:test";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { type UpdatePreviewRequest, type UpdateResult, type UpdateStartRequest, type UpdateServicePreview } from "contract";
import { AgentJobs } from "./agent-jobs.js";
import { KeyedMutex } from "./concurrency.js";
import { UpdateRunner, updateResultConsistent, type UpdateOps, type UpdateSnapshot } from "./update-runner.js";
import { StackEndpointError } from "./stack-control.js";
import { UpdateFailure } from "./update-budget.js";
import type { RawInspect } from "./engine.js";
const oldDigest = `sha256:${"a".repeat(64)}`; const newDigest = `sha256:${"b".repeat(64)}`;
function fixture(names = ["web"], overrides: Partial<UpdateOps> = {}) {
  const trace: string[] = []; let complete!: (result: UpdateResult) => void;
  const completed = new Promise<UpdateResult>((resolve) => { complete = resolve; });
  const jobs = new AgentJobs(() => true); const locks = new KeyedMutex();
  const request: UpdatePreviewRequest = { target: { kind: "stack", projectName: "demo" }, services: names.map((name) => ({
    target: { kind: "compose", projectName: "demo", serviceName: name }, expectedContainer: { containerId: name, status: "running", startedAt: "seen" },
    backup: null, startDeadlineSeconds: 120
  })) };
  const states = new Map<string, RawInspect>();
  const raw = (snapshot: UpdateSnapshot, image = "old"): RawInspect => {
    const value = { ...snapshot.raw, Id: `${name(snapshot)}-${image}`, Image: image }; states.set(name(snapshot), value); return value;
  };
  const name = (s: UpdateSnapshot) => s.preview.target.kind === "compose" ? s.preview.target.serviceName : "container";
  const prepare: UpdateOps["prepare"] = async (selection) => {
    trace.push(`precheck:${selection.expectedContainer.containerId}`);
    const preview: UpdateServicePreview = { ...selection, imageRef: "example/app:1.0", currentDigest: oldDigest, offeredDigest: null,
      rollbackImageId: "old", definitionHash: "definition", acceptance: "service", initialState: { ...selection.expectedContainer, health: null, exitCode: 0 },
      mounts: [], warnings: [], blocker: null };
    return { preview, definition: {}, dependencies: selection.expectedContainer.containerId === "web" && names.includes("db") ? ["db"] : [],
      raw: { Id: selection.expectedContainer.containerId, Name: "/demo", Image: "old", State: { Status: "running", Running: true, StartedAt: "seen" } } };
  };
  const ops: UpdateOps = {
    prepare,
    manifest: async (s) => { trace.push(`manifest:${name(s)}`); return newDigest; },
    pull: async (s) => { trace.push(`pull:${name(s)}`); return { imageId: "new", digest: newDigest }; },
    exchange: async (s, image, _budget, verify, beginExchange) => { beginExchange(); trace.push(`exchange:${name(s)}`); verify(); return raw(s, image); },
    rollback: async (s) => { trace.push(`rollback:${name(s)}`); return raw(s); },
    read: async (s) => states.get(name(s)) ?? s.raw, intentional: () => { trace.push("intent:begin"); return () => trace.push("intent:end"); },
    ...overrides, finished: (result) => { overrides.finished?.(result, null); complete(result); }
  };
  const runner = new UpdateRunner(jobs, locks, ops);
  async function preview() {
    const value = await runner.preview(request, "operator");
    const start: UpdateStartRequest = { previewId: value.previewId, target: value.target, confirmed: true,
      services: value.services.map((service) => ({ ...service, offeredDigest: service.offeredDigest! })) };
    trace.length = 0; return start;
  }
  return { runner, jobs, locks, ops, trace, request, preview, completed, name, raw };
}
test("manifest-only preview queries services in parallel under one total deadline", async (t) => {
  let entered = 0; let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(["web", "db"], { manifest: async () => { entered++; if (entered === 2) release(); await waiting; return newDigest; },
    pull: async () => { throw new Error("preview must not pull"); } });
  const response = await f.runner.preview(f.request, null); assert.equal(entered, 2); assert.equal(response.digestSource, "registry-manifest");
  let queryStarted!: () => void; const querying = new Promise<void>((resolve) => { queryStarted = resolve; });
  const blocked = fixture(["web"], { manifest: async () => { queryStarted(); return new Promise(() => {}); } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired = blocked.runner.preview(blocked.request, null); await querying; t.mock.timers.tick(60_001);
  await assert.rejects(expired, /update-phase-deadline-exceeded/);
});
test("all images are pulled before dependency-ordered exchange and start returns only jobId", async () => {
  const f = fixture(["web", "db"]); const input = await f.preview(); const start = f.runner.start(input, "operator");
  assert.deepEqual(Object.keys(start), ["jobId"]); const result = await f.completed;
  assert.equal(result.outcome, "updated");
  assert.deepEqual(f.trace.filter((s) => /pull:|exchange:/.test(s)), ["pull:db", "pull:web", "exchange:db", "exchange:web"]);
  assert.equal(f.jobs.get(start.jobId)?.phase, "completed");
});
test("equal digest skips pull, stop and exchange", async () => {
  const f = fixture(["web"], { manifest: async () => oldDigest }); f.runner.start(await f.preview(), null);
  const result = await f.completed; assert.equal(result.outcome, "unchanged");
  assert.equal(f.trace.some((s) => /pull:|exchange:|rollback:/.test(s)), false);
});
for (const failure of ["pull", "digest"]) test(`${failure} failure leaves every container untouched`, async () => {
  const f = fixture(["web", "db"], { pull: async () => {
    if (failure === "pull") throw new Error("pull failure"); return { imageId: "new", digest: oldDigest };
  } });
  f.runner.start(await f.preview(), null); const result = await f.completed;
  assert.equal(result.outcome, "failed"); assert.equal(result.updateError, failure === "pull" ? "update-pull-failed" : "update-digest-changed");
  assert.equal(f.trace.some((s) => s.startsWith("exchange:")), false);
});
test("a changed manifest at job precheck cannot mutate containers", async () => {
  let calls = 0; const f = fixture(["web"], { manifest: async () => ++calls === 1 ? newDigest : oldDigest });
  f.runner.start(await f.preview(), null); assert.equal((await f.completed).updateError, "update-digest-changed");
  assert.equal(f.trace.some((s) => s.startsWith("pull:")), false);
});
for (const rollbackFails of [false, true]) test(`failure rolls every exchanged service back in reverse, rollback fails=${rollbackFails}`, async () => {
  const f = fixture(["web", "db", "later"]);
  f.ops.exchange = async (snapshot, _image, _budget, _verify, beginExchange) => { beginExchange(); f.trace.push(`exchange:${f.name(snapshot)}`);
    if (f.name(snapshot) === "web") throw new UpdateFailure("update-health-timeout"); return f.raw(snapshot, "new"); };
  f.ops.rollback = async (snapshot) => { f.trace.push(`rollback:${f.name(snapshot)}`);
    if (rollbackFails && f.name(snapshot) === "web") throw new Error("rollback failed"); return f.raw(snapshot); };
  f.runner.start(await f.preview(), null); const result = await f.completed;
  assert.deepEqual(f.trace.filter((s) => /exchange:|rollback:/.test(s)), ["exchange:db", "exchange:web", "rollback:web", "rollback:db"]);
  assert.equal(result.outcome, rollbackFails ? "rollback-failed" : "rolled-back"); assert.equal(result.updateError, "update-health-timeout");
  assert.equal(result.rollbackError, rollbackFails ? "update-rollback-failed" : null); assert.equal(result.services[2].outcome, "unchanged");
});
test("explicit cancellation while pulling is accepted before any exchange", async () => {
  let release!: () => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = fixture(["web"], { pull: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { imageId: "new", digest: newDigest }; } });
  const { jobId } = f.runner.start(await f.preview(), null); await started; assert.equal(f.jobs.cancel(jobId), true); release();
  assert.equal((await f.completed).outcome, "cancelled"); assert.equal(f.trace.includes("exchange:web"), false);
});
test("cancellation is globally unavailable after the first exchange, including between services", async () => {
  const f = fixture(["web", "db"]); let jobId = "";
  f.ops.exchange = async (snapshot, _image, _budget, _verify, beginExchange) => { beginExchange(); assert.equal(f.jobs.cancel(jobId), false); return f.raw(snapshot, "new"); };
  jobId = f.runner.start(await f.preview(), null).jobId; assert.equal((await f.completed).outcome, "updated");
});
test("shared queue blocks mutation and then fails after 60 seconds", async (t) => {
  const f = fixture(); let release!: () => void;
  const holder = f.locks.runExclusive("demo", () => new Promise<void>((resolve) => { release = resolve; }));
  t.mock.timers.enable({ apis: ["setTimeout"] }); const { jobId } = f.runner.start(await f.preview(), null);
  assert.equal(f.jobs.get(jobId)?.phase, "queued"); t.mock.timers.tick(60_001);
  assert.equal((await f.completed).updateError, "action-queue-timeout"); assert.equal(f.trace.length, 0); release(); await holder;
});
test("start cannot modify the confirmed digest, target, definition, state or deadline", async () => {
  for (const field of ["offeredDigest", "definitionHash", "startDeadlineSeconds", "expectedContainer", "target"] as const) {
    const f = fixture(); const input = await f.preview(); const service = input.services[0];
    const replacement = { offeredDigest: oldDigest, definitionHash: "changed", startDeadlineSeconds: 180,
      expectedContainer: { ...service.expectedContainer, status: "exited" }, target: { kind: "container", containerName: "other" } }[field];
    const changed = { ...input, services: [{ ...service, [field]: replacement }] };
    assert.throws(() => f.runner.start(changed as UpdateStartRequest, null), /update-preview-stale/);
  }
});
test("R10 outcome and error fields remain consistent for successful and failed outcomes", () => {
  for (const outcome of ["updated", "unchanged", "cancelled"] as const) {
    assert.equal(updateResultConsistent({ outcome, updateError: null, rollbackError: null }), true);
    assert.equal(updateResultConsistent({ outcome, updateError: "update-start-failed", rollbackError: null }), false);
  }
  for (const outcome of ["failed", "rolled-back", "rollback-failed"] as const) {
    assert.equal(updateResultConsistent({ outcome, updateError: null, rollbackError: null }), false);
    assert.equal(updateResultConsistent({ outcome, updateError: "update-start-failed", rollbackError: outcome === "rollback-failed" ? "update-rollback-failed" : null }), true);
  }
});
for (const phase of ["precheck", "pull", "exchange", "rollback"] as const) test(`${phase} has its own bounded phase deadline`, async (t) => {
  const f = fixture(); const input = await f.preview();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered!: () => void; const reached = new Promise<void>((resolve) => { entered = resolve; });
  const hang = async () => { entered(); return new Promise<never>(() => {}); };
  if (phase === "precheck") f.ops.prepare = hang;
  if (phase === "pull") f.ops.pull = hang;
  if (phase === "exchange") f.ops.exchange = async (_s, _i, _b, _v, beginExchange) => { beginExchange(); return hang(); };
  if (phase === "rollback") { f.ops.exchange = async (_s, _i, _b, _v, beginExchange) => { beginExchange(); throw new UpdateFailure("update-start-failed"); }; f.ops.rollback = hang; }
  const { jobId } = f.runner.start(input, null); await reached;
  const progress = f.jobs.get(jobId)!; const duration = Date.parse(progress.phaseDeadlineAt) - Date.parse(progress.phaseStartedAt);
  assert.equal(Math.round(duration / 1000) * 1000, phase === "precheck" ? 60_000 : phase === "pull" ? 900_000 : 840_000);
  t.mock.timers.tick(duration + 1); const result = await f.completed;
  assert.equal(result.outcome, phase === "rollback" ? "rollback-failed" : phase === "exchange" ? "rolled-back" : "failed");
  assert.equal(phase === "rollback" ? result.rollbackError : result.updateError, phase === "rollback" ? "update-rollback-failed" : "update-phase-deadline-exceeded");
});
test("stable container lock survives replacement IDs and runtime queue shares that key", async () => {
  const f = fixture(); f.request.target = { kind: "container", containerName: "demo" };
  f.request.services[0].target = f.request.target;
  let entered!: () => void; let release!: () => void; const reached = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.ops.exchange = async (snapshot, _image, _budget, _verify, beginExchange) => { beginExchange(); entered(); await held; return f.raw(snapshot, "new"); };
  f.runner.start(await f.preview(), null); await reached; let runtime = false;
  const waiting = f.locks.runExclusive("container:demo", async () => { runtime = true; }, { waitMs: 60_000 });
  assert.equal(runtime, false); release(); await f.completed; await waiting; assert.equal(runtime, true);
});
test("state change immediately before mutation leaves that service untouched", async () => {
  const f = fixture(); f.ops.exchange = async () => { throw new UpdateFailure("state-changed"); };
  f.runner.start(await f.preview(), null); const result = await f.completed;
  assert.equal(result.outcome, "failed"); assert.equal(result.updateError, "state-changed");
  assert.equal(f.trace.some((entry) => entry.startsWith("rollback:")), false);
});
test("cancellation remains possible through the last fresh authorization before exchange", async () => {
  const f = fixture(); let jobId = "";
  f.ops.exchange = async (snapshot, image, _budget, _verify, beginExchange) => {
    assert.equal(f.jobs.cancel(jobId), true); beginExchange(); return f.raw(snapshot, image);
  };
  jobId = f.runner.start(await f.preview(), null).jobId; const result = await f.completed;
  assert.equal(result.outcome, "cancelled"); assert.equal(result.updateError, null);
  assert.equal(f.trace.some((entry) => entry.startsWith("rollback:")), false);
});
test("a later unhealthy state cannot reopen a completed update or trigger rollback", async (t) => {
  const f = fixture(); let replacement: RawInspect | null = null;
  f.ops.exchange = async (snapshot, image, _budget, verify, beginExchange) => {
    beginExchange(); verify(); replacement = f.raw(snapshot, image);
    replacement.State = { ...replacement.State, Health: { Status: "healthy" } }; return replacement;
  };
  const { jobId } = f.runner.start(await f.preview(), null); assert.equal((await f.completed).outcome, "updated");
  replacement!.State!.Health = { Status: "unhealthy" };
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.mock.timers.tick(60_000); await new Promise((resolve) => setImmediate(resolve));
  const completed = f.jobs.get(jobId); assert.equal(completed?.phase, "completed"); assert.equal(completed?.result?.outcome, "updated");
  assert.equal(f.trace.some((entry) => entry.startsWith("rollback:")), false);
});

test("fresh precheck has a separate budget and cannot consume the exchange allowance", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = fixture(); const prepare = f.ops.prepare; let checks = 0;
  f.ops.prepare = async (...args) => {
    if (++checks === 3) { now += 59_000; t.mock.timers.tick(59_000); }
    return prepare(...args);
  };
  f.ops.exchange = async (snapshot, image, budget, verify, beginExchange) => {
    assert.equal(budget.remaining(), 840_000); beginExchange(); verify(); return f.raw(snapshot, image);
  };
  f.runner.start(await f.preview(), null); assert.equal((await f.completed).outcome, "updated");
});
test("only changed services acquire update intent", async () => {
  let intended: string[] = [];
  const f = fixture(["web", "db"], { manifest: async (s) => s.preview.target.kind === "compose" && s.preview.target.serviceName === "db" ? oldDigest : newDigest,
    intentional: (snapshots) => { intended = snapshots.map((s) => s.preview.expectedContainer.containerId); return () => {}; } });
  f.runner.start(await f.preview(), null); assert.equal((await f.completed).outcome, "updated"); assert.deepEqual(intended, ["web"]);
});
test("digest-bound references stay unchanged without pull, retag or exchange", async () => {
  const f = fixture(["web"], { manifest: async () => oldDigest }); const prepare = f.ops.prepare;
  f.ops.prepare = async (...args) => { const snapshot = await prepare(...args); snapshot.preview.imageRef = `example/app@${oldDigest}`; return snapshot; };
  f.runner.start(await f.preview(), null); assert.equal((await f.completed).outcome, "unchanged");
  assert.equal(f.trace.some((s) => /pull:|exchange:|rollback:/.test(s)), false);
});

for (const key of ["self-management-locked", "externally-managed", "agent-read-only", "not-allowlisted", "observe-only", "container-gone"]) {
  test(`fresh eligibility failure retains or maps the gate key: ${key}`, async () => {
    const f = fixture(); const prepare = f.ops.prepare; let calls = 0;
    f.ops.prepare = async (...args) => { if (++calls === 3) throw new StackEndpointError(403, key); return prepare(...args); };
    f.runner.start(await f.preview(), null); const result = await f.completed;
    assert.equal(result.updateError, ["observe-only", "container-gone"].includes(key) ? "state-changed" : key);
    assert.equal(result.services[0].updateError, result.updateError); assert.equal(result.rollbackError, null);
    assert.equal(f.trace.some((s) => /exchange:|rollback:/.test(s)), false);
  });
}
