import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isTextOnly, TEXT_TESTS } from "../../scripts/change-scope.mjs";

test("Nur Prosa ohne ausgeführte Pfade gilt als Textänderung", () => {
  assert.equal(isTextOnly(["LICENSE"]), true);
  assert.equal(isTextOnly(["README.md", "docs/design/review-workflow.md", "agent/README.md"]), true);
  assert.equal(isTextOnly([]), false);
  assert.equal(isTextOnly(["README.md", "package.json"]), false);
  assert.equal(isTextOnly(["scripts/notes.md"]), false);
  assert.equal(isTextOnly([".github/workflows/notes.md"]), false);
  assert.equal(isTextOnly(["web/src/vendor/PROVENANCE.md"]), false);
  assert.equal(isTextOnly(["LICENSE.txt"]), false);
});

test("Die Textprüfungen existieren", () => {
  for (const path of TEXT_TESTS) assert.equal(existsSync(fileURLToPath(new URL("../../" + path, import.meta.url))), true, path);
});
