import test from "node:test";
import assert from "node:assert/strict";
import { textProblems } from "../../scripts/check-pr-publication.mjs";
import { subjectAccepted } from "../../scripts/commit-subject.mjs";

test("title and body must work as the squash commit on main", () => {
  assert.deepEqual(textProblems("fix(web): keep the log cap", "Body text."), []);
  assert.deepEqual(textProblems("feat!: drop the old protocol"), []);
  assert.deepEqual(textProblems("Update docs"), ["title is no Conventional Commit"]);
  assert.deepEqual(textProblems("fix: f\u00C3\u00BCr"), ["text contains double-encoded characters"]);
  assert.deepEqual(textProblems("fix: x", "Body f\u00C3\u00BCr"), ["text contains double-encoded characters"]);
  assert.deepEqual(textProblems("fix: x", "Die Pr\u0075efung"), ["text contains German words without umlauts"]);
});

test("merge subjects pass only with two parents", () => {
  assert.equal(subjectAccepted("docs: fix a typo"), true);
  assert.equal(subjectAccepted("Merge pull request #1 from example/topic", 2), true);
  assert.equal(subjectAccepted("Merge remote-tracking branch 'origin/main' into topic", 2), true);
  assert.equal(subjectAccepted("Merge pull request #1 from example/topic", 1), false);
  assert.equal(subjectAccepted("Update docs", 2), false);
});
