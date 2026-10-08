import test from "node:test";
import assert from "node:assert/strict";
import type { UpdateServicePreview } from "contract";
import { effectiveHealthcheck, verifyUpdate, rollbackStateMatches, verifyRollback } from "./update-verification.js";
import { UpdateBudget } from "./update-budget.js";
import type { RawInspect } from "./engine.js";
const target = { kind: "container", containerName: "demo" } as const;
const image = `sha256:${"a".repeat(64)}`;
const raw = (status = "running", health?: string): RawInspect => ({ Id: "new", Name: "/demo", Image: image, RestartCount: 0,
  Config: { Healthcheck: health ? { Test: ["CMD", "check"] } : undefined },
  State: { Status: status, Running: status === "running", StartedAt: "start", ExitCode: 0, Health: health ? { Status: health } : undefined } });
const preview = (acceptance: UpdateServicePreview["acceptance"] = "service", deadline = 10) => ({
  target, startDeadlineSeconds: deadline, acceptance
}) as UpdateServicePreview;
async function run(read: (now: number) => RawInspect, p = preview()) {
  let now = 0; let reads = 0;
  const result = await verifyUpdate(async () => { reads++; return read(now); }, p, image, new UpdateBudget(100_000, () => now), 0,
    { now: () => now, sleep: async (ms) => { now += ms; } });
  return { result, now, reads };
}
test("effective healthcheck is absent for NONE and empty tests", () => {
  for (const Test of [undefined, [], ["NONE"]]) assert.equal(effectiveHealthcheck({ ...raw(), Config: { Healthcheck: { Test } } }), false);
  assert.equal(effectiveHealthcheck(raw("running", "starting")), true);
});
test("health may be starting or unhealthy until the start deadline", async () => {
  assert.equal((await run((now) => raw("running", now < 9000 ? now < 5000 ? "starting" : "unhealthy" : "healthy"))).now, 9000);
});
test("health start period does not extend the absolute deadline", async () => {
  await assert.rejects(run(() => raw("running", "starting")), /update-health-timeout/);
});
test("no healthcheck requires 30 seconds even with a 10 second start deadline", async () => {
  const result = await run(() => raw()); assert.equal(result.now, 30_000); assert.equal(result.reads, 31);
});
for (const change of ["restart", "startedAt", "exit-zero", "exit-failure"]) test(`service verification rejects ${change}`, async () => {
  await assert.rejects(run((now) => {
    const value = raw();
    if (now >= 2000) {
      if (change === "restart") value.RestartCount = 1;
      if (change === "startedAt") value.State!.StartedAt = "another-start";
      if (change.startsWith("exit")) { value.State!.Status = "exited"; value.State!.Running = false; value.State!.ExitCode = change === "exit-zero" ? 0 : 1; }
    }
    return value;
  }), change.startsWith("exit") ? /update-container-exited/ : /update-container-restarted/);
});
for (const exit of [0, 1]) test(`completion jobs accept only exit ${exit === 0 ? "zero" : "nonzero fails"} within deadline`, async () => {
  const task = () => run((now) => { const value = raw(now >= 9000 ? "exited" : "running"); value.State!.ExitCode = exit; return value; }, preview("completion-job"));
  if (exit === 0) assert.equal((await task()).now, 9000); else await assert.rejects(task(), /update-completion-failed/);
});
test("completion job cannot remain running past the start deadline", async () => {
  await assert.rejects(run(() => raw(), preview("completion-job")), /update-completion-failed/);
});
test("stopped targets have no runtime check and must remain stopped", async () => {
  assert.equal((await run(() => raw("created"), preview("created"))).reads, 1);
  await assert.rejects(run(() => raw(), preview("created")), /update-state-mismatch/);
});
test("rollback restores image and initial runtime state without imposing healthy", () => {
  for (const status of ["running", "restarting"]) {
    const previous = raw(status, "unhealthy"); previous.State!.Running = true;
    assert.equal(rollbackStateMatches(raw("running", "unhealthy"), previous), true);
  }
  assert.equal(rollbackStateMatches(raw("created"), raw("exited")), true);
  assert.equal(rollbackStateMatches(raw(), raw("exited")), false);
  assert.equal(rollbackStateMatches(raw("paused"), raw("paused")), true);
  assert.equal(rollbackStateMatches(raw(), raw("paused")), false);
  assert.equal(rollbackStateMatches({ ...raw(), Image: "different" }, raw()), false);
});

test("rollback waits for originally healthy state, but cannot extend its start deadline", async () => {
  let now = 0; const previous = raw("running", "healthy");
  const time = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  await assert.rejects(verifyRollback(async () => raw("running", "starting"), preview(), previous, new UpdateBudget(60_000), 0, time), /update-rollback-failed/);
  assert.equal(now, 10_000); now = 0;
  const restored = await verifyRollback(async () => raw("running", now >= 4000 ? "healthy" : "starting"), preview(), previous, new UpdateBudget(60_000), 0, time);
  assert.equal(restored.State!.Health!.Status, "healthy"); assert.equal(now, 4000);
});

test("the start deadline begins at Docker StartedAt, including a slow start response", async () => {
  let now = 100_000;
  const startedAt = new Date(now).toISOString();
  const read = async () => ({ ...raw("running", now < 109_000 ? "starting" : "healthy"),
    State: { ...raw("running", now < 109_000 ? "starting" : "healthy").State, StartedAt: startedAt } });
  const result = await verifyUpdate(read, preview(), image, new UpdateBudget(100_000, () => now), 90_000,
    { now: () => now, sleep: async (ms) => { now += ms; } });
  assert.equal(result.State!.Health!.Status, "healthy"); assert.equal(now, 109_000);
});
