import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { StreamFetchError } from "../../platform/agent-transport/stream-fetch.js";
import { runContainer, runStack } from "./agent-client.js";
import { runtimeRejection } from "./rejections.js";
import { RUNTIME_TIMEOUT_MS } from "./transport.js";

const target = { baseUrl: "http://agent.example.org", secret: "synthetic" };
const actor = { kind: "user" as const, id: "human" };
const state = { containerId: "demo", status: "running", startedAt: null, exitCode: null, health: null };
const result = { ok: true, action: "start", outcome: "ok", state };
const stackResult = { ok: true, action: "start", outcome: "ok", applyDefinition: false,
  services: [], containerIds: {} };

for (const scope of ["container", "stream", "fallback"] as const) {
  function run(fetchImpl: typeof fetch) {
    const options = { actor, fetchImpl };
    if (scope === "container") return runContainer(target, "demo", "start", {}, options);
    const signal = new AbortController().signal;
    return runStack(target, "demo", "start", {}, options, { signal, open: () => {}, write: async () => {} });
  }
  function injection(fail: typeof fetch): typeof fetch {
    return async (input, init) => scope === "fallback" && String(input).endsWith("-stream")
      ? Response.json({ error: "not-found" }, { status: 404 }) : fail(input, init);
  }

  test(`${scope} waits beyond 300 seconds and only expires at the runtime deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal: AbortSignal | undefined;
    let finish!: (response: Response) => void;
    const pending = run(injection(async (_input, init) => {
      signal = init!.signal!;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    // The fallback needs to finish its rejected stream response first.
    for (let i = 0; i < 20 && !signal; i++) await Promise.resolve();
    assert.equal(signal !== undefined, true);
    t.mock.timers.tick(300_001);
    assert.equal(signal!.aborted, false);
    finish(Response.json(scope === "container" ? result : stackResult));
    await pending;
  });

  test(`${scope} timeout after sending reports an unknown outcome without retry`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    let sent = false;
    let signal: AbortSignal | undefined;
    const pending = run(injection(async (_input, init) => {
      calls++;
      sent = true;
      signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("deadline", "AbortError")), { once: true });
      });
    }));
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.equal(error instanceof AgentError, true);
      assert.deepEqual(runtimeRejection(error as AgentError, scope !== "container"),
        { status: 502, body: { error: "runtime-outcome-unknown" } });
      return true;
    });
    for (let i = 0; i < 20 && !sent; i++) await Promise.resolve();
    assert.equal(sent, true);
    t.mock.timers.tick(RUNTIME_TIMEOUT_MS - 1);
    assert.equal(signal!.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal!.aborted, true);
    await rejected;
    assert.equal(calls, 1);
  });

  for (const sent of [false, true]) test(`${scope} connection break ${sent ? "after" : "before"} sending is classified separately`, async () => {
    let calls = 0;
    await assert.rejects(run(injection(async () => {
      calls++;
      throw new StreamFetchError(new Error("private diagnostic"), sent);
    })), (error: unknown) => {
      assert.deepEqual(runtimeRejection(error as AgentError, scope !== "container"), { status: 502,
        body: { error: sent ? "runtime-outcome-unknown" : "runtime-agent-unreachable" } });
      return true;
    });
    assert.equal(calls, 1);
  });

  test(`${scope} a broken response body after headers has an unknown outcome`, async () => {
    await assert.rejects(run(injection(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("private diagnostic")); }
    }), { headers: { "content-type": "application/json" } }))), (error: unknown) => {
      assert.deepEqual(runtimeRejection(error as AgentError, scope !== "container").body,
        { error: "runtime-outcome-unknown" });
      return true;
    });
  });
}

test("runtime requests default to streamFetch without an implicit header deadline", () => {
  const source = readFileSync(new URL("../../platform/agent-transport/runtime-transport.ts", import.meta.url), "utf8");
  assert.match(source, /fetchImpl: typeof fetch = streamFetch/);
  assert.doesNotMatch(source, /\?\? fetch\b/);
});
