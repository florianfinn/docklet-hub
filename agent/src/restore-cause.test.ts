import test from "node:test";
import assert from "node:assert/strict";
import { restoreCause } from "./restore-cause.js";
import { RestorePathFailure } from "./restore-metadata.js";
import { UpdateFailure } from "./update-budget.js";
test("restore cause follows the error chain and reports tokens only", () => {
  const timeout = Object.assign(new Error("archive-timeout"), { code: "ETIMEDOUT" });
  assert.equal(restoreCause(new UpdateFailure("restore-path-unsafe", { cause: timeout })), "UpdateFailure:restore-path-unsafe < Error:ETIMEDOUT");
  assert.equal(restoreCause(new RestorePathFailure("/home/user/secret", { cause: new Error("free text with spaces") })), "RestorePathFailure:restore-extract-failed < Error");
  assert.equal(restoreCause("not an error"), "unknown");
});
