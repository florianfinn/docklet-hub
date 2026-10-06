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
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Synthetic event watcher did not settle");
    await setImmediate();
  }
}

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "event-watcher-test-"));
  const store = new StopIntentStore(path.join(directory, "stop-intents.json"));
  const errors: unknown[] = [];
  let emit: (event: DockerMonitorEvent) => void = () => { throw new Error("Event stream not connected"); };
  let end: () => void = () => {};
  let subscriptions = 0;
  let missing = false;
  const engine: Pick<DockerEngine, "inspect" | "listContainerIds" | "monitorEvents"> = {
    async listContainerIds() { return [id]; },
    async inspect() {
      if (missing) throw Object.assign(new Error("gone"), { status: 404 });
      return container;
    },
    async monitorEvents(onEvent, signal, options) {
      subscriptions++;
      emit = onEvent;
      options?.onConnected?.();
      await new Promise<void>((resolve) => {
        end = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
  const watcher = new DockerEventWatcher(engine, store, () => "boot-a:socket-a", (error) => { errors.push(error); });
  t.after(async () => { await watcher.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, watcher, errors, emit: (action: DockerMonitorEvent["action"]) => emit({ action, containerId: id, containerName: "demo-web" }),
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
    containerName: "demo-web", composeProject: "demo", composeService: "web" });
  await until(() => f.store.list().length === 1);
  assert.deepEqual(f.store.list()[0].target, { kind: "compose", projectName: "demo", serviceName: "web" });
});

test("storage failure marks observation unavailable and stops the watcher", async (t) => {
  const f = fixture(t);
  f.watcher.start();
  await until(() => f.watcher.isObserving());
  t.mock.method(f.store, "observe", () => { throw new Error("state write failed"); });
  f.emit("kill");
  await until(() => f.errors.length === 1);
  assert.equal(f.watcher.isObserving(), false);
});

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
