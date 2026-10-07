import assert from "node:assert/strict";
import test from "node:test";
import { HUB_RUNTIME_ERRORS, hubContainerRuntimeResultSchema, hubStackActionStreamLineSchema } from "contract";
import { fixture, EXPECTED, STACK, ID, containerResult, stackResult } from "./runtime-actions-test-support.js";

for (const stack of [false, true]) for (const action of ["start", "stop", "restart"] as const)
  test(`${stack ? "stack" : "container"} ${action} checks admin and origin before agent contact`, async (t) => {
    const f = await fixture(); t.after(f.close);
    for (const role of [null, "user"]) {
      f.state.role = role;
      assert.equal((await f.call(stack, action)).status, role === null ? 401 : 403);
    }
    f.state.role = "admin";
    assert.equal((await f.call(stack, action, undefined, "cross-site")).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal(f.probes, 0);
    assert.equal(f.refreshes.length, 0);
  });

for (const stack of [false, true]) for (const action of ["start", "stop", "restart"] as const)
  test(`${stack ? "stack" : "container"} ${action} forwards the human, expected state and only the applicable setting`, async (t) => {
    const f = await fixture(); t.after(f.close);
    for (const mode of [false, true]) {
      f.state.mode = mode;
      const response = await f.call(stack, action);
      assert.equal(response.status, 200);
      if (stack) assert.deepEqual(hubStackActionStreamLineSchema.parse(response.body[0]), response.body[0]);
      else assert.deepEqual(hubContainerRuntimeResultSchema.parse(response.body), response.body);
      const sent = f.calls.at(-1)!;
      assert.equal(sent.actor, "user:demo-human");
      assert.equal(sent.secret, "s".repeat(32));
      assert.deepEqual(sent.body, stack ? { expectedStack: STACK, ...(action === "stop" ? {} : { applyDefinition: mode }) }
        : { expectedContainer: EXPECTED });
      assert.equal(sent.path, stack ? `/stacks/${ID}/actions/${action}-stream` : `/containers/${ID}/${action}`);
      assert.deepEqual(f.refreshes.at(-1), { hostId: "demo-host", target: stack ? { project: "demo" } : { containerId: ID } });
    }
  });

for (const stack of [false, true]) test(`${stack ? "stack" : "container"} offline, disconnected and outdated hosts never reach the agent`, async (t) => {
  const f = await fixture(); t.after(f.close);
  f.state.live = "disconnected";
  assert.deepEqual(await f.call(stack).then(({ status, body }) => ({ status, body })),
    { status: 503, body: { error: "runtime-host-offline" } });
  assert.equal(f.probes, 0);
  f.state.live = "connected";
  f.state.health = { reachable: false, error: "private diagnostic" };
  assert.equal((await f.call(stack)).body.error, "runtime-host-offline");
  f.state.health = { reachable: true, version: "0.1.0", contractVersion: 1, readOnly: false, entries: 1 };
  assert.equal((await f.call(stack)).body.error, "agent-outdated");
  assert.equal(f.calls.length, 0);
  assert.equal(f.refreshes.length, 3);
});

for (const stack of [false, true]) test(`${stack ? "stack" : "container"} invalid expectations cannot execute`, async (t) => {
  const f = await fixture(); t.after(f.close);
  for (const body of [{}, { expectedContainer: { ...EXPECTED, startedAt: 123 } }, { expectedStack: { ...STACK, services: 1 } }]) {
    assert.equal((await f.call(stack, "start", body)).body.error, "invalid-input");
  }
  assert.equal((await f.call(stack, "apply")).body.error, "invalid-input");
  assert.equal(f.calls.length, 0);
});

for (const stack of [false, true]) test(`${stack ? "stack" : "container"} every stable agent refusal is preserved without diagnostics or fallback`, async (t) => {
  const f = await fixture(); t.after(f.close);
  for (const error of new Set(HUB_RUNTIME_ERRORS)) {
    f.state.agent = (_request, response) => response.status(error === "state-changed" ? 409 : 502)
      .json({ error, stderr: "private diagnostic", message: "private diagnostic", details: { path: "/private" } });
    const result = await f.call(stack);
    assert.equal(result.status, error === "state-changed" ? 409 : 502);
    assert.deepEqual(result.body, { error });
    assert.equal(result.text.includes("private diagnostic"), false);
    assert.deepEqual(f.refreshes.at(-1)?.target, stack ? { project: "demo" } : { containerId: ID });
  }
  f.state.agent = (_request, response) => response.status(404).json({ error: "container-gone" });
  const before = f.calls.length;
  assert.equal((await f.call(stack)).body.error, "container-gone");
  assert.equal(f.calls.length - before, 2);
  f.state.agent = (_request, response) => response.status(500).json({ error: "private diagnostic" });
  assert.deepEqual((await f.call(stack)).body, { error: "runtime-agent-failed" });
});

test("container error results and stack partial progress retain state and drop diagnostics", async (t) => {
  const f = await fixture(); t.after(f.close);
  const failed = { ...containerResult(), ok: false, outcome: "failed", error: "runtime-target-not-reached" };
  f.state.agent = (_request, response) => response.status(502).json({ ...failed, stderr: "private diagnostic" });
  assert.deepEqual((await f.call()).body, failed);
  const partial = { ...stackResult(), ok: false, outcome: "partial", error: "runtime-target-not-reached" };
  const events = [{ kind: "start", action: "start", projectName: "demo", applyDefinition: true },
    { kind: "progress", service: partial.services[0] }, { kind: "result", status: 502, body: partial }];
  f.state.agent = (_request, response) => response.type("application/x-ndjson")
    .end(events.map((line) => JSON.stringify({ ...line, stderr: "private diagnostic" })).join("\n") + "\n");
  assert.deepEqual((await f.call(true)).body, events);
  assert.equal(f.refreshes.length, 2);
});

test("stack streamed error retains recovered service results and sanitizes reason and body", async (t) => {
  const f = await fixture(); t.after(f.close);
  const result = { ...stackResult(), ok: false, error: "engine-action-failed" };
  f.state.agent = (_request, response) => response.type("application/x-ndjson").end([
    { kind: "start", action: "start", projectName: "demo", applyDefinition: true },
    { kind: "error", reason: "engine-action-failed", status: 503, body: { ...result, stderr: "private diagnostic" } }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.deepEqual((await f.call(true)).body[1], { kind: "error", reason: "engine-action-failed", status: 503, body: result });
  assert.equal(f.refreshes.length, 1);
});

test("only an unknown stream route falls back synchronously, without changing the request", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.state.agent = (request, response) => request.path.endsWith("-stream")
    ? response.status(404).json({ error: "not-found" }) : response.json(stackResult());
  assert.deepEqual((await f.call(true)).body, [{ kind: "result", status: 200, body: stackResult() }]);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[1].body, f.calls[2].body);
  assert.equal(f.calls[2].actor, "user:demo-human");
  assert.equal(f.refreshes.length, 1);
});

test("JSON fallback at the stream endpoint and malformed results remain bounded hub responses", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.state.agent = (_request, response) => response.json(stackResult());
  assert.deepEqual((await f.call(true)).body, [{ kind: "result", status: 200, body: stackResult() }]);
  f.state.agent = (_request, response) => response.json({ ok: true, private: "private diagnostic" });
  assert.deepEqual((await f.call(true)).body, { error: "runtime-invalid-response" });
  assert.deepEqual((await f.call()).body, { error: "runtime-invalid-response" });
  assert.equal(f.refreshes.length, 3);
});

test("a stack stream ending without a result reports an unknown outcome and refreshes", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.state.agent = (_request, response) => response.type("application/x-ndjson")
    .end(JSON.stringify({ kind: "start", action: "start", projectName: "demo", applyDefinition: true }) + "\n");
  const result = await f.call(true);
  assert.deepEqual(result.body.at(-1), { kind: "error", reason: "runtime-stream-broken" });
  assert.equal(f.refreshes.length, 1);
});

for (const kind of ["container", "stream", "fallback"] as const)
  test(`browser disconnect cancels the agent ${kind} request and triggers refresh`, { timeout: 5000 }, async (t) => {
    const f = await fixture(); t.after(f.close);
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let ended!: () => void;
    const closed = new Promise<void>((resolve) => { ended = resolve; });
    f.state.agent = (request, response) => {
      if (kind === "fallback" && request.path.endsWith("-stream")) {
        response.status(404).json({ error: "not-found" }); return;
      }
      response.on("close", ended);
      if (kind === "stream") {
        response.type("application/x-ndjson");
        response.write(JSON.stringify({ kind: "start", action: "start", projectName: "demo", applyDefinition: true }) + "\n");
      }
      started();
    };
    const controller = new AbortController();
    const pending = fetch(`${f.url}/hosts/demo-host/${kind === "container" ? "containers" : "stacks"}/${ID}/${kind === "container" ? "" : "actions/"}start`,
      { method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(kind === "container" ? { expectedContainer: EXPECTED } : { expectedStack: STACK }) })
      .then((response) => response.text()).catch(() => undefined);
    t.after(() => controller.abort());
    await entered;
    controller.abort();
    await closed;
    await pending;
    // Completing another request yields through the abort handler without timing-based polling.
    f.state.agent = (_request, response) => response.json(containerResult());
    await f.call();
    assert.equal(f.refreshes.length >= 1, true);
    assert.equal(f.calls.filter((call) => call.path.includes("start")).length, kind === "fallback" ? 3 : 2);
  });

test("seen state and caller fields cannot override the session actor or saved stack mode", async (t) => {
  const f = await fixture(); t.after(f.close);
  const stale = { ...EXPECTED, status: "exited", startedAt: null };
  await f.call(false, "start", { expectedContainer: stale, actor: "system:hub", applyDefinition: true });
  assert.deepEqual(f.calls.at(-1)?.body, { expectedContainer: stale });
  assert.equal(f.calls.at(-1)?.actor, "user:demo-human");
  f.state.mode = false;
  const expectedStack = { ...STACK, services: [{ serviceName: "web", ...stale }] };
  await f.call(true, "restart", { expectedStack, actor: "system:hub", applyDefinition: true });
  assert.deepEqual(f.calls.at(-1)?.body, { expectedStack, applyDefinition: false });
});

test("transport failures and management-lock diagnostics become stable hub keys", async (t) => {
  const f = await fixture(); t.after(f.close);
  f.state.agent = (_request, response) => response.destroy();
  assert.deepEqual((await f.call()).body, { error: "runtime-agent-unreachable" });
  assert.deepEqual((await f.call(true)).body, { error: "runtime-agent-unreachable" });
  f.state.agent = (_request, response) => response.status(403).json({ error: "self-management-locked: /private/diagnostic" });
  assert.deepEqual((await f.call()).body, { error: "self-management-locked" });
  assert.deepEqual((await f.call(true)).body, { error: "self-management-locked" });
  assert.equal(f.refreshes.length, 4);
});
