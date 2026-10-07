import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import test, { after } from "node:test";
import { ACTOR_HEADER, SECRET_HEADER, monitorEventLineSchema } from "contract";
import type { DockerMonitorEvent } from "./engine-model.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-monitor-fanout-"));
const secret = "s".repeat(64);
process.env.DOCKER_SOCKET_PATH = path.join(directory, "synthetic-engine-source");
process.env.DOCKER_AGENT_SECRET = secret;
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(directory, "registry.json");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(directory, "monitors.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(directory, "audit.jsonl");
const { handleRequest } = await import("./dispatch.js");
const { dockerEvents, engine, registry, monitors, stopIntents } = await import("./runtime/state.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Synthetic monitor did not settle");
    await setImmediate();
  }
}

class Response extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  status = 0;
  chunks: string[] = [];
  writeHead(status: number) { this.status = status; this.headersSent = true; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) {
    if (this.writableEnded) return;
    if (chunk) this.chunks.push(chunk);
    this.writableEnded = true;
    this.emit("close");
  }
}

async function withinDeadline(task: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([task, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Synthetic monitor task did not settle within 2000 ms")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

function openMonitor(t: test.TestContext) {
  const request = Object.assign(Readable.from([]), { url: "/monitor-events", method: "GET",
    headers: { [SECRET_HEADER]: secret, [ACTOR_HEADER]: "system:monitor" } }) as unknown as http.IncomingMessage;
  const response = new Response();
  const task = handleRequest(request, response as unknown as http.ServerResponse);
  t.after(async () => { response.end(); await withinDeadline(task); });
  return { response, task };
}

test("two Hub readers receive the full monitor vocabulary from one Docker stream with local metadata removed", { timeout: 5_000 }, async (t) => {
  const id = "a".repeat(64);
  const observedId = "b".repeat(64);
  const unknownId = "c".repeat(64);
  registry.replaceAll([{ containerId: id, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true }]);
  monitors.replaceAll([{ containerId: observedId, containerName: "demo-observed" }]);
  t.mock.method(fs, "statSync", () => ({ dev: 1n, ino: 1n, ctimeNs: 1n, isSocket: () => true }));
  let subscriptions = 0;
  let emit!: (event: DockerMonitorEvent) => void;
  t.mock.method(engine, "listContainerIds", async () => [id]);
  t.mock.method(engine, "inspect", async (containerId: string) => ({ Id: containerId,
    Name: containerId === observedId ? "/demo-observed" : "/demo-web", Config: { Labels: {} }, State: { Running: false } }));
  t.mock.method(engine, "monitorEvents", async (onEvent: typeof emit, signal?: AbortSignal, options?: { onConnected?: () => void }) => {
    subscriptions++;
    emit = onEvent;
    options?.onConnected?.();
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  t.after(() => withinDeadline(dockerEvents.stop()));
  dockerEvents.start();
  await until(() => dockerEvents.isObserving());
  const first = openMonitor(t);
  const second = openMonitor(t);
  await until(() => first.response.headersSent && second.response.headersSent);
  const actions = ["start", "stop", "restart", "create", "destroy", "die", "health_status", "oom"] as const;
  for (const action of actions) {
    for (const containerId of [id, observedId, unknownId]) emit({ action, containerId,
      containerName: containerId === observedId ? "demo-observed" : "demo-web", composeProject: "demo", composeService: "web", signal: "1" });
  }
  await until(() => first.response.chunks.length === actions.length * 2 && second.response.chunks.length === actions.length * 2);
  const expected = actions.flatMap((action) => [id, observedId].map((containerId) => ({ action, containerId })));
  for (const reader of [first, second]) {
    assert.equal(reader.response.status, 200);
    const values = reader.response.chunks.map((chunk) => JSON.parse(chunk));
    assert.deepEqual(values, expected);
    assert.equal(values.every((value) => monitorEventLineSchema.safeParse(value).success), true);
  }
  assert.equal(subscriptions, 1);
  first.response.end();
  await withinDeadline(first.task);
  emit({ action: "stop", containerId: id });
  await until(() => second.response.chunks.length === expected.length + 1);
  assert.equal(first.response.chunks.length, expected.length);
  second.response.end();
  await withinDeadline(second.task);
  emit({ action: "kill", signal: "15", containerId: id });
  emit({ action: "die", containerId: id });
  await until(() => stopIntents.list().length === 1);
  assert.equal(subscriptions, 1);
  assert.equal(dockerEvents.isObserving(), true);
  assert.equal(second.response.chunks.length, expected.length + 1);
});

test("monitor route returns 503 before the watcher starts", { timeout: 5_000 }, async (t) => {
  const reader = openMonitor(t);
  await withinDeadline(reader.task);
  assert.equal(reader.response.status, 503);
  assert.deepEqual(JSON.parse(reader.response.chunks.join("")), { error: "events-unavailable" });
});

test("losing observation closes readers, rejects readers during reconnect and serves late readers", { timeout: 5_000 }, async (t) => {
  const id = "a".repeat(64);
  registry.replaceAll([{ containerId: id, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(fs, "statSync", () => ({ dev: 1n, ino: 1n, ctimeNs: 1n, isSocket: () => true }));
  let fail = false;
  let emit!: (event: DockerMonitorEvent) => void;
  let subscriptions = 0;
  t.mock.method(engine, "listContainerIds", async () => [id]);
  t.mock.method(engine, "inspect", async () => {
    if (fail) { fail = false; throw Object.assign(new Error("inspect failed"), { status: 500 }); }
    return { Id: id, Name: "/demo-web", State: { Running: false } };
  });
  t.mock.method(engine, "monitorEvents", async (onEvent: typeof emit, signal?: AbortSignal, options?: { onConnected?: () => void }) => {
    subscriptions++;
    emit = onEvent;
    options?.onConnected?.();
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  });
  t.after(() => withinDeadline(dockerEvents.stop()));
  dockerEvents.start();
  await until(() => dockerEvents.isObserving());
  const first = openMonitor(t);
  await until(() => first.response.headersSent);
  fail = true;
  emit({ action: "die", containerId: id });
  await withinDeadline(first.task);
  assert.equal(first.response.status, 200);
  assert.equal(first.response.writableEnded, true);
  assert.equal(dockerEvents.isObserving(), false);
  const reconnecting = openMonitor(t);
  await withinDeadline(reconnecting.task);
  assert.equal(reconnecting.response.status, 503);
  await until(() => dockerEvents.isObserving() && subscriptions === 2);
  const late = openMonitor(t);
  await until(() => late.response.headersSent);
  emit({ action: "die", containerId: id });
  await until(() => late.response.chunks.length === 1);
  assert.equal(late.response.status, 200);
  assert.deepEqual(JSON.parse(late.response.chunks[0]), { action: "die", containerId: id });
});
