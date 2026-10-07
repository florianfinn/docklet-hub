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

test("503 healing status preserves bounded state while forcing observation to unknown", async () => {
  const healingTarget = { kind: "compose", projectName: "demo", serviceName: "web" };
  const budget = { target: healingTarget, containerId: "demo-id", usedAttempts: 2, remainingAttempts: 1,
    attempts: [], nextAttemptAt: "2026-10-07T02:00:00Z", runningSince: null };
  const maintenance = { target: healingTarget, startedAt: "2026-10-07T01:00:00Z", expiresAt: null, actor: "user:demo" };
  const incident = { id: "demo-incident", target: healingTarget, containerId: "demo-id", openedAt: "2026-10-07T01:00:00Z",
    closedAt: null, closedReason: null, cause: { exitCode: 1, engineError: null }, attempts: [],
    recommendation: "inspect-container-logs-and-configuration", logs: { available: false, reason: "logs-unavailable" } };
  const result = await readLifecycleSnapshot(target, { actor: { kind: "user", id: "demo" }, fetchImpl: async (url) =>
    Response.json(String(url).endsWith("/stop-intents") ? { observing: true, intents: [], recentExits: [] }
      : { observing: true, budgets: [budget], maintenance: [maintenance], incidents: [incident], diagnostic: "private" }, { status: 503 })
  }, { applyDefinition: false, maintenanceDurationSeconds: null });
  assert.equal(result.stopIntents, null);
  assert.deepEqual(result.selfHealing, { observing: false, budgets: [budget], maintenance: [maintenance], incidents: [incident] });
});
