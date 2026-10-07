import assert from "node:assert/strict";
import test from "node:test";
import { actionAuditReason } from "./action-audit.js";

test("action audit combines changing gate evidence once between the key and diagnosis", () => {
  const delegation = new Set([
    "delegation-lock-allowed: privileged,host-namespace",
    "delegation-lock-allowed: docker-socket-mount,privileged"
  ]);
  assert.equal(actionAuditReason(delegation, "engine-action-failed: synthetic diagnostic", "engine-action-failed"),
    "engine-action-failed; delegation-lock-allowed: docker-socket-mount,host-namespace,privileged; synthetic diagnostic");
  assert.equal(actionAuditReason(delegation), "delegation-lock-allowed: docker-socket-mount,host-namespace,privileged");
  assert.equal(actionAuditReason(new Set()), undefined);
  assert.equal(actionAuditReason(new Set(), "state-changed"), "state-changed");
  assert.equal(actionAuditReason(new Set(), "Error: synthetic diagnostic", "internal-error"), "internal-error; Error: synthetic diagnostic");
});
