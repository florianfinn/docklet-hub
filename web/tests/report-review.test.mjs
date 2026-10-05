import test from "node:test";
import assert from "node:assert/strict";
import { commentBody, parseVerdict } from "../../scripts/report-review.mjs";

test("a valid verdict passes through", () => {
  const verdict = { result: "fail", summary: "One bug.", blocking: [{ path: "a.ts", line: 3, problem: "off by one" }] };
  assert.deepEqual(parseVerdict(JSON.stringify(verdict)), verdict);
  assert.match(commentBody(verdict), /blocking findings[\s\S]*`a\.ts:3`: off by one/);
});

test("missing, malformed or contradictory verdicts are refused", () => {
  assert.equal(parseVerdict(undefined), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("not json"), null);
  assert.equal(parseVerdict(JSON.stringify({ result: "ok", summary: "", blocking: [] })), null);
  assert.equal(parseVerdict(JSON.stringify({ result: "pass", summary: "x" })), null);
  assert.equal(parseVerdict(JSON.stringify({ result: "pass", summary: "x", blocking: [{ path: "a", problem: "b" }] })), null);
});
