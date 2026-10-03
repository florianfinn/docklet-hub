import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerEngine, EngineError, EnginePullError } from "./engine.js";
import { parseImageRef } from "./image-ref.js";
import {
  LOGS_STREAM_FAILURE_REASONS,
  PULL_STREAM_FAILURE_REASONS,
  logsStreamFailureReason,
  pullStreamFailureReason
} from "./stream-failure-reasons.js";
import { handlerSource } from "./handler-source-test-support.js";

// Guards over the finer resolution of the two stream failures (#80).
//
// The compiler holds the one direction: nothing comes out of the two
// classifiers that is not in its set. This file holds the other three:
//
//   1. Every value of the two sets really arises — a list that grows
//      alongside reality is worse than none.
//   2. The classification is right for a REAL operation and not only for
//      constructed error objects. That is the part that counts: what
//      `engine.logsStream` actually throws for a vanished container or a
//      missing docker.sock decides the classification — and a constructed
//      `new EngineError("x", 404)` would prove nothing about that.
//   3. An abort gets no failure line on any of the three streams.

function socketPath(name: string): string {
  return process.platform === "win32"
    ? path.join(String.raw`\\.\pipe`, `agent-stream-${process.pid}-${name}`)
    : path.join(os.tmpdir(), `agent-stream-${process.pid}-${name}.sock`);
}

// --- 1. Both sets are fully reachable ---------------------------------------

test("every value of LOGS_STREAM_FAILURE_REASONS arises from an error", () => {
  const errno: NodeJS.ErrnoException = new Error("socket weg");
  errno.code = "ECONNRESET";
  const produced = [
    logsStreamFailureReason(new EngineError("engine responded 404", 404)),
    logsStreamFailureReason(new EngineError("engine responded 500", 500)),
    logsStreamFailureReason(errno),
    logsStreamFailureReason(new Error("etwas ganz anderes"))
  ];
  assert.deepEqual([...produced].sort(), [...LOGS_STREAM_FAILURE_REASONS].sort());
  assert.equal(
    new Set(LOGS_STREAM_FAILURE_REASONS).size,
    LOGS_STREAM_FAILURE_REASONS.length,
    "duplicate in LOGS_STREAM_FAILURE_REASONS"
  );
});

test("every value of PULL_STREAM_FAILURE_REASONS arises from an error", () => {
  const errno: NodeJS.ErrnoException = new Error("Engine-Timeout");
  errno.code = "ETIMEDOUT";
  const produced = [
    pullStreamFailureReason(new EnginePullError("Pull fehlgeschlagen: manifest unknown")),
    pullStreamFailureReason(new EngineError("engine responded 404", 404)),
    pullStreamFailureReason(new EngineError("engine responded 500", 500)),
    pullStreamFailureReason(errno),
    pullStreamFailureReason(new Error("etwas ganz anderes"))
  ];
  assert.deepEqual([...produced].sort(), [...PULL_STREAM_FAILURE_REASONS].sort());
  assert.equal(
    new Set(PULL_STREAM_FAILURE_REASONS).size,
    PULL_STREAM_FAILURE_REASONS.length,
    "duplicate in PULL_STREAM_FAILURE_REASONS"
  );
});

test("no reason is called 'abgebrochen' — the abort has dropped out of both sets", () => {
  const logs: readonly string[] = LOGS_STREAM_FAILURE_REASONS;
  const pull: readonly string[] = PULL_STREAM_FAILURE_REASONS;
  assert.equal(logs.includes("abgebrochen"), false);
  assert.equal(pull.includes("abgebrochen"), false);
});

// ⚠️ The one case decided by the order of the branches: EnginePullError
// INHERITS from EngineError and carries its status 502. If the EngineError
// branch came first, it would catch it too, and every registry failure would
// arrive as `engine-refused` — that is, as a statement about the daemon instead
// of about the registry. The two lines here are the same status and two reasons.
test("a 502 from the pull stream is not the same as a 502 from the engine", () => {
  assert.equal(pullStreamFailureReason(new EnginePullError("pull failed: x")), "pull-rejected");
  assert.equal(pullStreamFailureReason(new EngineError("engine responded 502", 502)), "engine-refused");
  assert.equal(new EnginePullError("x").status, 502, "the status stays what it was");
  assert.ok(new EnginePullError("x") instanceof EngineError, "existing instanceof checks still see it");
});

// --- 2. The classification on a real operation ------------------------------

test("a vanished container becomes 'container-gone', not 'engine-refused'", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "No such container: weg" }));
  });
  const pathname = socketPath("logs-404");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  const engine = new DockerEngine({ socketPath: pathname });
  const failure = await engine
    .logsStream("weg", { tail: 10, tty: false }, () => {})
    .then(() => null, (error: unknown) => error);
  assert.ok(failure, "the engine answered with 404, that has to throw");
  assert.equal(logsStreamFailureReason(failure), "container-gone");
});

test("a refusing engine becomes 'engine-refused'", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "daemon hat genug" }));
  });
  const pathname = socketPath("logs-500");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  const engine = new DockerEngine({ socketPath: pathname });
  const failure = await engine
    .logsStream("da", { tail: 10, tty: false }, () => {})
    .then(() => null, (error: unknown) => error);
  assert.ok(failure);
  assert.equal(logsStreamFailureReason(failure), "engine-refused");
});

// The case the operator cares about: a freshly restarted daemon or a
// container without the docker.sock mount. Up to #80 it arrived as
// "logs-fehlgeschlagen" — verbatim the same as a vanished container.
test("a missing docker.sock becomes 'engine-unreachable'", async () => {
  const engine = new DockerEngine({ socketPath: socketPath("gibt-es-nicht") });
  const failure = await engine
    .logsStream("egal", { tail: 10, tty: false }, () => {})
    .then(() => null, (error: unknown) => error);
  assert.ok(failure);
  assert.equal((failure as NodeJS.ErrnoException).code, "ENOENT");
  assert.equal(logsStreamFailureReason(failure), "engine-unreachable");
});

// ⚠️ This test is the reason why engine.ts has given its idle timeout a `code`
// since #80. Before, the timeout could only be recognised by the wording
// "Engine-Timeout" — a text is not a contract and silently drops out of the
// distinction at the first rephrasing.
//
// ⚠️ The seam this test does NOT close: it is driven via `inspect`, not via
// one of the two streams. `pull` sets its own idle timeout to 10 minutes and
// `logsStream` to 24 hours (both intentional: a pull over a slow line and a
// silent container are not errors), and the request's timeout beats the
// constructor's — a real timeout on these two routes could only be brought
// about by waiting. What is checked is therefore the shared place:
// `engineTimeoutError` attaches the code, and both routes — `request()` as well
// as `stream()` — take it. The route from code to reason is in the line below.
test("an expired idle timeout carries ETIMEDOUT and becomes 'engine-unreachable'", async (t) => {
  const hanging: http.ServerResponse[] = [];
  const server = http.createServer((_request, response) => {
    // Write the header, then nothing more: the socket stays open and silent.
    response.writeHead(200, { "content-type": "application/json" });
    hanging.push(response);
  });
  const pathname = socketPath("still");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => {
    for (const response of hanging) response.destroy();
    return new Promise<void>((done) => void server.close(() => done()));
  });

  const engine = new DockerEngine({ socketPath: pathname, timeoutMs: 150 });
  const failure = await engine.inspect("egal").then(() => null, (error: unknown) => error);
  assert.ok(failure, "without a response the idle timeout has to strike");
  assert.equal((failure as NodeJS.ErrnoException).code, "ETIMEDOUT");
  assert.equal(pullStreamFailureReason(failure), "engine-unreachable");
  assert.equal(logsStreamFailureReason(failure), "engine-unreachable");
});

// The most common real pull failure: /images/create answers 200 and writes
// the error IN THE MIDDLE OF the progress. Up to #80 it arrived as
// "pull-fehlgeschlagen" — verbatim the same as a daemon that rejects the route
// itself.
test("an error in the progress stream becomes 'pull-rejected'", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write(`${JSON.stringify({ status: "Pulling from library/nginx" })}\n`);
    response.end(`${JSON.stringify({ errorDetail: { message: "manifest unknown" }, error: "manifest unknown" })}\n`);
  });
  const pathname = socketPath("pull-stream-fehler");
  await new Promise<void>((done) => server.listen(pathname, done));
  t.after(() => new Promise<void>((done) => void server.close(() => done())));

  const engine = new DockerEngine({ socketPath: pathname });
  const failure = await engine
    .pull(parseImageRef("nginx:1")!, undefined, undefined)
    .then(() => null, (error: unknown) => error);
  assert.ok(failure);
  assert.ok(failure instanceof EnginePullError, "the stream failure needs its own type");
  assert.equal(pullStreamFailureReason(failure), "pull-rejected");
});

// --- 3. No abort gets a failure line ----------------------------------------
//
// ⚠️ As a text check over the handler source (routes/, runtime/ and index.ts,
// see handler-source-test-support.ts) and not as a functional test — the same
// boundary as in raw-stream.test.ts: the three branches live in the request
// handlers and depend on engine, registry, locks, audit and a real socket. The
// property at stake is a property of the source text anyway: WHICH failure
// lines a branch can write at all.
const source = handlerSource();

// From the call that drives the stream up to the `finally` of the same branch.
function streamBranchFrom(anchor: string): string {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `anchor "${anchor}" is no longer in the handler source`);
  const end = source.indexOf("  } finally {", start);
  assert.ok(end > start, `the finally after "${anchor}" is gone`);
  return source.slice(start, end);
}

function failureLinesIn(region: string): string[] {
  return [...region.matchAll(/sendLine\(response, \{ kind: "error"[^)]*\)/g)].map((match) => match[0]);
}

const STREAM_BRANCHES = [
  { name: "logs-stream", anchor: "await engine.logsStream(", abortGuard: "error instanceof EngineAbortError" },
  { name: "log-file", anchor: "await tailLogFile(", abortGuard: "streamAbort.signal.aborted" },
  { name: "pull-stream", anchor: 'console.error("[agent] pull-stream:", error)', abortGuard: "aborted" }
];

for (const branch of STREAM_BRANCHES) {
  test(`${branch.name}: an abort writes no failure line (#80)`, () => {
    const region = streamBranchFrom(branch.anchor);
    const lines = failureLinesIn(region);
    assert.ok(lines.length > 0, `${branch.name} no longer writes any failure line at all`);
    for (const line of lines) {
      assert.equal(
        line.includes("abgebrochen"),
        false,
        `${branch.name} still reports an abort as kind: "error": ${line}`
      );
    }
    assert.ok(
      region.includes(branch.abortGuard),
      `${branch.name} no longer distinguishes the abort — without this check it falls into a failure reason`
    );
  });
}

// ⚠️ The audit reason is the counter-check: the abort disappears from the
// wire, but NOT from the archive — there it is the distinction between
// "someone aborted" and "something went wrong". English like the other values
// of the same assignment, which change in this step anyway.
test("pull-stream still records the abort in the audit — as 'aborted'", () => {
  const region = streamBranchFrom('console.error("[agent] pull-stream:", error)');
  assert.ok(region.includes('audit.write({'), "the branch no longer writes any audit at all");
  assert.ok(
    region.includes('? "aborted"'),
    "without this branch the archive would lose the distinction between abort and failure"
  );
  assert.equal(
    region.includes('"abgebrochen"'),
    false,
    "the last German value of this field has been moved along (#80)"
  );
});
