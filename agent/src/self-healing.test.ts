import assert from "node:assert/strict";
import test from "node:test";
import { selfHealingStatusResponseSchema } from "contract";
import { healingFixture } from "./self-healing-test-support.js";

for (const [policy, maximum, heals] of [
  ["no", 0, true], ["on-failure", 2, true], ["on-failure", 0, false], ["always", 0, false], ["unless-stopped", 0, false]
] as const) test(`restart policy ${policy}:${maximum} only heals once Docker yields`, async (t) => {
  const f = healingFixture(t, policy, maximum);
  f.current.RestartCount = maximum;
  f.crash(); f.advance(1000); await f.controller.tick();
  assert.equal(f.starts(), heals ? 1 : 0);
  assert.equal(f.status().budgets[0].usedAttempts, heals ? 1 : 0);
});

test("bounded on-failure waits for fresh failure evidence after Docker retries", async (t) => {
  const f = healingFixture(t, "on-failure", 2);
  f.current.RestartCount = 1;
  f.crash(); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 0);
  assert.equal(f.status().budgets[0].nextAttemptAt, null);
  f.manualStart(2); f.crash(); f.advance(1000);
  await f.controller.tick(); assert.equal(f.starts(), 1);
});

for (const scenario of ["manual-stop", "zero-exit", "disabled", "gate-denied", "unhealthy", "offline"] as const) {
  test(`no healing, budget consumption or incident for ${scenario}`, async (t) => {
    const f = healingFixture(t);
    if (scenario === "manual-stop") f.emit("kill");
    if (scenario === "disabled") f.config = { ...f.config, enabled: false };
    if (scenario === "gate-denied") f.block();
    if (scenario !== "unhealthy") f.crash(scenario === "zero-exit" ? 0 : 1);
    else { f.current.State!.Health = { Status: "unhealthy" }; f.emit("health_status"); }
    if (scenario === "offline") f.controller.setObserving(false);
    f.advance(100_000); await f.controller.tick();
    assert.equal(f.starts(), 0); assert.equal(f.status().budgets[0].usedAttempts, 0);
    assert.deepEqual(f.status().incidents, []);
  });
}

test("each attempt respects its delay and exhaustion opens exactly one incident without a loop", async (t) => {
  const f = healingFixture(t);
  for (let index = 0; index < 3; index++) {
    f.advance(1); f.crash();
    f.advance(f.config.retryDelaysSeconds[index] * 1000 - 1); await f.controller.tick();
    assert.equal(f.starts(), index);
    f.advance(1); await f.controller.tick(); assert.equal(f.starts(), index + 1);
    assert.equal(f.status().incidents.length, 0);
  }
  f.advance(1); f.crash(); await f.controller.tick();
  const incident = f.status().incidents[0];
  assert.equal(incident.cause.exitCode, 1); assert.equal(incident.cause.engineError, "synthetic engine error");
  assert.equal(incident.attempts.length, 3);
  assert.equal(incident.attempts.every((item) => item.result === "ok" && item.finishedAt !== null), true);
  assert.deepEqual(incident.logs, { available: true, lines: ["synthetic log"] });
  assert.equal(incident.recommendation, "inspect-container-logs-and-configuration");
  for (let index = 0; index < 100; index++) { f.advance(100_000); f.crash(); await f.controller.tick(); }
  assert.equal(f.starts(), 3); assert.equal(f.logCalls(), 1); assert.equal(f.status().incidents.length, 1);
  assert.deepEqual(f.incidentChanges, [f.current.Id]);
  selfHealingStatusResponseSchema.parse(f.status());
});

test("engine start failures consume bounded attempts and produce an incident without another die", async (t) => {
  const f = healingFixture(t); f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick();
  assert.equal(f.starts(), 3); assert.equal(f.status().incidents.length, 1);
  assert.equal(f.status().incidents[0].attempts.every((item) => item.result === "failed" && item.error === "engine-action-failed"), true);
});

test("continuous stability refills; another crash resets the stability window", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick();
  f.advance(9999); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 1);
  f.crash(); f.advance(2000); await f.controller.tick();
  f.advance(9999); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 2);
  f.advance(1); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 0);
});

test("relative RestartCount ignores Docker retries after healing and accepts a manual reset", async (t) => {
  const f = healingFixture(t, "on-failure", 2);
  f.manualStart(0);
  f.current.RestartCount = 2; f.crash(); f.advance(1000); await f.controller.tick();
  assert.equal(f.status().budgets[0].usedAttempts, 1);
  for (let count = 1; count <= 2; count++) {
    f.crash(); f.manualStart(count); // start event with a greater count is Docker, irrespective of the caller.
    assert.equal(f.status().budgets[0].usedAttempts, 1);
  }
  f.crash(); f.advance(2000); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 2);
  f.manualStart(0); assert.equal(f.status().budgets[0].usedAttempts, 0);
  // A baseline of 2 retained across the manual reset would now misclassify Docker's count of 1 as manual.
  f.current.RestartCount = 2; f.crash(); f.advance(1000); await f.controller.tick();
  f.crash(); f.manualStart(1); assert.equal(f.status().budgets[0].usedAttempts, 1);
});

test("agent restart retains used budget, deadline and stability window", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick();
  f.advance(1); f.crash(); f.advance(500); f.restart();
  assert.equal(f.status().budgets[0].usedAttempts, 1);
  f.advance(1499); await f.controller.tick(); assert.equal(f.starts(), 1);
  f.advance(1); await f.controller.tick(); assert.equal(f.starts(), 2);
  f.advance(5000); f.restart(); f.advance(5000); await f.controller.tick();
  assert.equal(f.status().budgets[0].usedAttempts, 0);
});

test("manual start missed during downtime refills and closes an incident", async (t) => {
  const f = healingFixture(t); f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick(); assert.equal(f.status().incidents[0].closedAt, null);
  f.advance(1); f.current.State = { ...f.current.State, Running: true, Status: "running", StartedAt: new Date(f.now()).toISOString() };
  f.current.RestartCount = 0; f.restart();
  assert.equal(f.status().budgets[0].usedAttempts, 0);
  assert.equal(f.status().incidents[0].closedReason, "manual-start");
});

test("acknowledgement refills without starting and a fresh failure starts a fresh series", async (t) => {
  const f = healingFixture(t); f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick();
  f.store.refill(f.target(), f.now(), "acknowledged");
  f.advance(100_000); await f.controller.tick(); assert.equal(f.starts(), 3);
  assert.equal(f.status().incidents[0].closedReason, "acknowledged");
  assert.equal(f.status().budgets[0].usedAttempts, 0);
  f.crash(); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 4);
});

test("disabled configuration cancels an existing retry rather than starting on re-enable", async (t) => {
  const f = healingFixture(t); f.crash(); f.config = { ...f.config, enabled: false };
  f.advance(1000); await f.controller.tick(); f.config = { ...f.config, enabled: true };
  await f.controller.tick(); assert.equal(f.starts(), 0);
});

test("a manual start with unchanged RestartCount closes a previous incident and resets the budget", async (t) => {
  const f = healingFixture(t); f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick(); f.manualStart();
  assert.equal(f.status().budgets[0].usedAttempts, 0); assert.equal(f.status().incidents[0].closedReason, "manual-start");
  assert.equal(f.status().budgets[0].nextAttemptAt, null);
});

test("incident can be persisted without logs when redaction is unavailable", async (t) => {
  const f = healingFixture(t); f.config = { ...f.config, attempts: 1, retryDelaysSeconds: [1] };
  f.evidence({ logs: { available: false, reason: "redaction-unavailable" }, cause: { exitCode: 1, engineError: null } });
  f.crash(); f.advance(1000); await f.controller.tick(); f.advance(1); f.crash(); await f.controller.tick();
  assert.deepEqual(f.status().incidents[0].logs, { available: false, reason: "redaction-unavailable" });
  f.restart(); assert.deepEqual(f.status().incidents[0].logs, { available: false, reason: "redaction-unavailable" });
});

test("a shortened budget or changed delay never replenishes existing attempts", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick(); f.advance(1); f.crash();
  f.config = { ...f.config, attempts: 1, retryDelaysSeconds: [10] };
  await f.controller.tick(); assert.equal(f.starts(), 1); assert.equal(f.status().incidents.length, 1);
});


test("duplicate start evidence cannot refill a healing attempt", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick();
  f.emit("start"); f.advance(1); f.emit("start");
  assert.equal(f.status().budgets[0].usedAttempts, 1);
  f.restart(); f.emit("start"); assert.equal(f.status().budgets[0].usedAttempts, 1);
});

test("reducing the attempt limit while queued prevents the mutation and opens an incident on the next tick", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick(); f.advance(1); f.crash(); f.advance(2000);
  const start = f.ports.start;
  f.ports.start = async (...args) => { f.config = { ...f.config, attempts: 1, retryDelaysSeconds: [1] }; return start(...args); };
  await f.controller.tick(); assert.equal(f.starts(), 1); assert.equal(f.status().budgets[0].usedAttempts, 1);
  await f.controller.tick(); assert.equal(f.status().incidents.length, 1);
});

test("increasing the attempt limit during evidence collection avoids a stale incident and schedules the new delay", async (t) => {
  const f = healingFixture(t); f.config = { ...f.config, attempts: 1, retryDelaysSeconds: [1] };
  f.crash(); f.advance(1000); await f.controller.tick(); f.advance(1); f.crash();
  const evidence = f.ports.evidence;
  f.ports.evidence = async (...args) => { f.config = { ...f.config, attempts: 2, retryDelaysSeconds: [1, 2] }; return evidence(...args); };
  await f.controller.tick(); assert.equal(f.status().incidents.length, 0);
  await f.controller.tick(); assert.equal(f.starts(), 1);
  f.advance(1999); await f.controller.tick(); assert.equal(f.starts(), 1);
  f.advance(1); await f.controller.tick(); assert.equal(f.starts(), 2);
});


for (const missedStart of [false, true]) test(`observation loss cancels healing and reconnect only reconciles inventory: missedStart=${missedStart}`, async (t) => {
  const f = healingFixture(t); f.crash();
  assert.notEqual(f.store.entries()[0].pending, null);
  f.controller.setObserving(false);
  assert.equal(f.store.entries()[0].pending, null);
  if (missedStart) f.current.State!.StartedAt = new Date(f.now() + 1).toISOString();
  f.advance(100_000); f.controller.reconcile(f.current); f.controller.setObserving(true);
  await f.controller.tick(); assert.equal(f.starts(), 0);
  assert.equal(f.status().budgets[0].usedAttempts, 0);
  f.crash(); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 1);
});

test("observation loss restarts the stability window without refilling used budget", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick();
  f.advance(9000); f.controller.setObserving(false); f.advance(100_000);
  f.controller.reconcile(f.current); f.controller.setObserving(true); await f.controller.tick();
  assert.equal(f.status().budgets[0].usedAttempts, 1);
  f.advance(9999); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 1);
  f.advance(1); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 0);
});


for (const exitCode of [0, 1]) test(`a failed Hub restart heals its stopped result without competing with the restart: exitCode=${exitCode}`, async (t) => {
  const f = healingFixture(t);
  const finish = f.intents.beginHubRestart([f.current]);
  f.emit("kill"); f.crash(exitCode); f.emit("stop");
  assert.deepEqual(f.intents.list(), []);
  f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 0);
  finish(); await f.controller.tick(); assert.equal(f.starts(), 1);
  assert.equal(f.status().budgets[0].usedAttempts, 1);
});

for (const exitCode of [0, 1]) test(`CLI restart evidence heals a stopped result but kill/die alone remains manual: exitCode=${exitCode}`, async (t) => {
  const f = healingFixture(t); f.emit("kill"); f.crash(exitCode);
  f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 0);
  f.emit("restart"); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 1);
  assert.deepEqual(f.intents.list(), []);
});

for (const action of ["hub", "cli"] as const) test(`a successful ${action} restart cancels healing of its stop phase`, async (t) => {
  const f = healingFixture(t);
  const finish = action === "hub" ? f.intents.beginHubRestart([f.current]) : () => {};
  f.emit("kill"); f.crash(1); f.manualStart();
  if (action === "cli") f.emit("restart");
  finish(); f.advance(100_000); await f.controller.tick();
  assert.equal(f.starts(), 0); assert.deepEqual(f.intents.list(), []);
});

test("a reload signal does not cancel an eligible unexpected failure", async (t) => {
  const f = healingFixture(t); f.crash();
  f.controller.observe({ action: "kill", signal: "SIGHUP", containerId: f.current.Id }, f.current, null);
  f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 1);
});


test("a CLI restart completing a successful zero-exit job does not create a new failure", async (t) => {
  const f = healingFixture(t); f.emit("kill"); f.crash(1); f.manualStart(); f.crash(0); f.emit("restart");
  f.advance(100_000); await f.controller.tick(); assert.equal(f.starts(), 0);
  assert.equal(f.status().budgets[0].usedAttempts, 0);
});
