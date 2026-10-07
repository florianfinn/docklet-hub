import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { DockerEngine } from "./engine.js";
import type { DockerMonitorEvent, RawInspect } from "./engine-model.js";
import { DockerEventWatcher } from "./docker-event-watcher.js";
import { StopIntentStore } from "./stop-intent.js";

const id = "a".repeat(64);
const container: RawInspect = { Id: id, Name: "/demo-web", Config: { StopTimeout: 30 }, State: { Running: false } };

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Synthetic event watcher did not settle");
    await setImmediate();
  }
}

function fixture(t: test.TestContext, wait?: (delayMs: number, signal: AbortSignal) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "event-watcher-test-"));
  const file = path.join(directory, "stop-intents.json");
  const store = new StopIntentStore(file);
  const errors: unknown[] = [];
  let emit: (event: DockerMonitorEvent) => void = () => { throw new Error("Event stream not connected"); };
  let end: () => void = () => {};
  let subscriptions = 0;
  let missing = false;
  let inspectFailure: unknown;
  let inspected = container;
  let since: number | undefined;
  const engine: Pick<DockerEngine, "inspect" | "listContainerIds" | "monitorEvents"> = {
    async listContainerIds() { return [id]; },
    async inspect() {
      if (inspectFailure) { const error = inspectFailure; inspectFailure = undefined; throw error; }
      if (missing) throw Object.assign(new Error("gone"), { status: 404 });
      return inspected;
    },
    async monitorEvents(onEvent, signal, options) {
      subscriptions++;
      emit = onEvent;
      since = options?.since;
      options?.onConnected?.();
      await new Promise<void>((resolve) => {
        end = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
  const watcher = new DockerEventWatcher(engine, store, () => "boot-a:socket-a", (error) => { errors.push(error); }, { wait });
  t.after(async () => { await watcher.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, watcher, errors, file, engine, since: () => since,
    failInspect: (error: unknown) => { inspectFailure = error; },
    setContainer: (value: RawInspect) => { inspected = value; }, emit: (action: DockerMonitorEvent["action"]) => emit({ action, containerId: id, containerName: "demo-web", ...(action === "kill" ? { signal: "15" } : {}) }),
    emitRaw: (event: DockerMonitorEvent) => emit(event), end: () => end(), subscriptions: () => subscriptions,
    remove: () => { missing = true; } };
}

test("one background subscription captures CLI stops without Hub listeners", async (t) => {
  const f = fixture(t);
  f.watcher.start();
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.emit("kill");
  f.emit("die");
  await until(() => f.store.list().length === 1);
  assert.equal(f.subscriptions(), 1);
  assert.equal(f.store.list()[0].actor, null);
  assert.deepEqual(f.errors, []);
});

test("monitor listeners share the subscription and never forward kill metadata", async (t) => {
  const f = fixture(t);
  const first: string[] = [];
  const second: string[] = [];
  const unsubscribe = f.watcher.subscribe((event) => first.push(event.action));
  f.watcher.subscribe((event) => second.push(event.action));
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.emit("kill");
  f.emit("die");
  await until(() => first.length === 1);
  unsubscribe();
  f.emit("start");
  await until(() => second.length === 2);
  assert.deepEqual(first, ["die"]);
  assert.deepEqual(second, ["die", "start"]);
  assert.equal(f.subscriptions(), 1);
  assert.equal(f.store.list().length, 0);
});

test("unintentional event-stream EOF discards daemon shutdown stops", async (t) => {
  const f = fixture(t);
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.emit("kill");
  f.emit("die");
  await until(() => f.store.list().length === 1);
  f.end();
  await until(() => !f.watcher.isObserving());
  assert.equal(f.store.list().length, 0);
});

test("an intentional Agent shutdown preserves intent for its restart", async (t) => {
  const f = fixture(t);
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.emit("kill");
  f.emit("die");
  await until(() => f.store.list().length === 1);
  await f.watcher.stop();
  assert.equal(f.store.list().length, 1);
  assert.equal(f.watcher.isObserving(), false);
});

test("a daemon disconnect notifies monitor readers so they can reconnect", async (t) => {
  const f = fixture(t);
  let disconnected = false;
  const unsubscribe = f.watcher.subscribe(() => {}, () => { disconnected = true; });
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.end();
  await until(() => disconnected);
  unsubscribe();
  assert.equal(f.watcher.isObserving(), false);
});

test("removed Compose containers still get their stable target from event metadata", async (t) => {
  const f = fixture(t);
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.remove();
  for (const action of ["kill", "die"] as const) f.emitRaw({ action, containerId: "b".repeat(64),
    containerName: "demo-web", composeProject: "demo", composeService: "web", ...(action === "kill" ? { signal: "15" } : {}) });
  await until(() => f.store.list().length === 1);
  assert.deepEqual(f.store.list()[0].target, { kind: "compose", projectName: "demo", serviceName: "web" });
});

test("storage failure discards intent, ends readers and reconnects after storage recovers", async (t) => {
  const f = fixture(t);
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  f.emit("kill");
  f.emit("die");
  await until(() => f.store.list().length === 1);
  let disconnected = 0;
  f.watcher.subscribe(() => {}, () => { disconnected++; });
  const victim = `${f.file}.unrelated`;
  fs.writeFileSync(victim, "unchanged");
  fs.symlinkSync(victim, `${f.file}.tmp`);
  f.emit("start");
  await until(() => f.errors.length >= 1);
  assert.equal(f.watcher.isObserving(), false);
  assert.equal(disconnected, 1);
  assert.equal(f.store.list().length, 0);
  fs.unlinkSync(`${f.file}.tmp`);
  await until(() => f.subscriptions() === 2 && f.watcher.isObserving());
  const lateEvents: string[] = [];
  f.watcher.subscribe((event) => lateEvents.push(event.action));
  f.emit("kill");
  f.emit("die");
  await until(() => lateEvents.length === 1);
  assert.deepEqual(lateEvents, ["die"]);
  assert.equal(f.store.list().length, 1);
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged");
});

for (const failure of [Object.assign(new Error("inspect failed"), { status: 500 }), new Error("inspect timeout")]) {
  test(`one Inspect error discards intent and resumes observation: ${failure.message}`, async (t) => {
    const f = fixture(t);
    f.watcher.start();
    await until(() => f.watcher.isObserving());
    f.emit("kill");
    f.emit("die");
    await until(() => f.store.list().length === 1);
    f.failInspect(failure);
    f.emit("die");
    await until(() => f.errors.length === 1);
    assert.equal(f.watcher.isObserving(), false);
    assert.deepEqual(f.store.list(), []);
    await until(() => f.subscriptions() === 2 && f.watcher.isObserving());
    const lateEvents: DockerMonitorEvent[] = [];
    f.watcher.subscribe((event) => lateEvents.push(event));
    f.emit("die");
    await until(() => lateEvents.length === 1);
    assert.equal(f.store.recentExits()[0].kind, "unexpected");
    assert.deepEqual(f.errors, [failure]);
  });
}

test("all live monitor actions fan out unchanged over the single background subscription", async (t) => {
  const f = fixture(t);
  const first: DockerMonitorEvent[] = [];
  const second: DockerMonitorEvent[] = [];
  f.watcher.subscribe((event) => first.push(event));
  f.watcher.subscribe((event) => second.push(event));
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  const actions = ["start", "stop", "restart", "create", "destroy", "die", "health_status", "oom"] as const;
  for (const action of actions) f.emit(action);
  await until(() => first.length === actions.length && second.length === actions.length);
  assert.deepEqual(first, actions.map((action) => ({ action, containerId: id, containerName: "demo-web" })));
  assert.deepEqual(second, first);
  assert.equal(f.subscriptions(), 1);
  assert.deepEqual(f.errors, []);
});

test("since excludes old Docker replay from stop intent and monitor readers", async (t) => {
  const f = fixture(t);
  const events: DockerMonitorEvent[] = [];
  f.watcher.subscribe((event) => events.push(event));
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  assert.equal(typeof f.since(), "number");
  const atMs = f.since()! * 1_000;
  f.emitRaw({ action: "kill", containerId: id, signal: "15", atMs: atMs - 1 });
  f.emitRaw({ action: "die", containerId: id, atMs });
  await until(() => events.length >= 1);
  assert.deepEqual(f.store.list(), []);
  assert.equal(f.store.recentExits()[0].kind, "unexpected");
  f.emitRaw({ action: "die", containerId: id, atMs: atMs - 1 });
  f.emitRaw({ action: "stop", containerId: id, atMs: atMs + 1 });
  await until(() => events.some((event) => event.action === "stop"));
  assert.deepEqual(events.map((event) => event.action), ["die", "stop"]);
});

for (const state of [{ Running: true }, { Running: false, StartedAt: new Date(3).toISOString() }]) {
  test(`startup reconciles persisted intent against inspected container: ${JSON.stringify(state)}`, async (t) => {
    const f = fixture(t);
    f.store.setDaemonGeneration("boot-a:socket-a");
    f.store.observe({ action: "kill", containerId: id, signal: "15", atMs: 1 }, container);
    f.store.observe({ action: "die", containerId: id, atMs: 2 }, container);
    assert.equal(f.store.list().length, 1);
    f.setContainer({ ...container, State: state });
    f.watcher.start();
    await until(() => f.watcher.isObserving());
    assert.deepEqual(f.store.list(), []);
    assert.deepEqual(new StopIntentStore(f.file).list(), []);
  });
}

test("startup removes saved intent whose target no longer exists in Docker", async (t) => {
  const f = fixture(t);
  f.store.setDaemonGeneration("boot-a:socket-a");
  f.store.observe({ action: "kill", containerId: id, signal: "15", atMs: 1 }, container);
  f.store.observe({ action: "die", containerId: id, atMs: 2 }, container);
  t.mock.method(f.engine, "listContainerIds", async () => []);
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  assert.deepEqual(f.store.list(), []);
});

test("repeated disconnects back off and a processed live event resets the delay", { timeout: 2_000 }, async (t) => {
  const delays: number[] = [];
  let resume!: () => void;
  const f = fixture(t, async (delayMs, signal) => {
    delays.push(delayMs);
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    const abort = resume;
    signal.addEventListener("abort", abort, { once: true });
    try { await pending; }
    finally { signal.removeEventListener("abort", abort); }
  });
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
  for (let index = 0; index < expected.length; index++) {
    f.end();
    await until(() => delays.length === index + 1);
    assert.equal(f.watcher.isObserving(), false);
    assert.deepEqual(delays, expected.slice(0, index + 1));
    await setImmediate();
    assert.equal(f.subscriptions(), index + 1);
    resume();
    await until(() => f.subscriptions() === index + 2 && f.watcher.isObserving());
  }
  const received: string[] = [];
  f.watcher.subscribe((event) => received.push(event.action));
  f.emit("die");
  await until(() => received.length === 1);
  assert.equal(f.store.recentExits()[0].kind, "unexpected");
  for (const delay of [1_000, 2_000]) {
    f.end();
    expected.push(delay);
    await until(() => delays.length === expected.length);
    assert.deepEqual(delays, expected);
    resume();
    await until(() => f.subscriptions() === expected.length + 1 && f.watcher.isObserving());
  }
  assert.deepEqual(f.errors, []);
});

test("healing receives the same inspected and classified sequence with no additional event subscription", async (t) => {
  const f = fixture(t);
  const classifications: Array<string | null> = [];
  const actions: string[] = [];
  let reconciled = 0;
  let observing = false;
  f.watcher.attachLifecycle({
    reconcile: (inspect) => { assert.equal(inspect.Id, id); reconciled++; },
    observe: (event, inspect, classification) => {
      assert.equal(inspect.Id, id); actions.push(event.action); classifications.push(classification);
    },
    setObserving: (value) => { observing = value; }, fail: () => { throw new Error("unexpected failure"); }
  });
  f.watcher.start(); await until(() => f.watcher.isObserving());
  f.emit("kill"); f.emit("die"); f.emit("start"); f.emit("die");
  await until(() => actions.length === 4);
  assert.deepEqual(actions, ["kill", "die", "start", "die"]);
  assert.deepEqual(classifications, [null, "manual-stop", null, "unexpected"]);
  assert.equal(reconciled, 1); assert.equal(f.subscriptions(), 1); assert.equal(observing, true);
  await f.watcher.stop(); assert.equal(observing, false);
});

test("healing persistence failure makes healing unavailable while the sole watcher reconnects", async (t) => {
  const f = fixture(t, async () => {}); let failed = false;
  f.watcher.attachLifecycle({ reconcile: () => {}, setObserving: () => {},
    observe: () => { throw new Error("healing storage unavailable"); }, fail: () => { failed = true; } });
  f.watcher.start(); await until(() => f.watcher.isObserving());
  f.emit("die"); await until(() => f.errors.length === 1);
  assert.equal(failed, true);
  await until(() => f.subscriptions() === 2 && f.watcher.isObserving());
  assert.equal(f.subscriptions(), 2);
});


test("healing is suspended on disconnect and reconciled from fresh inventory before reconnect", async (t) => {
  let resume!: () => void;
  const f = fixture(t, async (_delayMs, signal) => {
    await new Promise<void>((resolve) => {
      resume = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const sequence: string[] = [];
  f.watcher.attachLifecycle({
    reconcile: (inspect) => { sequence.push(`inventory:${inspect.State?.StartedAt ?? "initial"}`); },
    observe: (event) => { sequence.push(event.action); },
    setObserving: (value) => { sequence.push(`observing:${value}`); },
    fail: () => { throw new Error("unexpected healing failure"); }
  });
  f.watcher.start(); await until(() => f.watcher.isObserving());
  f.emit("die"); await until(() => sequence.includes("die"));
  f.end(); await until(() => resume !== undefined);
  f.setContainer({ ...container, State: { Running: false, StartedAt: "offline-start" } });
  resume(); await until(() => f.subscriptions() === 2 && f.watcher.isObserving());
  f.emitRaw({ action: "die", containerId: id, atMs: f.since()! * 1000 - 1 });
  f.emit("stop");
  const received: string[] = [];
  f.watcher.subscribe((event) => received.push(event.action));
  await until(() => received.includes("stop"));
  assert.deepEqual(sequence, ["inventory:initial", "observing:true", "die", "observing:false",
    "inventory:offline-start", "observing:true"]);
});
