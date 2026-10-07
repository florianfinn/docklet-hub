import assert from "node:assert/strict";
import test from "node:test";
import type { ContainerEntry, LiveEvent } from "contract";
import { createLiveEvents, liveBackoffMs, monitorAction, type LiveEventsDeps, type LiveHost } from "./service.js";

const HOST: LiveHost = { id: "host-1", agentUrl: "http://agent.test:8099", state: "registered" };
const CONTAINER: ContainerEntry = { id: "a", name: "web", image: "example:1", status: "running", running: true, startedAt: null, health: null, compose: { project: "demo", service: "web" }, stats: null, externalManagement: null };
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.fail("The expected asynchronous state was not reached");
}
function harness(overrides: Partial<LiveEventsDeps> = {}) {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  const events: (LiveEvent | null)[] = [];
  const delays: number[] = [];
  let releaseWait = () => undefined as void;
  let openCount = 0; let active = 0; let maxActive = 0; let reads = 0; let syncs = 0; let cancels = 0;
  const live = createLiveEvents({
    open: async (_host, signal) => {
      signals.push(signal); openCount++; active++; maxActive = Math.max(active, maxActive);
      let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      signal.addEventListener("abort", release, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => { streams.push(controller); },
        cancel: () => { cancels++; release(); signal.removeEventListener("abort", release); }
      }));
    },
    read: async () => { reads++; return [CONTAINER]; },
    resync: async () => { syncs++; },
    wait: async (ms, signal) => {
      if (ms === 150) return;
      delays.push(ms);
      await new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener("abort", done); resolve(); };
        releaseWait = done;
        if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
      });
    },
    ...overrides
  });
  live.subscribe((event) => { events.push(event); });
  return { live, events, streams, signals, delays, resume: () => releaseWait(), counts: () => ({ openCount, active, maxActive, reads, syncs, cancels }),
    send: (event: unknown) => streams.at(-1)?.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)) };
}

test("lifecycle and reduced health actions map to explicit invalidations", () => {
  for (const action of ["start", "stop", "restart", "die"] as const) assert.equal(monitorAction(action), action);
  for (const action of ["create", "destroy", "recreate"]) assert.equal(monitorAction(action), "recreate");
  assert.equal(monitorAction("health_status"), "health");
  assert.equal(monitorAction("health_status: healthy"), "health");
  assert.equal(monitorAction("rename"), null);
  assert.deepEqual([0, 1, 2, 5, 20].map(liveBackoffMs), [1000, 2000, 4000, 30000, 30000]);
});

test("one subscription per registered host fans out validated host/container events", async () => {
  const h = harness(); const other: (LiveEvent | null)[] = [];
  const unsubscribe = h.live.subscribe((event) => { other.push(event); });
  try {
    await Promise.all([h.live.reconcile([HOST]), h.live.reconcile([HOST, { ...HOST, id: "pending", state: "pending" }])]);
    await until(() => h.events.some((event) => event?.kind === "status" && event.status === "connected"));
    assert.equal(h.counts().openCount, 1);
    h.send({ action: "start", containerId: "a", secret: "synthetic" });
    h.send({ action: "stop", containerId: "b" });
    h.send({ action: "restart", containerId: "a" });
    h.send({ action: "die", containerId: "a" });
    h.send({ action: "health_status", containerId: "a" });
    h.send({ action: "create", containerId: "new" });
    h.send({ action: "rename", containerId: "a" });
    h.send({ action: "start", containerId: 42 });
    await until(() => h.events.filter((event) => event?.kind === "changed").length === 7);
    const changed = h.events.filter((event) => event?.kind === "changed");
    assert.deepEqual(changed.at(1), { kind: "changed", hostId: HOST.id, containerIds: ["a"], action: "start" });
    assert.deepEqual(other, h.events);
    assert.equal(h.counts().syncs, 2);
    unsubscribe(); h.send({ action: "start", containerId: "a" });
    await until(() => h.events.filter((event) => event?.kind === "changed").length === 8);
    assert.equal(other.filter((event) => event?.kind === "changed").length, 7);
  } finally { await h.live.stop(); }
  assert.equal(h.counts().active, 0);
  assert.equal(h.counts().cancels, 1);
});

test("EOF reconnect releases the old stream, backs off, and reads one current snapshot per connection", async () => {
  const h = harness();
  try {
    await h.live.reconcile([HOST]); await until(() => h.counts().reads === 1);
    h.streams[0].close(); await until(() => h.delays.length === 1);
    assert.equal(h.signals[0].aborted, true);
    assert.deepEqual(h.delays, [1000]);
    h.resume(); await until(() => h.counts().reads === 2);
    h.streams[1].close(); await until(() => h.delays.length === 2);
    assert.deepEqual(h.delays, [1000, 2000]);
    h.resume(); await until(() => h.counts().reads === 3);
    assert.equal(h.counts().maxActive, 1);
    assert.equal(h.counts().syncs, 3);
  } finally { await h.live.stop(); }
});

test("removal aborts the reader and a pending retry; stale reconciliation cannot revive it", async () => {
  const h = harness();
  await h.live.reconcile([HOST]); await until(() => h.counts().reads === 1);
  h.live.removeHost(HOST.id);
  await h.live.reconcile([HOST]);
  assert.equal(h.signals[0].aborted, true);
  assert.equal(h.counts().cancels, 1);
  assert.equal(h.counts().openCount, 1);
  await h.live.reconcile([]);
  await h.live.stop();
  assert.equal(h.counts().active, 0);
  assert.equal(h.delays.length, 0);
});

test("shutdown during retry prevents another connection and ends subscribers", async () => {
  const h = harness({ open: async () => { throw new Error("synthetic-unavailable"); } });
  await h.live.reconcile([HOST]); await until(() => h.delays.length === 1);
  await h.live.stop(); h.resume();
  assert.equal(h.events.at(-1), null);
  await h.live.reconcile([HOST]);
  assert.equal(h.delays.length, 1);
});

test("health failure aborts the current attempt and endpoint replacement waits for cleanup", async () => {
  const h = harness();
  try {
    await h.live.reconcile([HOST]); await until(() => h.counts().reads === 1);
    h.live.disconnectHost(HOST.id); await until(() => h.delays.length === 1);
    await h.live.reconcile([{ ...HOST, agentUrl: "http://replacement.test:8099" }]);
    await until(() => h.counts().reads === 2);
    assert.equal(h.counts().maxActive, 1);
    assert.equal(h.signals[0].aborted, true);
  } finally { await h.live.stop(); }
});

test("refresh rereads a container or stack and reports even a disappeared container", async () => {
  const h = harness({ read: async () => [CONTAINER, { ...CONTAINER, id: "b", compose: null }] });
  try {
    await h.live.reconcile([HOST]); await until(() => h.events.some((event) => event?.kind === "status" && event.status === "connected"));
    assert.deepEqual((await h.live.refresh(HOST.id, { project: "demo" })).map((entry) => entry.id), ["a"]);
    assert.deepEqual(await h.live.refresh(HOST.id, { containerId: "missing" }), []);
    assert.deepEqual(h.events.at(-1), { kind: "changed", hostId: HOST.id, containerIds: ["missing"], action: "refresh" });
    await assert.rejects(h.live.refresh("unknown", { host: true }), /host-unknown/);
  } finally { await h.live.stop(); }
});

test("snapshot failure cancels an unread body and never declares the host connected", async () => {
  const h = harness({ read: async () => { throw new Error("synthetic-read-failed"); } });
  await h.live.reconcile([HOST]); await until(() => h.delays.length === 1);
  assert.equal(h.counts().cancels, 1);
  assert.equal(h.events.some((event) => event?.kind === "status" && event.status === "connected"), false);
  await h.live.stop();
});

test("action follow-up waits for an older in-flight snapshot before starting a new read", async () => {
  let finish = () => undefined as void; let reads = 0;
  const h = harness({ read: async () => {
    reads++;
    if (reads === 1) await new Promise<void>((resolve) => { finish = resolve; });
    return [{ ...CONTAINER, running: reads === 1 }];
  } });
  try {
    await h.live.reconcile([HOST]); await until(() => reads === 1);
    const refreshed = h.live.refresh(HOST.id, { containerId: "a" });
    assert.equal(reads, 1); finish();
    assert.equal((await refreshed)[0].running, false);
    assert.equal(reads, 2);
  } finally { finish(); await h.live.stop(); }
});

test("recreate bursts batch registry syncs without blocking later monitor events", async () => {
  const windows: number[] = [];
  let finishWindow = () => undefined as void;
  let finishSync = () => undefined as void;
  let syncs = 0;
  const h = harness({
    wait: async (ms, signal) => {
      windows.push(ms);
      await new Promise<void>((resolve) => {
        const done = () => { signal.removeEventListener("abort", done); resolve(); };
        finishWindow = done;
        signal.addEventListener("abort", done, { once: true });
      });
    },
    resync: async () => {
      syncs++;
      if (syncs === 2) await new Promise<void>((resolve) => { finishSync = resolve; });
    }
  });
  try {
    await h.live.reconcile([HOST]);
    await until(() => h.events.some((event) => event?.kind === "status" && event.status === "connected"));
    for (let i = 0; i < 20; i++) h.send({ action: "create", containerId: `new-${i}` });
    h.send({ action: "stop", containerId: "a" });
    await until(() => h.events.some((event) => event?.kind === "changed" && event.action === "stop"));
    assert.equal(syncs, 1);
    assert.deepEqual(windows, [150]);
    finishWindow(); await until(() => syncs === 2);
    for (let i = 0; i < 20; i++) h.send({ action: "destroy", containerId: `old-${i}` });
    h.send({ action: "start", containerId: "a" });
    await until(() => h.events.some((event) => event?.kind === "changed" && event.action === "start"));
    assert.equal(syncs, 2);
    finishSync(); await until(() => windows.length === 2);
    finishWindow(); await until(() => syncs === 3);
    await until(() => h.events.filter((event) => event?.kind === "changed" && event.action === "recreate").length === 2);
    assert.deepEqual(h.events.filter((event) => event?.kind === "changed" && event.action === "recreate"), [
      { kind: "changed", hostId: HOST.id, containerIds: [], action: "recreate" },
      { kind: "changed", hostId: HOST.id, containerIds: [], action: "recreate" }
    ]);
  } finally { finishSync(); await h.live.stop(); }
});

test("shutdown cancels a pending recreate window without starting a registry sync", async () => {
  let windows = 0;
  const h = harness({ wait: async (_ms, signal) => {
    windows++;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  } });
  await h.live.reconcile([HOST]); await until(() => h.counts().reads === 1);
  h.send({ action: "create", containerId: "new" });
  await until(() => windows === 1);
  await h.live.stop();
  assert.equal(h.counts().syncs, 1);
});

test("inventory refresh after a successful cycle reads and emits without another registry sync", async () => {
  const h = harness();
  try {
    await h.live.reconcile([HOST]); await until(() => h.counts().reads === 1);
    assert.deepEqual(await h.live.refresh(HOST.id, { host: true }, { resync: false }), [CONTAINER]);
    assert.equal(h.counts().syncs, 1);
    assert.equal(h.counts().reads, 2);
    assert.deepEqual(h.events.at(-1), { kind: "changed", hostId: HOST.id, containerIds: ["a"], action: "refresh" });
    await h.live.refresh(HOST.id, { host: true });
    assert.equal(h.counts().syncs, 2);
  } finally { await h.live.stop(); }
});

test("a failed asynchronous recreate sync reports its cause and disconnects the monitor", async () => {
  const failure = new Error("synthetic-sync-failure");
  const reported: unknown[] = [];
  let syncs = 0;
  const h = harness({
    resync: async () => { if (++syncs === 2) throw failure; },
    onError: (error) => { reported.push(error); }
  });
  try {
    await h.live.reconcile([HOST]); await until(() => h.counts().reads === 1);
    h.send({ action: "create", containerId: "new" });
    await until(() => h.delays.length === 1);
    assert.deepEqual(reported, [failure]);
    assert.equal(h.signals[0].aborted, true);
    assert.equal(h.events.some((event) => event?.kind === "status" && event.status === "disconnected"), true);
  } finally { await h.live.stop(); }
});

test("probe disconnect and host removal are observable through live events", async () => {
  const h = harness();
  try {
    await h.live.reconcile([HOST]);
    await until(() => h.events.some((event) => event?.kind === "status" && event.status === "connected"));
    h.live.disconnectHost(HOST.id);
    await until(() => h.events.some((event) => event?.kind === "status" && event.status === "disconnected"));
    h.live.removeHost(HOST.id);
    assert.deepEqual(h.events.at(-1), { kind: "removed", hostId: HOST.id });
  } finally { await h.live.stop(); }
});
