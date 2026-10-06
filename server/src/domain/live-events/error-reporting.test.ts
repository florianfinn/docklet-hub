import assert from "node:assert/strict";
import test from "node:test";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { createLiveErrorReporter, LIVE_ERROR_INTERVAL_MS, type LiveRuntimeError } from "./error-reporting.js";

test("error reporting retains safe causes and throttles matching failures", () => {
  const errors: LiveRuntimeError[] = [];
  let now = 0;
  const report = createLiveErrorReporter((error) => errors.push(error), () => now);
  const transport = new AgentError("synthetic-secret http://agent.test/private", null, {
    cause: Object.assign(new Error("synthetic-private-detail"), { code: "ECONNREFUSED" })
  });
  report("monitor", transport);
  report("monitor", transport);
  now = LIVE_ERROR_INTERVAL_MS - 1;
  report("monitor", transport);
  report("reconcile", new SyntaxError("synthetic-private-record"));
  report("monitor", new AgentError("synthetic-response-body", 403));
  assert.deepEqual(errors, [
    { operation: "monitor", reason: "agent-error", code: "ECONNREFUSED", suppressed: 0 },
    { operation: "reconcile", reason: "SyntaxError", suppressed: 0 },
    { operation: "monitor", reason: "agent-error", status: 403, suppressed: 0 }
  ]);
  now++;
  report("monitor", transport);
  assert.deepEqual(errors.at(-1), { operation: "monitor", reason: "agent-error", code: "ECONNREFUSED", suppressed: 2 });
  assert.equal(JSON.stringify(errors).includes("synthetic"), false);
});

test("unknown names, codes, thrown values and cyclic causes cannot expose remote text", () => {
  const errors: LiveRuntimeError[] = [];
  const report = createLiveErrorReporter((error) => errors.push(error));
  const error = Object.assign(new Error("synthetic-secret"), { name: "synthetic-secret", code: "synthetic-secret" });
  error.cause = error;
  report("reconcile", error);
  report("reconcile", "synthetic-secret");
  assert.deepEqual(errors, [{ operation: "reconcile", reason: "unknown-error", suppressed: 0 }]);
  report("monitor", new Error("host-resync-failed"));
  assert.equal(errors.at(-1)?.reason, "host-resync-failed");
});
