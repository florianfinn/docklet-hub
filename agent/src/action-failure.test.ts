import assert from "node:assert/strict";
import test from "node:test";
import { actionFailureOf } from "./action-failure.js";
import { ComposeError } from "./compose-cli.js";
import { EngineError } from "./engine.js";
import { ImageMismatchError, RecreateFailure } from "./recreate.js";

test("recreate reports the engine reason and the rollback outcome together", () => {
  const failure = actionFailureOf(
    new RecreateFailure(new EngineError("engine responded 409: {\"message\":\"network conflict\"}", 409), true, true),
    { tier: "internal" }
  );
  assert.ok(failure);
  assert.equal(failure.status, 409);
  assert.deepEqual(failure.body, {
    error: "engine-action-failed",
    engineStatus: 409,
    engineMessage: "network conflict",
    rollbackAttempted: true,
    rolledBack: true
  });
  assert.match(failure.auditReason, /rolledBack: true/);
});

test("an unknown error stays 500 but names the rollback outcome", () => {
  const failure = actionFailureOf(new RecreateFailure(new TypeError("kaputt"), true, false), {
    tier: "internal"
  });
  assert.ok(failure);
  assert.equal(failure.status, 500);
  assert.deepEqual(failure.body, {
    error: "internal-error",
    rollbackAttempted: true,
    rolledBack: false
  });
});

// The case #48 is about: four recreate calls on 2026-09-01 ended as
// "internal-error" while the engine had long since said a sentence.
test("an engine error becomes reason, engine status and audit sentence", () => {
  const failure = actionFailureOf(
    new EngineError(
      'engine responded 409: {"message":"cannot join network of a non running container 90410adc"}',
      409
    ),
    { tier: "internal" }
  );
  assert.ok(failure);
  assert.equal(failure.status, 409);
  assert.deepEqual(failure.body, {
    error: "engine-action-failed",
    engineStatus: 409,
    engineMessage: "cannot join network of a non running container 90410adc"
  });
  assert.equal(
    failure.auditReason,
    "engine-action-failed: cannot join network of a non running container 90410adc"
  );
});

// The message can carry container names and ids. It does not go outside —
// but the reason and the status do, otherwise nothing would be gained.
test("an external caller gets the engine status, not the engine sentence", () => {
  const failure = actionFailureOf(new EngineError("engine responded 409: {\"message\":\"in use by /sonarr\"}", 409), {
    tier: "external"
  });
  assert.ok(failure);
  assert.deepEqual(failure.body, { error: "engine-action-failed", engineStatus: 409 });
  // The audit sentence lives on the host and keeps it.
  assert.match(failure.auditReason, /in use by \/sonarr/);
});

test("a status outside the HTTP error range falls back to 502", () => {
  // The response size cap throws with 502, the abort with 0 — neither is an
  // answer from the engine and they must not go out as such.
  for (const status of [0, 200, 999]) {
    const failure = actionFailureOf(new EngineError("kaputt", status), { tier: "internal" });
    assert.ok(failure);
    assert.equal(failure.status, 502);
    // The raw value stays in the body: it is the information about WHAT
    // happened, even though it is unusable as an HTTP status.
    assert.equal(failure.body.engineStatus, status);
  }
});

// ⚠️ Regression guard: stderr carries host paths and image refs. It stays in
// the agent log; the stack path draws the same line.
test("a Compose error goes out without stderr", () => {
  const failure = actionFailureOf(
    new ComposeError("compose up fehlgeschlagen", "service radarr: /mnt/user/appdata/geheim.env not found", 1),
    { tier: "internal" }
  );
  assert.ok(failure);
  assert.equal(failure.status, 502);
  assert.deepEqual(failure.body, { error: "compose-action-failed", composeExitCode: 1 });
  assert.equal(JSON.stringify(failure.body).includes("geheim.env"), false);
  assert.match(failure.auditReason, /exit 1/);
});

test("a different image after creation names both ids", () => {
  const failure = actionFailureOf(new ImageMismatchError("sha256:aaa", "sha256:bbb"), { tier: "external" });
  assert.ok(failure);
  assert.equal(failure.status, 409);
  assert.deepEqual(failure.body, {
    error: "image-mismatch-after-create",
    expectedImageId: "sha256:bbb",
    actualImageId: "sha256:aaa"
  });
});

// An unexpected throw should NOT look like an orderly outcome: the caller
// rethrows, the global handler logs it and answers with 500. This separation
// is exactly why the function returns `null` instead of inventing a catch-all
// reason.
test("an unknown error stays unhandled", () => {
  assert.equal(actionFailureOf(new TypeError("x.y ist undefined"), { tier: "internal" }), null);
  assert.equal(actionFailureOf("kein Error-Objekt", { tier: "internal" }), null);
  assert.equal(actionFailureOf(null, { tier: null }), null);
});
