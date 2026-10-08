import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import type { HostRecord } from "../../domain/hosts/index.js";
import { createUpdateRecovery } from "./recovery.js";
import * as client from "./agent-client.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
const target = { baseUrl: "https://agent.example.org", secret: "synthetic" };
const options = { actor: { kind: "system", name: "hub" } as const };
test("job queries encode stable target JSON and validate every agent response", async () => {
  const scope = { kind: "compose", projectName: "demo", serviceName: "web" } as const;
  let called = "";
  const result = await client.list(target, { kind: "update", target: scope }, { ...options, fetchImpl: async (url) => {
    called = String(url); return Response.json({ active: [], recent: [] });
  } });
  assert.deepEqual(result, { active: [], recent: [] }); assert.deepEqual(JSON.parse(new URL(called).searchParams.get("target")!), scope);
  await assert.rejects(client.progress(target, "job", { ...options, fetchImpl: async () => Response.json({ progress: {} }) }), AgentError);
  await assert.rejects(client.start(target, {} as never, { ...options, fetchImpl: async () => Response.json({ jobId: "job", result: {} }) }), AgentError);
});
test("startup/reconnect discovers unknown jobs through the list and coalesces concurrent probes", async (t) => {
  let calls = 0; let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(globalThis, "fetch", async () => { calls++; await wait; return Response.json({ active: [], recent: [] }); });
  const pool = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const recovery = createUpdateRecovery({ pool, connect: async () => target }); const host = { id: "host" } as HostRecord;
  const first = recovery.syncHost(host); const second = recovery.syncHost(host);
  assert.equal(first, second); release(); await first; assert.equal(calls, 1);
  await recovery.syncHost(host); assert.equal(calls, 2);
});
