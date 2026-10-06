import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stopIntentsResponseSchema } from "contract";
import type { DockerMonitorEvent, RawInspect } from "./engine-model.js";
import { STOP_INTENT_BUFFER_MS, StopIntentStore, stopIntentTarget, stopIntentWindow } from "./stop-intent.js";

const id = "a".repeat(64);
const epoch = Date.parse("2026-10-01T10:00:00.000Z");
const standalone: RawInspect = { Id: id, Name: "/demo-web", Config: { StopTimeout: 30 } };
const compose: RawInspect = { ...standalone, Config: { StopTimeout: 30, Labels: {
  "com.docker.compose.project": "demo", "com.docker.compose.service": "web"
} } };
const event = (action: DockerMonitorEvent["action"], offset = 0, containerId = id): DockerMonitorEvent => ({ action, containerId, atMs: epoch + offset });

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-intent-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "stop-intents.json");
  let now = epoch;
  const store = new StopIntentStore(file, () => now);
  store.setDaemonGeneration("boot-a:socket-a");
  return { store, file, directory, setNow: (atMs: number) => { now = atMs; } };
}

test("kill followed by die records manual intent at the stable standalone name", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  assert.deepEqual(store.list(), []);
  assert.equal(store.observe(event("die", 30_000), standalone), "manual-stop");
  assert.deepEqual(store.list(), [{ target: { kind: "container", containerName: "demo-web" },
    containerId: id, stoppedAt: "2026-10-01T10:00:30.000Z", actor: null }]);
});

test("die alone is an unexpected exit and creates no intent", (t) => {
  const { store } = fixture(t);
  assert.equal(store.observe(event("die"), standalone), "unexpected");
  assert.deepEqual(store.list(), []);
  assert.equal(store.recentExits()[0].kind, "unexpected");
});

test("a late crash after a reload signal is unexpected", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  assert.equal(store.observe(event("die", 35_001), standalone), "unexpected");
  assert.equal(store.list().length, 0);
});

test("the timeout plus buffer boundary is inclusive", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  assert.equal(store.observe(event("die", 35_000), standalone), "manual-stop");
});

test("timeout defaults, zero grace and unlimited grace have finite windows", () => {
  assert.equal(stopIntentWindow({ Id: id, Name: "demo" }), 10_000 + STOP_INTENT_BUFFER_MS);
  assert.equal(stopIntentWindow({ ...standalone, Config: { StopTimeout: 0 } }), STOP_INTENT_BUFFER_MS);
  assert.equal(stopIntentWindow({ ...standalone, Config: { StopTimeout: -1 } }), 15_000);
});

test("kill from another container cannot authorize die", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill", 0, "b".repeat(64)), standalone);
  assert.equal(store.observe(event("die", 1), standalone), "unexpected");
});

test("out of order die cannot consume a future kill as manual intent", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill", 10), standalone);
  assert.equal(store.observe(event("die", 1), standalone), "unexpected");
});

test("start from any source clears intent and pending kill", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.observe(event("start", 2), standalone);
  assert.deepEqual(store.list(), []);
  assert.equal(store.observe(event("die", 3), standalone), "unexpected");
});

test("start after recreate clears the Compose project/service intent", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), compose);
  store.observe(event("die", 1), compose);
  store.observe(event("start", 2, "b".repeat(64)), { ...compose, Name: "/demo-web-2", Id: "b".repeat(64) });
  assert.deepEqual(store.list(), []);
});

test("standalone recreate keeps the name key and Compose keys never collide with it", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.observe(event("kill", 2), compose);
  store.observe(event("die", 3), compose);
  assert.equal(store.list().length, 2);
  store.observe(event("start", 4, "b".repeat(64)), { ...standalone, Id: "b".repeat(64) });
  assert.deepEqual(store.list().map((intent) => intent.target), [{ kind: "compose", projectName: "demo", serviceName: "web" }]);
});

test("Compose target requires both labels and includes the project", () => {
  assert.deepEqual(stopIntentTarget(compose), { kind: "compose", projectName: "demo", serviceName: "web" });
  assert.deepEqual(stopIntentTarget({ ...standalone, Config: { Labels: { "com.docker.compose.project": "demo" } } }),
    { kind: "container", containerName: "demo-web" });
  assert.equal(stopIntentTarget({ Id: id, Name: "" }), null);
});

test("the Hub actor is captured only by kill/die within the stop request", (t) => {
  const { store, setNow } = fixture(t);
  const finish = store.beginHubStop([id], "demo-operator");
  store.observe(event("kill", 1), standalone);
  setNow(epoch + 2);
  finish();
  store.observe(event("die", 3), standalone);
  assert.equal(store.list()[0].actor, "demo-operator");
});

test("queued kill still gets the actor after the route finished", (t) => {
  const { store, setNow } = fixture(t);
  const finish = store.beginHubStop([id], "demo-operator");
  setNow(epoch + 2);
  finish();
  store.observe(event("kill", 1), standalone);
  store.observe(event("die", 3), standalone);
  assert.equal(store.list()[0].actor, "demo-operator");
});

test("a failed or idempotent Hub stop never creates intent or attributes a later CLI stop", (t) => {
  const { store } = fixture(t);
  store.beginHubStop([id], "demo-operator")();
  assert.deepEqual(store.list(), []);
  store.observe(event("kill", 1), standalone);
  store.observe(event("die", 2), standalone);
  assert.equal(store.list()[0].actor, null);
});

test("a stack stop records the same Hub actor separately for each service", (t) => {
  const { store } = fixture(t);
  const second = "b".repeat(64);
  store.beginHubStop([id, second], "demo-operator");
  for (const [containerId, service] of [[id, "web"], [second, "worker"]]) {
    const container = { ...compose, Id: containerId, Config: { Labels: {
      "com.docker.compose.project": "demo", "com.docker.compose.service": service
    } } };
    store.observe(event("kill", 1, containerId), container);
    store.observe(event("die", 2, containerId), container);
  }
  assert.equal(store.list().length, 2);
  assert.ok(store.list().every((intent) => intent.actor === "demo-operator"));
});

test("intent persists across an Agent restart with the same daemon generation", (t) => {
  const { store, file } = fixture(t);
  store.observe(event("kill"), compose);
  store.observe(event("die", 1), compose);
  const reloaded = new StopIntentStore(file);
  reloaded.setDaemonGeneration("boot-a:socket-a");
  assert.deepEqual(reloaded.list(), store.list());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("a pending kill also survives Agent restart", (t) => {
  const { store, file } = fixture(t);
  store.beginHubStop([id], "demo-operator");
  store.observe(event("kill"), standalone);
  const reloaded = new StopIntentStore(file);
  reloaded.setDaemonGeneration("boot-a:socket-a");
  assert.equal(reloaded.observe(event("die", 1), standalone), "manual-stop");
  assert.equal(reloaded.list()[0].actor, "demo-operator");
});

for (const generation of ["boot-b:socket-a", "boot-a:socket-b"]) {
  test(`new daemon generation ${generation} discards shutdown stops and pending signals`, (t) => {
    const { store, file } = fixture(t);
    store.observe(event("kill"), standalone);
    store.observe(event("die", 1), standalone);
    store.observe(event("kill", 2), compose);
    const reloaded = new StopIntentStore(file);
    reloaded.setDaemonGeneration(generation);
    assert.deepEqual(reloaded.list(), []);
    assert.equal(reloaded.observe(event("die", 3), compose), "unexpected");
  });
}

test("daemon stream disconnect persists discarded shutdown intent", (t) => {
  const { store, file } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.daemonDisconnected();
  const reloaded = new StopIntentStore(file);
  reloaded.setDaemonGeneration("boot-a:socket-a");
  assert.deepEqual(reloaded.list(), []);
});

test("reconciliation clears a missed start even if its next run has crashed", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.reconcile({ ...standalone, State: { Running: false, StartedAt: new Date(epoch + 2).toISOString() } });
  assert.deepEqual(store.list(), []);
});

test("reconciliation preserves a stopped container with no intervening start", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.reconcile({ ...standalone, State: { Running: false, StartedAt: new Date(epoch - 1).toISOString() } });
  assert.equal(store.list().length, 1);
});

test("read results cannot mutate persistent state", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.list()[0].actor = "changed";
  store.recentExits()[0].kind = "unexpected";
  assert.equal(store.list()[0].actor, null);
  assert.equal(store.recentExits()[0].kind, "manual-stop");
});

test("the shared response contract validates intents and both exit kinds", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  store.observe(event("die", 2), compose);
  assert.equal(stopIntentsResponseSchema.safeParse({ observing: true, intents: store.list(), recentExits: store.recentExits() }).success, true);
  assert.equal(stopIntentsResponseSchema.safeParse({ observing: true, intents: [{ target: { kind: "compose", projectName: "demo" } }], recentExits: [] }).success, false);
});

test("corrupt state fails rather than silently losing manual intent", (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "{incomplete");
  assert.throws(() => new StopIntentStore(file), /state unreadable/);
});

test("a temporary-file symlink cannot overwrite another file", (t) => {
  const { store, file, directory } = fixture(t);
  const victim = path.join(directory, "unrelated.json");
  fs.writeFileSync(victim, "unchanged");
  fs.symlinkSync(victim, `${file}.tmp`);
  assert.throws(() => store.observe(event("kill"), standalone));
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
});


test("a later stop signal has its own window after an earlier reload", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("kill", 30_000), standalone);
  assert.equal(store.observe(event("die", 60_000), standalone), "manual-stop");
});

test("the exit history is bounded independently of durable intent", (t) => {
  const { store } = fixture(t);
  for (let index = 0; index < 257; index++) store.observe(event("die", index), standalone);
  assert.equal(store.recentExits().length, 256);
  assert.equal(store.recentExits()[0].occurredAt, new Date(epoch + 1).toISOString());
});
