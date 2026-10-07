import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { SelfHealingStore } from "./self-healing-store.js";
import { SelfHealingController } from "./self-healing.js";
import { healingFixture } from "./self-healing-test-support.js";

for (const phase of ["before-engine", "after-engine"] as const) test(`an interrupted reservation survives restart: ${phase}`, async (t) => {
  const f = healingFixture(t); f.crash(); f.advance(1000);
  f.ports.start = async (_id, _expected, _signal, reserve) => {
    reserve(f.current);
    if (phase === "after-engine") {
      f.current.State = { ...f.current.State, Running: true, Status: "running", StartedAt: new Date(f.now()).toISOString() };
    }
    throw new Error("synthetic process interruption");
  };
  await assert.rejects(f.controller.tick(), /synthetic process interruption/);
  const restored = new SelfHealingStore(f.file, f.now, f.monotonic);
  const controller = new SelfHealingController(restored, f.ports, f.now, f.monotonic);
  controller.reconcile(f.current);
  const entry = restored.get(f.target())!;
  assert.equal(entry.attempts.length, 1); assert.equal(entry.attempts[0].result, "interrupted");
  if (phase === "before-engine") {
    assert.equal(entry.pending!.dueAt, f.now() + 2000);
    let starts = 0;
    f.ports.start = async (_id, _expected, _signal, reserve) => { reserve(f.current); starts++; return { status: 503, body: { error: "engine-action-failed" }, mutationStarted: true }; };
    controller.setObserving(true); f.advance(1999); await controller.tick(); assert.equal(starts, 0);
    f.advance(1); await controller.tick(); assert.equal(starts, 1); assert.equal(restored.get(f.target())!.attempts.length, 2);
  } else {
    assert.equal(entry.pending, null); assert.equal(entry.healingStart, null);
    assert.equal(entry.runningSince, f.now());
  }
});

test("state file is private and synchronizes file, atomic replacement and directory in order", async (t) => {
  const f = healingFixture(t);
  const operations: string[] = [];
  const sync = fs.fsyncSync; const rename = fs.renameSync;
  t.mock.method(fs, "fsyncSync", (fd: number) => { operations.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); sync(fd); });
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { operations.push("rename"); rename(...args); });
  f.store.setMaintenance(f.target(), 60, "demo-operator", f.now());
  assert.deepEqual(operations, ["file", "rename", "directory"]);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.directory).filter((name) => name.endsWith(".tmp")), []);
});

test("failed atomic replacement preserves persisted and in-memory budgets and removes temporary files", async (t) => {
  const f = healingFixture(t); const previous = fs.readFileSync(f.file, "utf8"); const status = f.status();
  t.mock.method(fs, "renameSync", () => { throw new Error("synthetic rename failure"); });
  assert.throws(() => f.store.setMaintenance(f.target(), 60, "demo-operator", f.now()), /synthetic rename failure/);
  assert.equal(fs.readFileSync(f.file, "utf8"), previous); assert.deepEqual(f.status(), status);
  assert.deepEqual(fs.readdirSync(f.directory).filter((name) => name.endsWith(".tmp")), []);
});

test("damaged or incompatible persisted state never falls back to a full budget", (t) => {
  const f = healingFixture(t);
  for (const value of ["{broken", '{"version":2,"entries":[],"maintenance":[],"incidents":[]}',
    '{"version":1,"entries":[{}],"maintenance":[],"incidents":[]}']) {
    fs.writeFileSync(f.file, value); assert.throws(() => new SelfHealingStore(f.file));
  }
});

test("incident and acknowledgement survive an agent restart", async (t) => {
  const f = healingFixture(t); f.failStarts(); f.crash();
  for (const delay of [1000, 2000, 3000]) { f.advance(delay); await f.controller.tick(); }
  await f.controller.tick(); const incident = f.status().incidents[0]; f.restart();
  assert.deepEqual(f.status().incidents[0], incident);
  f.store.refill(f.target(), f.now(), "acknowledged"); f.restart();
  assert.equal(f.status().budgets[0].usedAttempts, 0); assert.equal(f.status().incidents[0].closedReason, "acknowledged");
  await f.controller.tick(); assert.equal(f.starts(), 3);
});

test("acknowledgement bounds closed incident history while retaining every open incident", (t) => {
  const f = healingFixture(t);
  f.store.change((state) => {
    state.incidents = Array.from({ length: 260 }, (_, index) => ({ id: `incident-${index}`,
      target: { kind: "container", containerName: `demo-${index}` }, containerId: `id-${index}`,
      openedAt: new Date(f.now()).toISOString(), closedAt: index < 256 ? new Date(f.now()).toISOString() : null,
      closedReason: index < 256 ? "manual-start" : null, cause: { exitCode: 1, engineError: null }, attempts: [],
      recommendation: "inspect-container-logs-and-configuration", logs: { available: false, reason: "logs-unavailable" }
    }));
  });
  f.store.refill({ kind: "container", containerName: "demo-256" }, f.now(), "acknowledged");
  const incidents = f.status().incidents;
  assert.equal(incidents.filter((item) => item.closedAt !== null).length, 256);
  assert.equal(incidents.filter((item) => item.closedAt === null).length, 3);
  assert.equal(incidents.some((item) => item.id === "incident-0"), false);
  assert.equal(incidents.some((item) => item.id === "incident-256"), true);
});
