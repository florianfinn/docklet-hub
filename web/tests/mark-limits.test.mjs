import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MARK_IDS_MAX, MARK_NAME_MAX } from "contract";

import { stripComments } from "./strip-comments.mjs";

// The two limits on marks, `MARK_NAME_MAX` and `MARK_IDS_MAX`, stand in
// `contract/src/marks.ts` and nowhere else (#268). The server rejects input
// beyond them (`features/marks/input.ts`), the web stops the user before a
// request is made (`MarkRow.tsx`, `NewMarkForm.tsx`, `MarkAssign.tsx`). A copy
// of the number on one side would let the two drift: the web would offer what
// the server then answers with a 400.
//
// ⚠️ WHAT IS HELD HERE IS THE READING, NOT THE VALUE: each file imports the
// limit from `contract` and carries no number of its own. The value itself is a
// decision and has its reason in `contract/src/marks.ts`.

const ROOT = new URL("../../", import.meta.url);

function source(path) {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const SERVER_INPUT = "server/src/features/marks/input.ts";
const WEB_FILES_WITH_LIMIT = [
  ["web/src/features/marks/MarkRow.tsx", "MARK_NAME_MAX"],
  ["web/src/features/marks/NewMarkForm.tsx", "MARK_NAME_MAX"],
  ["web/src/features/marks/MarkAssign.tsx", "MARK_IDS_MAX"]
];

test("the limits are real numbers in the contract", () => {
  assert.ok(Number.isInteger(MARK_NAME_MAX) && MARK_NAME_MAX > 0);
  assert.ok(Number.isInteger(MARK_IDS_MAX) && MARK_IDS_MAX > 0);
});

test("the server reads both limits from `contract` and declares none", () => {
  const input = source(SERVER_INPUT);
  for (const name of ["MARK_NAME_MAX", "MARK_IDS_MAX"]) {
    assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"contract"`).test(input), `${SERVER_INPUT} does not import ${name} from contract`);
    assert.ok(!new RegExp(`\\b(const|let|var)\\s+${name}\\b`).test(input), `${SERVER_INPUT} declares its own ${name}`);
  }
});

for (const [path, name] of WEB_FILES_WITH_LIMIT) {
  test(`${path} reads ${name} from \`contract\``, () => {
    const file = source(path);
    assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"contract"`).test(file), `${path} does not import ${name} from contract`);
    assert.ok(!new RegExp(`\\b(const|let|var)\\s+${name}\\b`).test(file), `${path} declares its own ${name}`);
  });
}

test("no field of the marks surface carries a literal `maxLength`", () => {
  for (const [path] of WEB_FILES_WITH_LIMIT) {
    assert.ok(!/maxLength=\{\s*\d+\s*\}/.test(source(path)), `${path}: maxLength with a number of its own`);
  }
});
