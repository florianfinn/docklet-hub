import test from "node:test";
import assert from "node:assert/strict";

import { AgentError } from "../../platform/agent-transport/protocol.js";
import { describeSessionRejection, describeStartRejection, execRejectionKey, SESSION_UNKNOWN_MESSAGE } from "./rejections.js";

// The tables of the agent's refusals, checked without Express (#260): they
// return what the route writes, `{ status, error, message }`.

test("execRejectionKey trifft auch die beiden Schlüssel mit angehängtem Text", () => {
  // ⚠️ `self-management-locked: <directory>` und `hardening-violated: …`
  // tragen einen Zusatz hinter einem Doppelpunkt. Wer sie mit `===`
  // vergleicht, trifft sie NIE — der Zweig läuft ins `default`, und der
  // Betreiber bekommt eine pauschale Ablehnung.
  assert.equal(execRejectionKey("no-shell"), "no-shell");
  assert.equal(execRejectionKey("self-management-locked: /opt/stacks/hub"), "self-management-locked");
  assert.equal(execRejectionKey("hardening-violated: privileged"), "hardening-violated");
  assert.equal(execRejectionKey(" too-many-sessions "), "too-many-sessions");
  assert.equal(execRejectionKey(""), null);
  assert.equal(execRejectionKey(": nur-zusatz"), null);
  assert.equal(execRejectionKey(undefined), null);
  assert.equal(execRejectionKey(42), null);
});

/** A refusal as `openExecStream` builds it: status plus the parsed body. */
function refusal(status: number, error: unknown): AgentError {
  return new AgentError(`agent said ${status}`, status, { detail: { error } });
}

test("derselbe Status heißt an der Stromroute je nach Schlüssel etwas anderes", () => {
  // `409` is two different things; the key decides, not the status.
  assert.deepEqual(
    [describeStartRejection(refusal(409, "container-not-started")).error, describeStartRejection(refusal(409, "no-shell")).error],
    ["container-not-running", "no-shell"]
  );
  assert.deepEqual(
    [describeStartRejection(refusal(404, "container-gone")).error, describeStartRejection(refusal(403, "not-allowlisted")).error],
    ["container-unknown", "agent-forbidden"]
  );
  assert.equal(describeStartRejection(refusal(429, "too-many-sessions")).error, "too-many-sessions");
  assert.equal(describeStartRejection(refusal(503, "agent-read-only")).status, 503);
});

test("observe-only des Agenten ab v0.30.0 hat an der Stromroute und an den kurzen Routen einen eigenen Text (#234)", () => {
  const start = describeStartRejection(refusal(403, "observe-only"));
  const session = describeSessionRejection(refusal(403, "observe-only"));
  assert.equal(start.status, 403);
  assert.equal(start.error, "container-observe-only");
  assert.equal(session.error, "container-observe-only");
  assert.notEqual(start.error, describeStartRejection(refusal(403, "not-allowlisted")).error);
  assert.notEqual(start.message, session.message, "opening and typing are two different situations");
  // Any other 403 at a short call still is a vague one, not the observer class.
  assert.equal(describeSessionRejection(refusal(403, "hardening-violated")).error, "agent-unreachable");
});

test("ein Schlüssel mit angehängtem Text nennt den rohen Wert im Satz", () => {
  const rejection = describeStartRejection(refusal(403, "self-management-locked: /opt/stacks/hub"));
  assert.equal(rejection.error, "agent-forbidden");
  assert.match(rejection.message, /\(self-management-locked: \/opt\/stacks\/hub\)$/);
});

test("ein Schlüssel, den die Tabelle nicht führt, ist ein stummer Arm", () => {
  const rejection = describeStartRejection(refusal(418, "teekanne"));
  assert.equal(rejection.status, 502);
  assert.equal(rejection.error, "agent-unreachable");
  // No detail at all (a stream other than exec) lands in the same place.
  assert.equal(describeStartRejection(new AgentError("down", null)).error, "agent-unreachable");
});

test("an den drei kurzen Routen: unbekannt, zu groß und nur lesen haben je eine eigene Antwort", () => {
  assert.deepEqual(describeSessionRejection(refusal(404, "session-unknown")), {
    status: 404,
    error: "session-unknown",
    message: SESSION_UNKNOWN_MESSAGE
  });
  assert.equal(describeSessionRejection(refusal(413, "input-too-large")).error, "input-too-large");
  // The status alone is enough for a `413` and a `503` without a body.
  assert.equal(describeSessionRejection(new AgentError("too big", 413)).error, "input-too-large");
  assert.equal(describeSessionRejection(new AgentError("read only", 503)).error, "agent-read-only");
  assert.equal(describeSessionRejection(new AgentError("down", null)).error, "agent-unreachable");
});
