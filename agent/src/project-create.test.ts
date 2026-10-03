import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Guard over runtime/project-create.ts. The functions need engine, registry,
// locks and audit, so the order of their steps is checked in the source text,
// like raw-lock.test.ts does for the raw editor.
const source = fs.readFileSync(new URL("./runtime/project-create.ts", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is gone`);
  return source.slice(start, source.indexOf("\n}\n", start));
}

function ordered(body: string, steps: readonly string[], message: string): void {
  let previous = -1;
  for (const step of steps) {
    const index = body.indexOf(step, previous + 1);
    assert.ok(index > previous, `${message}: ${step}`);
    previous = index;
  }
}

test("a create checks occupancy under the lock before creating the directory", () => {
  ordered(
    bodyOf("createProject"),
    ["stackLocks.runExclusive(", "directoryOccupied(", "ensureProjectDir(", "executeRawLocked("],
    "createProject runs out of order"
  );
});

test("a failed rollback keeps everything, otherwise only empty directories go", () => {
  ordered(
    bodyOf("createProject"),
    ["if (result.body.rolledBack === false) return result;", "removeEmptyProjectDir("],
    "cleanup runs before the rollback check"
  );
  assert.doesNotMatch(source, /rmSync\(|rmdirSync\(/);
});

test("the preview removes the directory it created, even when the check throws", () => {
  const body = bodyOf("previewProject");
  ordered(
    body,
    ["stackLocks.runExclusive(", "directoryOccupied(", "ensureProjectDir(", "try {", "inspectRawApply(", "} finally {", "removeEmptyProjectDir("],
    "previewProject runs out of order"
  );
  assert.doesNotMatch(body, /writeRawComposeFile|executeRaw/);
});
