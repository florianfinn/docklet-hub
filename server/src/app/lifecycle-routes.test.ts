import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleFixture } from "./lifecycle-routes-test-support.js";
const target = { kind: "compose", projectName: "demo", serviceName: "web" };
for (const [method, path] of [["PUT", "/self-healing/maintenance"], ["DELETE", "/self-healing/maintenance"],
  ["POST", "/self-healing/incidents/acknowledge"]]) {
  test(`${method} ${path} requires admin and trusted origin before contacting the host`, async (t) => {
    const f = await lifecycleFixture(); t.after(f.close);
    for (const role of [null, "user"]) { f.state.role = role; assert.equal((await f.call(method, path, { target })).status, role ? 403 : 401); }
    f.state.role = "admin"; assert.equal((await f.call(method, path, { target }, "cross-site")).status, 403);
    assert.equal(f.probes, 0); assert.equal(f.calls.length, 0);
  });
  test(`${method} ${path} forwards the human, strips caller actor and refreshes the project`, async (t) => {
    const f = await lifecycleFixture(); t.after(f.close);
    assert.equal((await f.call(method, path, { target, ...(method === "PUT" ? { durationSeconds: null } : {}) })).status, 200);
    assert.equal(f.calls[0].actor, "user:demo-human"); assert.equal(f.calls[0].method, method);
    assert.deepEqual(f.calls[0].body, { target, ...(method === "PUT" ? { durationSeconds: null } : {}) });
    assert.deepEqual(f.refreshes, [{ project: "demo" }]);
    assert.equal((await f.call(method, path, { target, actor: "system:hub" })).status, 400);
  });
  test(`${method} ${path} immediately rejects offline hosts, invalid input and outdated agents`, async (t) => {
    const f = await lifecycleFixture(); t.after(f.close);
    f.state.disconnected = true;
    assert.equal((await f.call(method, path, { target })).body.error, "runtime-host-offline"); assert.equal(f.probes, 0);
    f.state.disconnected = false; f.state.health = { reachable: false, error: "private diagnostic" };
    assert.equal((await f.call(method, path, { target })).body.error, "runtime-host-offline");
    f.state.health = { reachable: true, version: "0.1.0", contractVersion: 1, readOnly: false, entries: 1 };
    assert.equal((await f.call(method, path, { target })).body.error, "agent-outdated");
    assert.equal(f.calls.length, 0); assert.equal(f.refreshes.length, 0);
  });
  test(`${method} ${path} preserves stable errors without diagnostics and refreshes failed writes`, async (t) => {
    const f = await lifecycleFixture(); t.after(f.close); f.state.status = 500;
    f.state.body = { error: "internal-error", message: "private diagnostic", path: "/private" };
    assert.deepEqual((await f.call(method, path, { target })).body, { error: "internal-error" });
    assert.equal(f.refreshes.length, 1);
    f.state.body = { error: "unknown-private-diagnostic" };
    assert.deepEqual((await f.call(method, path, { target })).body, { error: "lifecycle-agent-failed" });
  });
}
test("reading requires a session and passes human attribution; 503 never means no stop intent", async (t) => {
  const f = await lifecycleFixture(); t.after(f.close); f.state.role = null;
  assert.equal((await f.call("GET", "/stop-intents")).status, 401); assert.equal(f.calls.length, 0);
  f.state.role = "user"; f.state.status = 503; f.state.body = { observing: false, intents: [], recentExits: [] };
  const unavailable = await f.call("GET", "/stop-intents");
  assert.equal(unavailable.status, 503); assert.deepEqual(unavailable.body, { error: "lifecycle-observation-unavailable" });
  assert.equal(unavailable.cache, "no-store"); assert.equal(f.calls[0].actor, "user:demo-human");
  f.state.status = 200; f.state.body = { observing: true, intents: [], recentExits: [], diagnostic: "private" };
  assert.deepEqual((await f.call("GET", "/stop-intents")).body, { observing: true, intents: [], recentExits: [] });
});
test("unavailable self-healing observation preserves known maintenance without claiming an active healer", async (t) => {
  const f = await lifecycleFixture(); t.after(f.close); f.state.status = 503;
  f.state.body = { observing: false, budgets: [], maintenance: [{ target, startedAt: "2026-10-07T01:00:00Z", expiresAt: null,
    actor: "user:demo-human" }], incidents: [], diagnostic: "private" };
  const result = await f.call("GET", "/self-healing/status");
  assert.equal(result.status, 503); assert.equal(result.body.observing, false); assert.equal(result.body.maintenance.length, 1);
  assert.equal("diagnostic" in result.body, false); assert.equal(result.cache, "no-store");
});
