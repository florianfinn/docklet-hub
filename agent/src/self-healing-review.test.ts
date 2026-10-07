import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { healingFixture } from "./self-healing-test-support.js";
import { HEALING_ENTRY_LIMIT } from "./self-healing-store.js";

for (const stack of [false, true]) test(`successful hub restart cannot heal a later zero-exit job: stack=${stack}`, async (t) => {
  const f = healingFixture(t);
  if (stack) {
    f.current.Config!.Labels = { "com.docker.compose.project": "demo", "com.docker.compose.service": "job" };
    f.controller.reconcile(f.current);
  }
  const finish = f.intents.beginHubRestart([f.current]);
  f.emit("kill"); f.crash(0); f.emit("stop");
  assert.notEqual(f.store.get(f.target())!.pending, null);
  f.manualStart();
  assert.equal(f.intents.isHubRestartActive(f.current.Id), true);
  f.crash(0); finish(); f.advance(1000); await f.controller.tick();
  assert.equal(f.starts(), 0); assert.equal(f.store.get(f.target())!.pending, null);
  assert.equal(f.status().budgets.every((entry) => entry.usedAttempts === 0), true);
});

test("changing container names are pruned by inventory and bounded by oldest idle eviction", (t) => {
  const f = healingFixture(t);
  for (let index = 0; index < HEALING_ENTRY_LIMIT + 20; index++) {
    f.advance(1);
    f.current = { ...f.current, Id: `id-${index}`, Name: `/demo-${index}` };
    f.controller.reconcile(f.current);
  }
  assert.equal(f.store.entries().length, HEALING_ENTRY_LIMIT);
  assert.equal(f.store.get({ kind: "container", containerName: "demo-0" }), undefined);
  assert.notEqual(f.store.get(f.target()), undefined);
  f.controller.reconcileInventory([f.current]);
  assert.equal(f.store.entries().length, 1);
  f.ports.eligible = () => false;
  f.current = { ...f.current, Id: "ungranted", Name: "/demo-ungranted" };
  f.controller.reconcile(f.current); f.emit("kill"); f.crash();
  assert.equal(f.store.entries().length, 1);
});

test("idle overflow retains pending healing without consumed attempts", (t) => {
  const f = healingFixture(t); f.crash();
  const target = f.target();
  const pending = f.store.get(target)!.pending;
  assert.notEqual(pending, null);
  assert.equal(f.store.get(target)!.attempts.length, 0);
  for (let index = 0; index < HEALING_ENTRY_LIMIT + 20; index++) {
    f.advance(1);
    f.current = { ...f.current, Id: `id-${index}`, Name: `/demo-${index}`,
      State: { ...f.current.State, Running: true, Status: "running", ExitCode: 0 } };
    f.controller.reconcile(f.current);
  }
  assert.equal(f.store.entries().length, HEALING_ENTRY_LIMIT);
  assert.deepEqual(f.store.get(target)?.pending, pending);
  assert.equal(f.store.get(target)?.attempts.length, 0);
  assert.equal(f.store.get({ kind: "container", containerName: "demo-0" }), undefined);
  assert.notEqual(f.store.get(f.target()), undefined);
});

test("empty inventory prunes a missing idle target and retains a missing consumed budget", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick();
  const used = f.store.get(f.target())!;
  assert.equal(used.attempts.length, 1);
  f.current = { ...f.current, Id: "idle", Name: "/demo-idle" };
  f.controller.reconcile(f.current);
  assert.equal(f.store.entries().length, 2);
  assert.equal(f.store.get(f.target())!.attempts.length, 0);
  f.controller.reconcileInventory([]);
  assert.deepEqual(f.store.entries(), [used]);
});

test("inventory and saturation retain consumed budgets and refuse fresh healing without capacity", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000); await f.controller.tick();
  const used = f.store.entries()[0];
  f.store.change((state) => {
    state.entries = Array.from({ length: HEALING_ENTRY_LIMIT }, (_, index) => ({ ...structuredClone(used),
      target: { kind: "container", containerName: `demo-used-${index}` }, containerId: `id-${index}` }));
  });
  f.controller.reconcileInventory([]);
  assert.equal(f.store.entries().length, HEALING_ENTRY_LIMIT);
  f.current = { ...f.current, Id: "new", Name: "/demo-new" };
  f.controller.reconcile(f.current); f.crash(); f.advance(1000); await f.controller.tick();
  assert.equal(f.store.get(f.target()), undefined); assert.equal(f.starts(), 1);
  assert.equal(f.store.entries().every((entry) => entry.attempts.length === 1), true);
});

for (const missedStart of [false, true]) test(`controlled shutdown retains pending healing and reconciles starts: missedStart=${missedStart}`, async (t) => {
  const f = healingFixture(t); f.crash();
  const pending = f.store.entries()[0].pending;
  f.controller.shutdown(); f.controller.setObserving(false);
  assert.deepEqual(f.store.entries()[0].pending, pending);
  f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 0);
  if (missedStart) {
    f.current.State = { ...f.current.State, Running: true, Status: "running", StartedAt: new Date(f.now()).toISOString() };
  }
  f.restart(); await f.controller.tick();
  assert.equal(f.starts(), missedStart ? 0 : 1);
  assert.equal(f.store.entries()[0].pending, null);
});

for (const zeroExit of [false, true]) test(`bounded on-failure stops polling when Docker will not retry: zeroExit=${zeroExit}`, async (t) => {
  const f = healingFixture(t, "on-failure", 3);
  if (zeroExit) { const finish = f.intents.beginHubRestart([f.current]); f.emit("kill"); f.crash(0); finish(); }
  else f.crash();
  let checks = 0;
  const check = f.ports.check;
  f.ports.check = async (...args) => { checks++; return check(...args); };
  f.advance(1000); await f.controller.tick();
  for (let index = 0; index < 100; index++) { f.advance(1000); await f.controller.tick(); }
  assert.equal(checks, 1); assert.equal(f.starts(), 0);
  assert.equal(f.status().budgets[0].nextAttemptAt, null);
  assert.equal(f.store.entries()[0].pending, null);
});

for (const jump of [-3_600_000, 3_600_000]) test(`retry, stability and maintenance durations survive wall clock jump ${jump}`, async (t) => {
  const f = healingFixture(t); f.crash(); f.jump(jump);
  await f.controller.tick(); assert.equal(f.starts(), 0);
  f.advance(999); await f.controller.tick(); assert.equal(f.starts(), 0);
  f.advance(1); await f.controller.tick(); assert.equal(f.starts(), 1);
  f.jump(-jump); f.advance(9999); await f.controller.tick();
  assert.equal(f.status().budgets[0].usedAttempts, 1);
  f.advance(1); await f.controller.tick(); assert.equal(f.status().budgets[0].usedAttempts, 0);
  f.store.setMaintenance(f.target(), 60, "demo-operator", f.now()); f.jump(jump);
  assert.equal(f.status().maintenance.length, 1);
  f.advance(59999); await f.controller.tick(); assert.equal(f.status().maintenance.length, 1);
  f.advance(1); await f.controller.tick(); assert.equal(f.status().maintenance.length, 0);
});

test("storage failure reports unavailability and recovers with bounded retry backoff", async (t) => {
  const f = healingFixture(t);
  f.store.setMaintenance({ kind: "container", containerName: "demo-other" }, 60, "demo-operator", f.now());
  f.crash(); f.advance(60000);
  let writes = 0;
  const mock = t.mock.method(fs, "renameSync", () => {
    writes++; throw new Error("synthetic storage failure");
  });
  await assert.rejects(f.controller.tick(), /synthetic storage failure/);
  assert.equal(f.status().observing, false); assert.equal(f.starts(), 0);
  await f.controller.tick(); assert.equal(writes, 1);
  f.jump(3_600_000); await f.controller.tick(); assert.equal(writes, 1);
  f.advance(1000); await assert.rejects(f.controller.tick(), /synthetic storage failure/);
  assert.equal(writes, 2);
  mock.mock.restore(); f.advance(1999); await f.controller.tick(); assert.equal(f.starts(), 0);
  f.advance(1); await f.controller.tick();
  assert.equal(f.status().observing, true); assert.equal(f.starts(), 1);
  assert.equal(f.status().budgets[0].usedAttempts, 1);
});

test("fail schedules monotonic recovery after 1, 2, 4, 8, 16 and at most 30 seconds", async (t) => {
  const f = healingFixture(t); f.crash();
  let writes = 0;
  const mock = t.mock.method(fs, "renameSync", () => {
    writes++; throw new Error("synthetic recovery failure");
  });
  f.controller.fail();
  assert.equal(f.controller.isAvailable(), false);
  f.jump(3_600_000);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const previous = writes;
    f.advance(delay - 1); f.controller.fail(); await f.controller.tick();
    assert.equal(writes, previous, `recovery must wait ${delay} ms`);
    assert.equal(f.starts(), 0);
    f.advance(1); await assert.rejects(f.controller.tick(), /synthetic recovery failure/);
    assert.equal(writes, previous + 1);
    assert.equal(f.controller.isAvailable(), false);
  }
  mock.mock.restore();
  f.advance(29999); await f.controller.tick(); assert.equal(f.starts(), 0);
  f.advance(1); await f.controller.tick();
  assert.equal(f.controller.isAvailable(), true); assert.equal(f.starts(), 1);
  f.controller.fail();
  f.advance(999); await f.controller.tick(); assert.equal(f.controller.isAvailable(), false);
  f.advance(1); await f.controller.tick(); assert.equal(f.controller.isAvailable(), true);
});

test("failed observation cleanup is retried before recovery can heal stale evidence", async (t) => {
  const f = healingFixture(t); f.crash();
  const mock = t.mock.method(fs, "renameSync", () => { throw new Error("synthetic cleanup failure"); });
  assert.throws(() => f.controller.setObserving(false), /synthetic cleanup failure/); f.controller.fail();
  mock.mock.restore(); f.controller.setObserving(true); f.advance(1000); await f.controller.tick();
  assert.equal(f.controller.isAvailable(), true); assert.equal(f.starts(), 0);
  assert.equal(f.store.entries()[0].pending, null);
});

test("a missed start with unchanged nonzero RestartCount is manual relative to the previous start", async (t) => {
  const f = healingFixture(t); f.current.RestartCount = 2; f.manualStart(2);
  f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick(); assert.equal(f.status().incidents[0].closedAt, null);
  assert.equal(f.store.entries()[0].lastStart!.restartCount, 2);
  f.advance(1); f.current.State = { ...f.current.State, Running: true, Status: "running", StartedAt: new Date(f.now()).toISOString() };
  f.restart();
  assert.equal(f.status().budgets[0].usedAttempts, 0);
  assert.equal(f.status().incidents[0].closedReason, "manual-start");
});

test("controlled shutdown while a start is queued retains the unconsumed failure", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000);
  const execute = f.ports.start;
  f.ports.start = async (...args) => { f.controller.shutdown(); return execute(...args); };
  await f.controller.tick();
  assert.equal(f.starts(), 0); assert.equal(f.store.entries()[0].attempts.length, 0);
  assert.notEqual(f.store.entries()[0].pending, null);
  f.ports.start = execute; f.restart(); await f.controller.tick(); assert.equal(f.starts(), 1);
});

test("directory sync failure after replacement retains the uncertain reservation through recovery", async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000);
  const sync = fs.fsyncSync;
  let failed = false;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (!failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error("synthetic directory sync failure"); }
    sync(fd);
  });
  await assert.rejects(f.controller.tick(), /synthetic directory sync failure/);
  assert.equal(f.controller.isAvailable(), false); assert.equal(f.starts(), 0);
  assert.equal(f.store.entries()[0].attempts.length, 1);
  const persisted = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(persisted.entries[0].attempts.length, 1);
  f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 0);
  assert.equal(f.store.entries()[0].attempts[0].result, "interrupted");
  f.advance(1000); await f.controller.tick(); assert.equal(f.starts(), 1);
  assert.equal(f.store.entries()[0].attempts.length, 2);
});
