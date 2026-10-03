import assert from "node:assert/strict";
import test from "node:test";
import { handlerSource } from "./handler-source-test-support.js";

// Guard over the observable (streamed) path of the raw editor (#86).
//
// ⚠️ Why as a text check and not as a function test: the branch lives in the
// request handler in routes/compose-raw-routes.ts and depends on engine,
// registry, locks, audit and a real socket — without a running agent it cannot
// be called. The three properties at stake here are properties of the source
// text anyway: WHERE the response comes from, WHEN the header goes out and what
// the branch does NOT do.
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

// The handler's stream branch: from its `if` up to the line that runs the
// synchronous path.
function streamBranch(): string {
  const start = source.indexOf("  if (streaming) {");
  assert.ok(start >= 0, "the stream branch no longer appears in the handler sources");
  const end = source.indexOf("const result = await executeRaw(execution);", start);
  assert.ok(end > start, "the synchronous path behind the stream branch is gone");
  return source.slice(start, end);
}

test("the final line carries the synchronous response unchanged", () => {
  // ⚠️ This is the contract of this route, and breaking it would be silent.
  //
  // The 24 error keys of the apply (from `confirmation-missing` to
  // `hardening-newly-violated`, with `rolledBack` in the body; since #89 as a set in
  // contract/src/agent/compose-reasons.ts) are translated one by one by the caller. A stream that folds them into a text line or even just
  // renames them would be a step back from the synchronous JSON — and
  // everything would stay green while doing so, because the stream would still run.
  assert.match(
    streamBranch(),
    /sendLine\(response, \{ kind: "result", status: result\.status, body: result\.body \}(?: satisfies ComposeApplyStreamLine)?\)/,
    "the final line builds its own response instead of passing through the one from the apply"
  );
});

test("there is no second apply lane next to the stream", () => {
  // The stream runs THE SAME executeRaw as the synchronous path. A separate
  // lane next to it would be the failure shape #85 was already written against:
  // two paths through the same controls drift apart as soon as one of them
  // gains a step.
  // Phase 2 is run in exactly one place, and the stretch before it appears
  // exactly once. A copy for the stream would show up here.
  assert.equal(source.match(/await executeRawApply\(/g)?.length, 1);
  assert.equal(source.match(/^(?:export )?async function executeRawWithoutLock\(/gm)?.length, 1);
  assert.equal(source.match(/^(?:export )?async function executeRaw\(/gm)?.length, 1);
  // And the stream takes it: three callers share this one lane — the
  // new stack (/stacks/raw), the apply on the anchor and the stream.
  assert.equal(source.match(/await executeRaw\(/g)?.length, 3);
  assert.match(streamBranch(), /result = await executeRaw\(\{\s*\.\.\.execution,/);
});

test("the first line only goes out once the project lock is held", () => {
  // ⚠️ Otherwise the caller loses `stack-busy`.
  //
  // If the stack is currently busy, runExclusive throws a KeyedMutexBusyError,
  // and the outer error handler turns it into the same `409` that the
  // synchronous path delivers. If the header went out earlier, the status
  // would already be fixed at 200 — the named reason would turn into a stream
  // with a start line and no result, i.e. silence.
  const body = bodyOf("executeRaw");
  const lock = body.indexOf("stackLocks.runExclusive(");
  const locked = body.indexOf("operation.onLocked?.()");
  assert.ok(lock >= 0, "executeRaw does not lock at all");
  assert.ok(locked > lock, "onLocked runs outside the project lock");
  // And before every check inside it: everything that comes after belongs in
  // the final line and no longer in a status.
  assert.ok(
    locked < body.indexOf("registry.isAllowed("),
    "between the lock and the first line there is a check whose status would be lost"
  );

  // In the handler the header hangs on exactly this seam and not on the
  // call site before it.
  const branch = streamBranch();
  const hook = branch.indexOf("onLocked: () => {");
  assert.ok(hook >= 0, "the stream branch no longer hangs its header on onLocked");
  assert.ok(
    branch.indexOf("response.writeHead(200") > hook,
    "the header goes out before the project lock is held"
  );
});

test("a dropped connection does not abort the apply", () => {
  // ⚠️ Here this stream parts ways with the pull stream, and mixing them up
  // would be expensive.
  //
  // For the pull, aborting on a dropped connection is intended — the user
  // pressed "Cancel", and Docker discards the half layers. Here, between
  // writing the file and the `up`, there is a state that only
  // `executeRawApply` itself finds its way out of: an abort there would mean
  // a new Compose file, a stack that was not started and no rollback. Whoever
  // is listening decides nothing here.
  const branch = streamBranch();
  for (const forbidden of ["Abort", "abort"]) {
    assert.equal(
      branch.includes(forbidden),
      false,
      `the stream branch aborts on a dropped connection (${forbidden})`
    );
  }
});

test("the stream counts against the same pool as the other streams", () => {
  // R3: it is the longest-lived of them all. It is rejected BEFORE anything
  // has started — a 429 at this point costs nothing.
  const branch = streamBranch();
  assert.match(branch, /openStreams\.tryAcquire\(\)/);
  assert.match(branch, /response\.once\("close", releaseStreamSlot\)/);
});
