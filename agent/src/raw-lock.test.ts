import assert from "node:assert/strict";
import test from "node:test";
import { handlerSource } from "./handler-source-test-support.js";

// Guard over the project lock of the raw editor (#85).
//
// ⚠️ Why as a text check and not as a function test: `executeRaw` and
// `previewRaw` live in runtime/raw-ops.ts and depend on engine, registry, locks
// and audit log — without a running agent they cannot be called. The property
// at stake is one of the source text anyway.
//
// The failure this guards against is silent. The draft is stored for checking
// under ONE name per project directory (CANDIDATE_FILE_NAME). If a preview ran
// next to an apply, it would overwrite the apply's draft — and
// `docker compose config` would judge a text that is not written right after.
// That would not be a display error but a check of the wrong object, and no
// test of the check functions themselves sees it: both paths are green on
// their own.
const source = handlerSource();

// The body of a top-level function: up to the first closing brace at the start
// of a line. Everything nested is indented.
function bodyOf(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} no longer appears in the handler sources`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `the end of ${name} cannot be found`);
  return source.slice(start, end);
}

test("preview and apply take the same lock key", () => {
  for (const name of ["executeRaw", "previewRaw"]) {
    assert.match(
      bodyOf(name),
      /stackLocks\.runExclusive\(rawLockKey\(operation\)/,
      `${name} does not lock via rawLockKey`
    );
  }
  // A new project locks under the key its later stack will carry.
  for (const name of ["createProject", "previewProject"]) {
    assert.match(
      bodyOf(name),
      /stackLocks\.runExclusive\(rawLockKey\(\{ location, containerId: null, stackName: operation\.name \}\)/,
      `${name} does not lock via rawLockKey`
    );
  }
  // And from ONE computation. Two places that each assemble the key themselves
  // are two locks — and two locks are none.
  assert.equal(source.match(/stackLocks\.runExclusive\(rawLockKey\(/g)?.length, 4);
  assert.equal(source.match(/^(?:export )?function rawLockKey\(/gm)?.length, 1);
});

test("the preview checks inside the lock", () => {
  // The order in the source text is the order of execution here: whatever
  // stands before the `runExclusive` runs unlocked.
  const body = bodyOf("previewRaw");
  const lock = body.indexOf("stackLocks.runExclusive(");
  assert.ok(lock >= 0, "previewRaw does not lock at all");
  for (const step of ["inspectRawApply(", "rawOps.containerIds(", "readComposeFile("]) {
    assert.ok(
      body.indexOf(step) > lock,
      `${step} runs outside the project lock in previewRaw`
    );
  }
});
