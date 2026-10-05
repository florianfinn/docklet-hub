import test from "node:test";
import assert from "node:assert/strict";
import { parseReview, statusFor } from "../../scripts/review-status.mjs";

const HEAD = "a".repeat(40);
const comment = (result, head = HEAD) => `Independent review\nReviewer: subagent\nHead: ${head}\nResult: ${result}\n\nNo findings.`;

test("a valid review comment names head and result", () => {
  assert.deepEqual(parseReview(comment("pass")), { head: HEAD, result: "pass" });
  assert.deepEqual(parseReview(comment("fail").replaceAll("\n", "\r\n")), { head: HEAD, result: "fail" });
});

test("comments without marker, reviewer, full SHA or known result are refused", () => {
  assert.equal(parseReview(undefined), null);
  assert.equal(parseReview("LGTM"), null);
  assert.equal(parseReview(comment("pass").replace("Reviewer: subagent\n", "")), null);
  assert.equal(parseReview(comment("pass", "abc1234")), null);
  assert.equal(parseReview(comment("approved")), null);
  assert.equal(parseReview(`Independent review\nReviewer: subagent\nResult: pass\n\nHead: ${HEAD}`), null);
});

test("only a passing review of the current head succeeds", () => {
  const pr = { state: "open", head: { sha: HEAD } };
  assert.equal(statusFor({ head: HEAD, result: "pass" }, pr).state, "success");
  assert.equal(statusFor({ head: HEAD, result: "fail" }, pr).state, "failure");
  assert.equal(statusFor({ head: "b".repeat(40), result: "pass" }, pr).state, "failure");
  assert.equal(statusFor({ head: HEAD, result: "pass" }, { ...pr, state: "closed" }), null);
  assert.equal(statusFor(null, pr).state, "failure");
});
