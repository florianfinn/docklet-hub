import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stopIntentsResponseSchema } from "contract";
import type { DockerMonitorEvent, RawInspect } from "./engine-model.js";
import { STOP_INTENT_BUFFER_MS, STOP_INTENT_LIMIT, StopIntentStore, stopIntentTarget, stopIntentWindow } from "./stop-intent.js";

const id = "a".repeat(64);
const epoch = Date.parse("2026-10-01T10:00:00.000Z");
const standalone: RawInspect = { Id: id, Name: "/demo-web", Config: { StopTimeout: 30 } };
const compose: RawInspect = { ...standalone, Config: { StopTimeout: 30, Labels: {
  "com.docker.compose.project": "demo", "com.docker.compose.service": "web"
} } };
const event = (action: DockerMonitorEvent["action"], offset = 0, containerId = id): DockerMonitorEvent => ({ action, containerId, atMs: epoch + offset, ...(action === "kill" ? { signal: "15" } : {}) });

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

test("a crash beyond the stop signal window is unexpected", (t) => {
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

for (const content of ["{incomplete", "null", JSON.stringify({ version: 2 }),
  JSON.stringify({ version: 1, generation: "boot-a:socket-a", intents: [{ invalid: true }], kills: [] }),
  JSON.stringify({ version: 1, generation: "boot-a:socket-a", intents: [], kills: [{ invalid: true }] })]) {
  test(`corrupt state is archived and starts empty: ${content.slice(0, 20)}`, (t) => {
    const { store, file, directory } = fixture(t);
    store.observe(event("kill"), standalone);
    store.observe(event("die", 1), standalone);
    const validIntent = store.list()[0];
    // A valid prefix must not survive an invalid suffix in the same file.
    const damaged = content.includes('"invalid"') ? JSON.stringify({ version: 1, generation: "boot-a:socket-a",
      intents: content.includes('"intents":[{"invalid"') ? [validIntent, { invalid: true }] : [validIntent],
      kills: content.includes('"kills":[{"invalid"') ? [{ invalid: true }] : [] }) : content;
    fs.writeFileSync(file, damaged);
    const warnings: string[] = [];
    const reloaded = new StopIntentStore(file, () => epoch, (message) => warnings.push(message));
    assert.deepEqual(reloaded.list(), []);
    assert.equal(reloaded.observe(event("die", 2), standalone), "unexpected");
    const archives = fs.readdirSync(directory).filter((name) => name.startsWith("stop-intents.json.corrupt-"));
    assert.equal(archives.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, archives[0]), "utf8"), damaged);
    assert.deepEqual(warnings, ["[agent] Invalid stop intent state archived; starting with empty intent state"]);
    reloaded.setDaemonGeneration("boot-a:socket-a");
    reloaded.observe(event("kill", 3), standalone);
    assert.equal(reloaded.observe(event("die", 4), standalone), "manual-stop");
    assert.equal(new StopIntentStore(file).list().length, 1);
  });
}

for (const corrupt of [false, true]) {
  test(`state rename synchronizes its directory: ${corrupt ? "archive" : "persist"}`, (t) => {
    const { store, file } = fixture(t);
    const calls: string[] = [];
    const open = fs.openSync;
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    let directoryFd: number | undefined;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (args[0] === path.dirname(file)) directoryFd = fd;
      return fd;
    });
    t.mock.method(fs, "fsyncSync", (fd: number) => { calls.push(fd === directoryFd ? "directory-sync" : "file-sync"); sync(fd); });
    t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => { rename(...args); calls.push("rename"); });
    if (corrupt) {
      fs.writeFileSync(file, "{incomplete");
      new StopIntentStore(file, () => epoch, () => {});
      assert.deepEqual(calls, ["rename", "directory-sync"]);
    } else {
      store.observe(event("kill"), standalone);
      assert.deepEqual(calls, ["file-sync", "rename", "directory-sync"]);
    }
  });
}

test("a temporary-file symlink cannot overwrite another file", (t) => {
  const { store, file, directory } = fixture(t);
  const victim = path.join(directory, "unrelated.json");
  fs.writeFileSync(victim, "unchanged");
  fs.symlinkSync(victim, `${file}.tmp`);
  assert.throws(() => store.observe(event("kill"), standalone));
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
});


test("a later stop signal has its own window after an earlier stop signal", (t) => {
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

for (const signal of ["1", "HUP", "SIGHUP", undefined]) {
  test(`a non-stop or missing kill signal cannot authorize die: ${signal}`, (t) => {
    const { store } = fixture(t);
    store.observe({ ...event("kill"), signal }, standalone);
    assert.equal(store.observe(event("die", 1), standalone), "unexpected");
    assert.deepEqual(store.list(), []);
  });
}

for (const [stopSignal, signal] of [["SIGUSR1", "10"], ["10", "USR1"], ["sigusr1", "SIGUSR1"],
  ["SIGUSR1", "9"], ["SIGTERM", "KILL"], ["SIGTERM", "TERM"]]) {
  test(`configured stop signal or SIGKILL authorizes die: ${stopSignal} / ${signal}`, (t) => {
    const { store } = fixture(t);
    const container = { ...standalone, Config: { StopSignal: stopSignal } };
    store.observe({ ...event("kill"), signal }, container);
    assert.equal(store.observe(event("die", 1), container), "manual-stop");
  });
}

test("SIGTERM is not stop evidence for a container configured with another stop signal", (t) => {
  const { store } = fixture(t);
  const container = { ...standalone, Config: { StopSignal: "SIGUSR1" } };
  store.observe(event("kill"), container);
  assert.equal(store.observe(event("die", 1), container), "unexpected");
});

test("reload signals do not extend an existing stop signal window", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe({ ...event("kill", 30_000), signal: "1" }, standalone);
  assert.equal(store.observe(event("die", 35_001), standalone), "unexpected");
});

test("inventory reconciliation removes absent names and services while keeping recreated targets", (t) => {
  const { store, file } = fixture(t);
  for (const container of [standalone, compose]) {
    store.observe(event("kill"), container);
    store.observe(event("die", 1), container);
  }
  store.reconcileInventory([{ ...compose, Id: "b".repeat(64), Name: "/demo-web-2" }]);
  assert.deepEqual(store.list().map((intent) => intent.target), [stopIntentTarget(compose)]);
  store.reconcileInventory([]);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(new StopIntentStore(file).list(), []);
});

test("durable intent evicts the oldest timestamp even with out of order arrivals and survives reload", (t) => {
  const { store, file } = fixture(t);
  for (let index = STOP_INTENT_LIMIT; index >= 0; index--) {
    const container = { ...standalone, Name: `/demo-${index}` };
    store.observe(event("kill", index * 2), container);
    store.observe(event("die", index * 2 + 1), container);
  }
  assert.equal(store.list().length, STOP_INTENT_LIMIT);
  assert.equal(store.list().some((intent) => intent.target.kind === "container" && intent.target.containerName === "demo-0"), false);
  assert.deepEqual(new StopIntentStore(file).list(), store.list());
});

test("pending stop signals are bounded and absent container IDs are pruned", (t) => {
  const { store } = fixture(t);
  for (let index = 0; index <= STOP_INTENT_LIMIT; index++) {
    store.observe(event("kill", index, index.toString(16).padStart(64, "0")), standalone);
  }
  assert.equal(store.observe(event("die", STOP_INTENT_LIMIT + 1, "0".repeat(64)), standalone), "unexpected");
  store.reconcileInventory([]);
  assert.equal(store.observe(event("die", STOP_INTENT_LIMIT + 2, "1".padStart(64, "0")), standalone), "unexpected");
});

test("existing state read failures and failed corruption archival remain visible", (t) => {
  const { file } = fixture(t);
  const read = t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error("state inaccessible"), { code: "EACCES" }); });
  assert.throws(() => new StopIntentStore(file), /state unreadable/);
  read.mock.restore();
  fs.writeFileSync(file, "{incomplete");
  t.mock.method(fs, "renameSync", () => { throw new Error("archive failed"); });
  assert.throws(() => new StopIntentStore(file), /archive failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "{incomplete");
});

test("loading an oversized state retains only the newest durable intent", (t) => {
  const { store, file } = fixture(t);
  store.observe(event("kill"), standalone);
  store.observe(event("die", 1), standalone);
  const intent = store.list()[0];
  const intents = Array.from({ length: STOP_INTENT_LIMIT + 1 }, (_, index) => ({ ...intent,
    target: { kind: "container", containerName: `demo-${index}` }, stoppedAt: new Date(epoch + index).toISOString() }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, generation: "boot-a:socket-a", intents: intents.reverse(), kills: [] }));
  const reloaded = new StopIntentStore(file);
  assert.equal(reloaded.list().length, STOP_INTENT_LIMIT);
  assert.equal(reloaded.list().some((entry) => entry.target.kind === "container" && entry.target.containerName === "demo-0"), false);
});

for (const [stopSignal, signal] of [
  ["SIGRTMIN+3", "37"], ["37", "SIGRTMIN+3"], ["RTMIN+3", "rtmax-27"],
  ["SIGRTMAX-3", "61"], ["61", "SIGRTMAX-3"], ["sigrtmax-3", "RTMIN+27"],
  ["SIGRTMIN", "34"], ["34", "RTMIN"], ["SIGRTMAX", "64"], ["64", "RTMAX"],
  ["SIGRTMIN+0", "34"], ["SIGRTMAX-0", "64"], ["SIGRTMIN+30", "64"], ["SIGRTMAX-30", "34"]
]) {
  test(`Linux realtime stop signals authorize die: ${stopSignal} / ${signal}`, (t) => {
    const { store } = fixture(t);
    const container = { ...standalone, Config: { StopSignal: stopSignal } };
    store.observe({ ...event("kill"), signal }, container);
    assert.equal(store.observe(event("die", 1), container), "manual-stop");
  });
}

for (const [stopSignal, signal] of [
  ["SIGRTMIN+3", "38"], ["37", "SIGRTMAX-26"],
  ["SIGRTMIN+31", "65"], ["33", "SIGRTMAX-31"],
  ["SIGRTMIN-1", "33"], ["65", "SIGRTMAX+1"],
  ["SIGRTMIN-1", "35"], ["35", "SIGRTMIN-1"], ["SIGRTMAX+1", "63"], ["63", "SIGRTMAX+1"],
  ["SIGRTMIN+", "34"], ["64", "SIGRTMAX-"], ["SIGRTMIN+1.5", "35"],
  ["SIGRTMIN+9007199254740993", "34"], ["SIGRTMIN+3", "SIGRTMIN+invalid"]
]) {
  test(`mismatched or invalid realtime signals cannot authorize die: ${stopSignal} / ${signal}`, (t) => {
    const { store } = fixture(t);
    const container = { ...standalone, Config: { StopSignal: stopSignal } };
    store.observe({ ...event("kill"), signal }, container);
    assert.equal(store.observe(event("die", 1), container), "unexpected");
    assert.deepEqual(store.list(), []);
  });
}


for (const queued of [false, true]) test(`a Hub restart whose start fails never leaves manual stop intent: queued=${queued}`, (t) => {
  const { store, file, setNow } = fixture(t);
  store.observe(event("kill"), standalone); store.observe(event("die", 1), standalone);
  setNow(epoch + 2);
  const finish = store.beginHubRestart([standalone]);
  assert.deepEqual(store.list(), []);
  assert.equal(store.isHubRestartActive(id), true);
  if (queued) { setNow(epoch + 5); finish(); }
  store.observe(event("kill", 3), standalone);
  assert.equal(store.restartRequested(event("die", 4)), true);
  assert.equal(store.observe(event("die", 4), standalone), "unexpected");
  if (!queued) { setNow(epoch + 5); finish(); }
  assert.equal(store.isHubRestartActive(id), false);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(new StopIntentStore(file).list(), []);
  store.observe(event("kill", 6), standalone);
  assert.equal(store.observe(event("die", 7), standalone), "manual-stop");
});

test("a restart annotation survives Agent restart once its stop signal is observed", (t) => {
  const { store, file } = fixture(t);
  store.beginHubRestart([standalone]); store.observe(event("kill", 1), standalone);
  const reloaded = new StopIntentStore(file, () => epoch + 2);
  assert.equal(reloaded.restartRequested(event("die", 2)), true);
  assert.equal(reloaded.observe(event("die", 2), standalone), "unexpected");
  assert.deepEqual(reloaded.list(), []);
});

test("CLI restart reclassifies its observed exit and clears stop intent without start", (t) => {
  const { store, file } = fixture(t);
  store.observe(event("kill"), standalone); store.observe(event("die", 1), standalone);
  assert.equal(store.list().length, 1);
  assert.equal(store.observe(event("restart", 2), standalone), "unexpected");
  assert.deepEqual(store.list(), []);
  assert.deepEqual(new StopIntentStore(file).list(), []);
  assert.equal(store.recentExits()[0].kind, "unexpected");
});

test("a successful CLI restart does not turn a later manual stop into restart evidence", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone); store.observe(event("die", 1), standalone);
  store.observe(event("start", 2), standalone); store.observe(event("restart", 3), standalone);
  store.observe(event("kill", 4), standalone);
  assert.equal(store.observe(event("die", 5), standalone), "manual-stop");
});


test("the trailing stop remains restart evidence after the Hub request has finished", (t) => {
  const { store, setNow } = fixture(t);
  const finish = store.beginHubRestart([standalone]);
  store.observe(event("kill", 1), standalone);
  assert.equal(store.observe(event("die", 2), standalone), "unexpected");
  setNow(epoch + 3); finish();
  assert.equal(store.restartRequested(event("stop", 4)), true);
  store.observe(event("start", 5), standalone);
  assert.equal(store.restartRequested(event("stop", 6)), false);
});


test("an explicit Hub stop overrides restart evidence even in the same clock millisecond", (t) => {
  const { store } = fixture(t);
  const finish = store.beginHubRestart([standalone]);
  store.observe(event("kill"), standalone); store.observe(event("die"), standalone); finish();
  store.beginHubStop([id], "demo-operator");
  store.observe(event("kill"), standalone);
  assert.equal(store.observe(event("die", 1), standalone), "manual-stop");
  assert.equal(store.list()[0].actor, "demo-operator");
});


test("a failed restart annotation preserves stop intent and cannot leave a restart active", (t) => {
  const { store } = fixture(t);
  store.observe(event("kill"), standalone); store.observe(event("die", 1), standalone);
  const intents = store.list();
  t.mock.method(fs, "openSync", () => { throw new Error("synthetic storage failure"); });
  assert.throws(() => store.beginHubRestart([standalone]), /synthetic storage failure/);
  assert.deepEqual(store.list(), intents);
  assert.equal(store.isHubRestartActive(id), false);
});
