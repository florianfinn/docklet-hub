import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("update comments describe current mechanisms without future implementation assignments", () => {
  for (const file of ["update-runner.ts", "agent-jobs.ts"]) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const comments = source.match(/\/\/[^\n]*/g) ?? [];
    assert.equal(comments.some((comment) => /step [A-Z]|Restore registers its own/i.test(comment)), false, file);
  }
});
