import { renderInDom, settle } from "./dom-harness.js";
import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import type { ContainerStats, HostContainers, HostOverview, LiveEvent, OverviewContainer } from "contract";
import { createQueryClient } from "../src/platform/query/query-client.js";
import { queryKeys } from "../src/platform/query/query-keys.js";
import { connectLiveEvents } from "../src/features/live-events/client.js";
import { readLiveEvents } from "../src/features/live-events/api.js";
import { retainHostContainers, retainHostOverview, LiveStatusLabel, MeasurementStale, type LiveState } from "../src/domain/hosts/index.js";
import { RowUsage } from "../src/features/metrics/RowUsage.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { onUnauthorized } from "../src/platform/http/session-expiry.js";

const STATS: ContainerStats = { sampledAt: "2026-01-01T00:00:00.000Z", cpuPercent: 23, memUsageBytes: 1024, memLimitBytes: 4096, samples: [] };
function overview(id: string): HostOverview {
  const container: OverviewContainer = { id: "container-" + id, name: "demo", image: "example:1", status: "running", running: true, startedAt: null, health: null, compose: null, stats: STATS, externalManagement: null, state: "ok", marks: [], system: false };
  return { host: { id, name: id, agentUrl: "http://agent.test:8099", kind: "local", state: "registered", status: "online", agentVersion: "0.32.0", tunnelAddress: null, display: { hue: "neutral", ink: "head" }, agentUpdate: null, lastSeenAt: null }, agent: { reachable: true, version: "0.32.0", contractVersion: 11, readOnly: true, entries: 1 }, stacks: [], loose: [container], error: null };
}
function streamDouble() {
  let receive: (event: LiveEvent) => void = () => undefined;
  let end = () => undefined as void;
  const signals: AbortSignal[] = [];
  const read = async (signal: AbortSignal, onEvent: (event: LiveEvent) => void) => {
    signals.push(signal); receive = onEvent;
    await new Promise<void>((resolve) => { const done = () => { signal.removeEventListener("abort", done); resolve(); }; end = done; signal.addEventListener("abort", done, { once: true }); });
  };
  return { read, signals, send: (event: LiveEvent) => receive(event), end: () => end() };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("Expected live client state did not arrive");
}

test("events refresh only the affected host and metric keys, coalescing a burst", async () => {
  const client = createQueryClient(); const stream = streamDouble(); const calls: string[] = [];
  const first = overview("first"); const second = overview("second");
  client.setQueryData(queryKeys.containers.overview(), [first, second]);
  client.setQueryData(queryKeys.hosts.containers("first"), {});
  client.setQueryData(queryKeys.hosts.containers("second"), {});
  client.setQueryData(queryKeys.metrics.containerStats("first", "a"), { stats: STATS });
  client.setQueryData(queryKeys.metrics.containerStats("second", "b"), { stats: STATS });
  const stop = connectLiveEvents(client, { read: stream.read, overview: async (id) => { calls.push(id); return { ...first, loose: [{ ...first.loose[0], running: false }] }; } });
  try {
    for (let i = 0; i < 8; i++) stream.send({ kind: "changed", hostId: "first", containerIds: ["a"], action: "stop" });
    await waitFor(() => calls.length === 1 && client.getQueryState(queryKeys.hosts.containers("first"))?.isInvalidated === true);
    assert.deepEqual(calls, ["first"]);
    const result = client.getQueryData<HostOverview[]>(queryKeys.containers.overview())!;
    assert.equal(result[0].loose[0].running, false); assert.equal(result[1] === second, true);
    assert.equal(client.getQueryState(queryKeys.hosts.containers("second"))?.isInvalidated, false);
    assert.equal(client.getQueryState(queryKeys.metrics.containerStats("first", "a"))?.isInvalidated, true);
    assert.equal(client.getQueryState(queryKeys.metrics.containerStats("second", "b"))?.isInvalidated, false);
    assert.equal(client.getQueryState(queryKeys.containers.overview())?.isInvalidated, false);
  } finally { stop(); client.clear(); }
});

test("web reconnect marks stale, rereads a snapshot, and drops removed hosts without replay", async () => {
  const client = createQueryClient(); const stream = streamDouble(); const calls: string[] = [];
  client.setQueryData(queryKeys.containers.overview(), [overview("first"), overview("removed")]);
  const stop = connectLiveEvents(client, { read: stream.read, retryMs: () => 5, overview: async (id) => { calls.push(id); return overview(id); } });
  try {
    stream.send({ kind: "status", hostId: "first", status: "connected" });
    stream.end(); await waitFor(() => stream.signals.length === 2);
    assert.equal(client.getQueryData<LiveState>(queryKeys.hosts.live())?.transport, false);
    stream.send({ kind: "snapshot", hosts: [{ hostId: "first", status: "connected" }] });
    await waitFor(() => calls.length === 1);
    assert.deepEqual(client.getQueryData<HostOverview[]>(queryKeys.containers.overview())?.map((entry) => entry.host.id), ["first"]);
    assert.equal(client.getQueryData<LiveState>(queryKeys.hosts.live())?.transport, true);
    assert.equal(stream.signals[0].aborted, true);
  } finally { stop(); client.clear(); }
  assert.equal(stream.signals.every((signal) => signal.aborted), true);
});

test("late scoped responses cannot resurrect a removed host or write after unmount", async () => {
  const client = createQueryClient(); const stream = streamDouble(); let finish = (_entry: HostOverview) => undefined as void;
  client.setQueryData(queryKeys.containers.overview(), [overview("first")]);
  const stop = connectLiveEvents(client, { read: stream.read, overview: async () => new Promise((resolve) => { finish = resolve; }) });
  try {
    stream.send({ kind: "changed", hostId: "first", containerIds: ["a"], action: "start" });
    await new Promise((resolve) => setTimeout(resolve, 170));
    stream.send({ kind: "removed", hostId: "first" }); finish(overview("first"));
    await settle();
    assert.deepEqual(client.getQueryData(queryKeys.containers.overview()), []);
    stop(); stream.send({ kind: "status", hostId: "ghost", status: "connected" });
    assert.equal(client.getQueryData<LiveState>(queryKeys.hosts.live())?.hosts.ghost, undefined);
  } finally { stop(); client.clear(); }
});

test("disconnected readings retain host load, container samples, and overview rows", () => {
  const previous = overview("first");
  const next = { ...previous, loose: [], error: "synthetic-offline", agent: { reachable: false as const, error: "synthetic-offline" } };
  assert.equal(retainHostOverview(next, previous).loose === previous.loose, true);
  const containers: HostContainers = { host: previous.host, agent: previous.agent!, containers: previous.loose, load: { cpuPercent: 23, memPercent: 25, memUsageBytes: 1024, cpuCores: 4, memTotalBytes: 4096, series: [{ sampledAt: STATS.sampledAt!, cpuPercent: 23, memPercent: 25 }] }, error: null };
  const retained = retainHostContainers({ ...containers, containers: null, load: null, error: "synthetic-offline" }, containers);
  assert.equal(retained.load === containers.load, true);
  assert.equal(retained.containers?.[0].stats === STATS, true);
});

test("happy-dom renders stale state and preserves visible measurements", async () => {
  const entry = overview("first");
  const tree = await renderInDom(<AppLanguageProvider><LiveStatusLabel hostId="first" /><RowUsage hostId="first" container={entry.loose[0]} /><MeasurementStale hostId="first" sampledAt={new Date().toISOString()} /></AppLanguageProvider>);
  try {
    assert.equal(tree.container.querySelector('[data-testid="live-stale-first"]') !== null, true);
    assert.equal(tree.container.querySelector('[data-testid="measurement-stale"]') !== null, true);
    assert.equal(tree.container.textContent?.includes("23"), true);
    await act(async () => { tree.queryClient.setQueryData(queryKeys.hosts.live(), { transport: true, hosts: { first: "connected" } }); });
    await settle();
    assert.equal(tree.container.querySelector('[data-testid="live-stale-first"]') !== null, false);
    // The old row sample remains marked even when the transport is connected.
    assert.equal(tree.container.querySelectorAll('[data-testid="measurement-stale"]').length, 1);
    assert.equal(tree.container.textContent?.includes("23"), true);
  } finally { await tree.unmount(); }
});

test("NDJSON transport validates hints, supports abort, and reports an HTTP 401", async () => {
  const original = globalThis.fetch; let unauthorized = 0; const unsubscribe = onUnauthorized(() => { unauthorized++; });
  const abort = new AbortController(); const events: LiveEvent[] = [];
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"kind":"changed","hostId":"first","containerIds":["a"],"action":"start","secret":"synthetic"}\n{"kind":"unknown"}\n'));
    } }))) as typeof fetch;
    const running = readLiveEvents(abort.signal, (event) => { events.push(event); abort.abort(); });
    await running;
    assert.deepEqual(events, [{ kind: "changed", hostId: "first", containerIds: ["a"], action: "start" }]);
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await assert.rejects(readLiveEvents(new AbortController().signal, () => undefined));
    assert.equal(unauthorized, 1);
  } finally { globalThis.fetch = original; abort.abort(); unsubscribe(); }
});

 test("a hint during the initial full overview is reread after that request finishes", async () => {
  const client = createQueryClient(); const stream = streamDouble(); const calls: string[] = [];
  const stop = connectLiveEvents(client, { read: stream.read, overview: async (id) => { calls.push(id); return overview(id); } });
  try {
    stream.send({ kind: "changed", hostId: "first", containerIds: [], action: "refresh" });
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.deepEqual(calls, []);
    client.setQueryData(queryKeys.containers.overview(), [overview("first")]);
    await waitFor(() => calls.length === 1);
    assert.deepEqual(calls, ["first"]);
  } finally { stop(); client.clear(); }
});
