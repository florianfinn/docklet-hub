import assert from "node:assert/strict";
import test from "node:test";
import {
  HUB_RUNTIME_TIMEOUT_MS, MAX_STOP_GRACE_MS, RUNTIME_READBACK_RESERVE_MS,
  RUNTIME_TRANSPORT_RESERVE_MS, containerActionTimeoutMs, stackActionTimeoutMs
} from "contract";
import { runContainer, runStack } from "./agent-client.js";

const target = { baseUrl: "http://agent.example.org", secret: "synthetic" };
const actor = { kind: "user" as const, id: "human" };
const state = { containerId: "demo", status: "running", startedAt: null, exitCode: null, health: null };

for (const scope of ["container", "stream", "fallback"] as const) {
  for (const action of ["start", "stop", "restart"] as const) {
    test(`${scope} ${action}: hub receives the maximum-duration result after 59 s queued`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
      const actionMs = scope === "container" ? containerActionTimeoutMs(action, -1)
        : stackActionTimeoutMs(action, [MAX_STOP_GRACE_MS / 1000, -1]);
      const body = scope === "container" ? { ok: true, action, outcome: "ok", state }
        : { ok: true, action, outcome: "ok", applyDefinition: false, services: [], containerIds: {} };
      let signal: AbortSignal | undefined;
      let phase = "connecting";
      let calls = 0;
      const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
      const fetchImpl: typeof fetch = async (input, init) => {
        calls++;
        if (scope === "fallback" && String(input).endsWith("-stream")) {
          return Response.json({ error: "not-found" }, { status: 404 });
        }
        signal = init!.signal!;
        return new Promise<Response>((resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new DOMException("deadline", "AbortError")), { once: true });
          void (async () => {
            phase = "queued";
            await wait(59_000);
            phase = "action";
            await wait(actionMs);
            phase = "readback";
            await wait(RUNTIME_READBACK_RESERVE_MS);
            phase = "transport";
            await wait(RUNTIME_TRANSPORT_RESERVE_MS);
            phase = "result";
            resolve(scope === "stream"
              ? new Response(JSON.stringify({ kind: "result", status: 200, body }) + "\n",
                { headers: { "content-type": "application/x-ndjson" } })
              : Response.json(body));
          })().catch(reject);
        });
      };
      const delivered: unknown[] = [];
      let receivedAt: number | undefined;
      let failure: unknown;
      const pending = (scope === "container"
        ? runContainer(target, "demo", action, {}, { actor, fetchImpl }).then((result) => { delivered.push(result); })
        : runStack(target, "demo", action, {}, { actor, fetchImpl }, {
          signal: new AbortController().signal, open: () => {}, write: async (line) => { delivered.push(line); }
        })).then(() => { receivedAt = Date.now(); }).catch((error: unknown) => { failure = error; });
      const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
      await flush();
      assert.equal(phase, "queued");
      for (const [duration, next] of [[59_000, "action"], [actionMs, "readback"],
        [RUNTIME_READBACK_RESERVE_MS, "transport"], [RUNTIME_TRANSPORT_RESERVE_MS, "result"]] as const) {
        t.mock.timers.tick(duration);
        await flush();
        assert.equal(phase, next);
        assert.equal(signal!.aborted, false);
      }
      await pending;
      assert.equal(failure, undefined);
      assert.equal(receivedAt, 59_000 + actionMs + RUNTIME_READBACK_RESERVE_MS + RUNTIME_TRANSPORT_RESERVE_MS);
      assert.ok(receivedAt! < HUB_RUNTIME_TIMEOUT_MS);
      assert.deepEqual(delivered, [scope === "container" ? body : { kind: "result", status: 200, body }]);
      t.mock.timers.tick(HUB_RUNTIME_TIMEOUT_MS);
      assert.equal(signal!.aborted, false, "completed request clears its deadline");
      assert.equal(calls, scope === "fallback" ? 2 : 1);
    });
  }
}
