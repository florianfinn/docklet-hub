import test from "node:test";
import assert from "node:assert/strict";
import { readLifecycleSnapshot } from "./snapshot.js";
const target = { baseUrl: "https://agent.example.org", secret: "example-secret" };
test("a host snapshot asks each observation once as the caller and represents 503 as unknown", async () => {
  const calls: string[] = [];
  const result = await readLifecycleSnapshot(target, { actor: { kind: "user", id: "demo" }, fetchImpl: async (url, init) => {
    calls.push(String(url)); assert.equal(new Headers(init?.headers).get("x-docker-agent-actor"), "user:demo");
    return Response.json(String(url).endsWith("/stop-intents") ? { observing: false, intents: [], recentExits: [] }
      : { observing: false, budgets: [], maintenance: [], incidents: [] }, { status: 503 });
  } }, { applyDefinition: true, maintenanceDurationSeconds: 3600 });
  assert.equal(calls.length, 2); assert.equal(result.stopIntents, null); assert.equal(result.selfHealing?.observing, false);
});
test("known empty observation is distinct from invalid or unavailable observations", async () => {
  const result = await readLifecycleSnapshot(target, { actor: { kind: "user", id: "demo" }, fetchImpl: async (url) =>
    String(url).endsWith("/stop-intents") ? Response.json({ observing: true, intents: [], recentExits: [], private: "diagnostic" })
      : Response.json({ diagnostic: "private" }, { status: 500 }) }, { applyDefinition: false, maintenanceDurationSeconds: null });
  assert.deepEqual(result.stopIntents, { observing: true, intents: [], recentExits: [] }); assert.equal(result.selfHealing, null);
});
