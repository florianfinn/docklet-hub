import assert from "node:assert/strict";
import test from "node:test";
import { healingFixture } from "./self-healing-test-support.js";

for (const duration of [60, null]) test(`container maintenance persists and ends without deferred healing: ${duration}`, async (t) => {
  const f = healingFixture(t);
  f.store.setMaintenance(f.target(), duration, "demo-operator", f.now());
  f.crash(); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 0);
  f.restart(); assert.equal(f.status().maintenance.length, 1);
  if (duration === null) { f.advance(10_000_000); await f.controller.tick(); assert.equal(f.status().maintenance.length, 1); f.store.clearMaintenance(f.target()); }
  else { f.advance(59000); await f.controller.tick(); assert.equal(f.status().maintenance.length, 0); }
  await f.controller.tick(); assert.equal(f.starts(), 0); assert.equal(f.status().budgets[0].usedAttempts, 0);
  f.crash(); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 1);
});

test("stack maintenance covers later services and keeps unrelated projects healable", async (t) => {
  const f = healingFixture(t);
  f.store.setMaintenance({ kind: "stack", projectName: "demo" }, 60, "system:hub", f.now());
  f.current = { ...f.current, Id: "b".repeat(64), Name: "/demo-new", Config: { Labels: {
    "com.docker.compose.project": "demo", "com.docker.compose.service": "new"
  } } };
  f.controller.reconcile(f.current); f.crash(); f.advance(1000); await f.controller.tick();
  assert.equal(f.starts(), 0); assert.equal(f.store.get(f.target())!.attempts.length, 0);
  f.current = { ...f.current, Id: "c".repeat(64), Name: "/other-new", Config: { Labels: {
    "com.docker.compose.project": "other", "com.docker.compose.service": "new"
  } } };
  f.controller.reconcile(f.current); f.crash(); f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 1);
});

test("maintenance cancels an already scheduled attempt and leaves an open incident unchanged", async (t) => {
  const f = healingFixture(t); f.crash();
  f.store.setMaintenance(f.target(), 60, "demo-operator", f.now());
  f.advance(60000); await f.controller.tick(); assert.equal(f.starts(), 0);
  f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick(); const incident = structuredClone(f.status().incidents[0]);
  f.store.setMaintenance(f.target(), 60, "demo-operator", f.now());
  f.advance(60000); await f.controller.tick(); f.store.clearMaintenance(f.target());
  assert.deepEqual(f.status().incidents[0], incident); assert.equal(f.starts(), 3);
});

test("a gate revoked after the last attempt suppresses the incident", async (t) => {
  const f = healingFixture(t); f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  f.block(); await f.controller.tick();
  assert.equal(f.status().incidents.length, 0); assert.equal(f.logCalls(), 0);
});

test("maintenance or acknowledgement during a waiting start invalidates the reservation", async (t) => {
  for (const action of ["maintenance", "acknowledge", "manual-stop", "disabled", "offline"] as const) {
    const f = healingFixture(t); f.crash(); f.advance(1000);
    const execute = f.ports.start;
    f.ports.start = async (...args) => {
      if (action === "maintenance") f.store.setMaintenance(f.target(), 60, "demo-operator", f.now());
      if (action === "acknowledge") f.store.refill(f.target(), f.now(), "acknowledged");
      if (action === "manual-stop") f.emit("kill");
      if (action === "disabled") f.config = { ...f.config, enabled: false };
      if (action === "offline") f.controller.setObserving(false);
      return execute(...args);
    };
    await f.controller.tick();
    assert.equal(f.starts(), 0, action); assert.equal(f.status().budgets[0].usedAttempts, 0, action);
    assert.deepEqual(f.status().incidents, [], action);
  }
});

test("maintenance expires on the agent clock even while Docker observation is unavailable", async (t) => {
  const f = healingFixture(t); f.store.setMaintenance(f.target(), 60, "demo-operator", f.now());
  f.controller.setObserving(false); f.advance(60000); await f.controller.tick();
  const persisted = JSON.parse((await import("node:fs")).readFileSync(f.file, "utf8"));
  assert.deepEqual(persisted.maintenance, []); assert.equal(f.starts(), 0);
});
