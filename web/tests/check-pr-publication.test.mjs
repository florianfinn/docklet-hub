import test from "node:test";
import assert from "node:assert/strict";
import { titleProblems } from "../../scripts/check-pr-publication.mjs";
import { subjectAccepted } from "../../scripts/commit-subject.mjs";

test("a PR title must work as the squash commit subject", () => {
  assert.deepEqual(titleProblems("fix(web): keep the log cap"), []);
  assert.deepEqual(titleProblems("feat!: drop the old protocol"), []);
  assert.deepEqual(titleProblems("Update docs"), ["title is no Conventional Commit"]);
  assert.deepEqual(titleProblems("fix: f\u00C3\u00BCr"), ["title contains double-encoded characters"]);
});

test("merge subjects pass only with two parents", () => {
  assert.equal(subjectAccepted("docs: fix a typo"), true);
  assert.equal(subjectAccepted("Merge pull request #1 from example/topic", 2), true);
  assert.equal(subjectAccepted("Merge remote-tracking branch 'origin/main' into topic", 2), true);
  assert.equal(subjectAccepted("Merge pull request #1 from example/topic", 1), false);
  assert.equal(subjectAccepted("Update docs", 2), false);
});
