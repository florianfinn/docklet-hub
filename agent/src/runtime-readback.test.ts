import assert from "node:assert/strict";
import test from "node:test";
import { actionFailureOf, RuntimeActionFailure } from "./action-failure.js";
import { ComposeError } from "./compose-cli.js";
import { EngineError } from "./engine.js";
import { runtimeReadback } from "./runtime-readback.js";

const resultBody = (state: string) => ({ ok: state === "running", state });

test("a failed mutation and failed read-back preserve both diagnostics and the primary classification", async () => {
  const stderr = "stderr-" + "x".repeat(400);
  await assert.rejects(runtimeReadback(
    async () => { throw new ComposeError("stop failed", stderr, 17); },
    async () => { throw new EngineError("read-back unavailable", 503); },
    () => "unknown", resultBody
  ), (error: unknown) => {
    assert.ok(error instanceof RuntimeActionFailure);
    const failure = actionFailureOf(error, true);
    assert.equal(failure.status, 502);
    assert.deepEqual(failure.body, { ok: false, state: "unknown", error: "compose-action-failed" });
    assert.ok(failure.auditReason.includes(stderr));
    assert.match(failure.auditReason, /exit 17/);
    assert.match(failure.auditReason, /read-back: engine-action-failed: read-back unavailable/);
    return true;
  });
});

test("recovery failures preserve each diagnosis without exposing either in the runtime body", () => {
  const failure = actionFailureOf(new AggregateError([
    new EngineError("stop unavailable", 503), new ComposeError("recovery start failed", "recovery stderr", 9)
  ]), true);
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: "engine-action-failed", engineStatus: 503 });
  assert.match(failure.auditReason, /stop unavailable/);
  assert.match(failure.auditReason, /exit 9.*recovery start failed.*recovery stderr/);
});
