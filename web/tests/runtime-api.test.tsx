import assert from "node:assert/strict";
import test from "node:test";
import { type HubStackActionStreamLine, type HubContainerRuntimeResult, HUB_RUNTIME_ERRORS } from "contract";
import { runContainerAction, runStackAction, runtimeActionErrorOf, runtimeActionResultOf } from "../src/features/containers/api.js";
import { ApiError } from "../src/platform/http/transport.js";

const expectedContainer = { containerId: "demo/id", status: "running", startedAt: null };
const expectedStack = { projectName: "demo", projectDir: "/srv/example/demo", composeFileName: "compose.yml",
  services: [{ ...expectedContainer, serviceName: "web" }] };
const result: HubContainerRuntimeResult = { ok: true, action: "start", outcome: "ok",
  state: { ...expectedContainer, exitCode: null, health: null } };
const stackResult = { ok: true, action: "start" as const, outcome: "ok" as const, applyDefinition: false,
  services: [{ ...result.state, serviceName: "web", outcome: "ok" as const }], containerIds: { web: "demo/id" } };

for (const action of ["start", "stop", "restart"] as const) test(`web container ${action} sends expected state, credentials and caller abort`, async (t) => {
  const caller = new AbortController();
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    assert.equal(String(input), `/api/hosts/demo%2Fhost/containers/demo%2Fid/${action}`);
    assert.equal(init.credentials, "include");
    assert.equal(init.signal === caller.signal, true);
    assert.deepEqual(JSON.parse(String(init.body)), { expectedContainer });
    return Response.json({ ...result, action });
  });
  assert.deepEqual(await runContainerAction("demo/host", "demo/id", action, expectedContainer, caller.signal), { ...result, action });
});

test("web stack stream preserves service progress and partial result with no mode from the caller", async (t) => {
  const events: HubStackActionStreamLine[] = [
    { kind: "queued" },
    { kind: "start", action: "start", projectName: "demo", applyDefinition: false },
    { kind: "progress", service: stackResult.services[0] },
    { kind: "result", status: 502, body: { ...stackResult, ok: false, outcome: "partial", error: "runtime-target-not-reached" } }
  ];
  const caller = new AbortController();
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    assert.equal(String(input), "/api/hosts/demo%2Fhost/stacks/demo%2Fid/actions/start");
    assert.equal(init.signal === caller.signal, true);
    assert.equal(init.credentials, "include");
    assert.deepEqual(JSON.parse(String(init.body)), { expectedStack });
    return new Response(events.map((line) => JSON.stringify(line)).join("\n") + "\n",
      { headers: { "content-type": "application/x-ndjson" } });
  });
  const seen: HubStackActionStreamLine[] = [];
  await runStackAction("demo/host", "demo/id", "start", expectedStack, (event) => { seen.push(event); }, caller.signal);
  assert.deepEqual(seen, events);
});

test("web exposes the sanitized container result of a 502 and rejects incomplete error results", async (t) => {
  const failed = { ...result, ok: false, outcome: "failed", error: "runtime-target-not-reached" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...failed, stderr: "private diagnostic" }, { status: 502 }));
  await assert.rejects(runContainerAction("demo", "demo", "start", expectedContainer), (error: unknown) => {
    assert.equal(error instanceof ApiError && error.status === 502, true);
    assert.equal(runtimeActionErrorOf(error), "runtime-target-not-reached");
    assert.deepEqual(runtimeActionResultOf(error), failed);
    return true;
  });
  for (const body of [{ error: "runtime-outcome-unknown" }, { ...failed, state: null },
    { ...failed, outcome: "unknown" }, { ...failed, error: "private diagnostic" }, result]) {
    assert.equal(runtimeActionResultOf(new ApiError(502, JSON.stringify(body))), null);
  }
  assert.equal(runtimeActionResultOf(new ApiError(502, "invalid JSON")), null);
  assert.equal(runtimeActionResultOf(new Error("private diagnostic")), null);
});

test("web reads synchronous stack fallback and preserves every stable HTTP error key", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(stackResult));
  const seen: HubStackActionStreamLine[] = [];
  await runStackAction("demo", "demo", "start", expectedStack, (event) => { seen.push(event); }, new AbortController().signal);
  assert.deepEqual(seen, [{ kind: "result", status: 200, body: stackResult }]);
  for (const error of new Set(HUB_RUNTIME_ERRORS)) {
    fetchMock.mock.mockImplementation(async () => Response.json({ error }, { status: 409 }));
    await assert.rejects(runContainerAction("demo", "demo", "start", expectedContainer),
      (caught: unknown) => caught instanceof ApiError && runtimeActionErrorOf(caught) === error);
    await assert.rejects(runStackAction("demo", "demo", "start", expectedStack, () => undefined, new AbortController().signal),
      (caught: unknown) => caught instanceof ApiError && runtimeActionErrorOf(caught) === error);
  }
  assert.equal(runtimeActionErrorOf(new Error("private diagnostic")), null);
});

test("web stream abort cancels the reader and an unfinished stream reports unknown outcome", async (t) => {
  const caller = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start: (stream) => stream.enqueue(new TextEncoder().encode(JSON.stringify({ kind: "start", action: "start",
      projectName: "demo", applyDefinition: false }) + "\n")), cancel: () => { cancelled = true; }
  }), { headers: { "content-type": "application/x-ndjson" } }));
  await runStackAction("demo", "demo", "start", expectedStack, () => caller.abort(), caller.signal);
  assert.equal(cancelled, true);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response("", { headers: { "content-type": "application/x-ndjson" } }));
  await assert.rejects(runStackAction("demo", "demo", "start", expectedStack, () => undefined, new AbortController().signal),
    (caught: unknown) => runtimeActionErrorOf(caught) === "runtime-stream-broken");
});
