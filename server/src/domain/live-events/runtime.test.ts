import assert from "node:assert/strict";
import test from "node:test";
import { ACTOR_HEADER, SECRET_HEADER, CONTRACT_VERSION, type LiveEvent } from "contract";
import type { HostAccess, HostRecord } from "../hosts/index.js";
import { startLiveEvents } from "./runtime.js";

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise<void>((resolve) => setImmediate(resolve)); }
  assert.fail("Runtime did not reach the expected state");
}
test("runtime opens exactly one monitor as system:monitor and reads inventory as system:hub", async () => {
  const host = { id: "host-1", agentUrl: "http://agent.test:8099", state: "registered" } as HostRecord;
  const calls: { path: string; actor: string | null; secret: string | null }[] = [];
  let cancelled = false;
  const events: (LiveEvent | null)[] = [];
  const live = startLiveEvents({
    hosts: { list: async () => [host], find: async () => host, connect: async () => ({ baseUrl: host.agentUrl, secret: "synthetic-secret" }) } as HostAccess,
    resync: async () => undefined,
    onError: () => assert.fail("Unexpected runtime failure"),
    fetchImpl: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      calls.push({ path, actor: headers.get(ACTOR_HEADER), secret: headers.get(SECRET_HEADER) });
      if (path === "/monitor-events") return new Response(new ReadableStream({ cancel: () => { cancelled = true; } }));
      if (path === "/containers") return Response.json({ containers: [] });
      if (path === "/health") return Response.json({ ok: true, version: "0.32.0", contractVersion: CONTRACT_VERSION });
      throw new Error("Unexpected agent path");
    }) as typeof fetch
  });
  live.subscribe((event) => { events.push(event); });
  try {
    live.start(); live.start();
    await until(() => events.some((event) => event?.kind === "status" && event.status === "connected"));
    assert.deepEqual(calls.filter((call) => call.path === "/monitor-events"), [{ path: "/monitor-events", actor: "system:monitor", secret: "synthetic-secret" }]);
    assert.equal(calls.find((call) => call.path === "/containers")?.actor, "system:hub");
    assert.equal(calls.find((call) => call.path === "/health")?.secret, null);
  } finally { await live.stop(); }
  assert.equal(cancelled, true);
});

test("runtime reports reconciliation failures with safe causes and throttles repeated ticks", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const errors: unknown[] = [];
  let lists = 0;
  const live = startLiveEvents({
    hosts: { list: async () => { lists++; throw new SyntaxError("synthetic-secret"); } } as unknown as HostAccess,
    resync: async () => undefined,
    onError: (error) => { errors.push(error); }
  });
  try {
    live.start(); await until(() => lists === 1 && errors.length === 1);
    for (let i = 0; i < 6; i++) {
      context.mock.timers.tick(5_000);
      await until(() => lists === i + 2);
    }
    assert.deepEqual(errors, [
      { hostId: null, operation: "reconcile", reason: "SyntaxError", suppressed: 0 },
      { hostId: null, operation: "reconcile", reason: "SyntaxError", suppressed: 5 }
    ]);
  } finally { await live.stop(); }
});

test("a failed health probe aborts an otherwise silent monitor and reconnects", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const host = { id: "host-1", agentUrl: "http://agent.test:8099", state: "registered" } as HostRecord;
  const signals: AbortSignal[] = [];
  let probes = 0;
  let healthy = true;
  const events: (LiveEvent | null)[] = [];
  const live = startLiveEvents({
    hosts: { list: async () => [host], find: async () => host, connect: async () => ({ baseUrl: host.agentUrl, secret: "synthetic-secret" }) } as HostAccess,
    resync: async () => undefined,
    onError: () => assert.fail("Unexpected runtime failure"),
    fetchImpl: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/monitor-events") {
        signals.push(init!.signal!);
        return new Response(new ReadableStream());
      }
      if (path === "/containers") return Response.json({ containers: [] });
      if (path === "/health") {
        probes++;
        return healthy ? Response.json({ ok: true }) : new Response(null, { status: 503 });
      }
      throw new Error("Unexpected path");
    }) as typeof fetch
  });
  live.subscribe((event) => events.push(event));
  try {
    live.start();
    await until(() => events.some((event) => event?.kind === "status" && event.status === "connected") && probes === 1);
    for (let i = 0; i < 2; i++) { context.mock.timers.tick(5_000); await new Promise<void>((resolve) => setImmediate(resolve)); }
    assert.equal(signals[0].aborted, false);
    healthy = false;
    context.mock.timers.tick(5_000);
    await until(() => signals[0].aborted && events.some((event) => event?.kind === "status" && event.status === "disconnected"));
    assert.equal(probes, 2);
    healthy = true;
    context.mock.timers.tick(1_000);
    await until(() => signals.length === 2);
  } finally { await live.stop(); }
});
