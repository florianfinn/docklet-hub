import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SELF_HEALING_CONFIG, type LiveEvent } from "contract";
import type { HostAccess, HostRecord } from "../../domain/hosts/index.js";
import { startLiveEvents } from "../../domain/live-events/index.js";
import { createSelfHealingSync } from "./self-healing-sync.js";

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Live configuration delivery did not reach the expected state");
}

test("live connections redeliver configuration and the existing probe retries failures without a host cycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const host = { id: "demo", agentUrl: "http://agent.test:8099", state: "registered" } as HostRecord;
  const order: string[] = [];
  const events: (LiveEvent | null)[] = [];
  const deliveries: string[] = [];
  let fail = true;
  let probes = 0;
  let active = 0;
  let maxActive = 0;
  let streams = 0;
  const sync = createSelfHealingSync({
    read: async () => ({ config: DEFAULT_SELF_HEALING_CONFIG, revision: 1 }),
    listHosts: async () => [host],
    send: async () => {
      active++; maxActive = Math.max(maxActive, active);
      try { order.push("configuration"); if (fail) throw new Error("offline"); }
      finally { active--; }
    },
    record: async (_hostId, _revision, status) => { deliveries.push(status); }
  });
  const live = startLiveEvents({
    hosts: { list: async () => [host], find: async () => host,
      connect: async () => ({ baseUrl: host.agentUrl, secret: "synthetic-secret" }) } as HostAccess,
    resync: async () => { order.push("registry"); },
    onConnected: async (hostId) => { assert.equal(hostId, host.id); await sync.syncHost(host, true); },
    onHostReachable: async (record) => { await sync.syncHost(record); },
    onError: () => assert.fail("Unexpected live runtime failure"),
    fetchImpl: (async (url) => {
      const route = new URL(String(url)).pathname;
      if (route === "/monitor-events") { streams++; order.push("monitor"); return new Response(new ReadableStream()); }
      if (route === "/containers") { order.push("inventory"); return Response.json({ containers: [] }); }
      if (route === "/health") { probes++; return Response.json({ ok: true }); }
      throw new Error("Unexpected agent route");
    }) as typeof fetch
  });
  live.subscribe((event) => events.push(event));
  const connected = () => events.filter((event) => event?.kind === "status" && event.status === "connected").length;
  try {
    live.start();
    await until(() => connected() === 1 && deliveries.length === 1);
    const registry = order.indexOf("registry");
    assert.ok(registry > order.indexOf("monitor"));
    assert.equal(order.slice(registry, order.indexOf("inventory") + 1).includes("configuration"), true);
    assert.equal(deliveries.every((status) => status === "failed"), true);
    assert.equal(probes, 1);
    fail = false;
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await until(() => probes === 2);
    assert.equal(deliveries.length, 1);
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await until(() => deliveries.includes("synced"));
    assert.equal(probes, 3);
    const delivered = deliveries.length;
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(5_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await until(() => probes === 4);
    assert.equal(deliveries.length, delivered);
    live.disconnectHost(host.id);
    await until(() => events.some((event) => event?.kind === "status" && event.status === "disconnected"));
    t.mock.timers.tick(1_000);
    await until(() => connected() === 2);
    assert.equal(streams, 2);
    assert.equal(deliveries.length, delivered + 1);
    assert.equal(deliveries.at(-1), "synced");
    assert.equal(maxActive, 1);
  } finally { await live.stop(); }
});
