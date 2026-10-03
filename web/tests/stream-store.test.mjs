import assert from "node:assert/strict";
import test from "node:test";

import { createStreamStore, sharedStream, sharedStreamCount } from "../src/platform/streams/stream-store.ts";

// WHAT THIS FILE CHECKS (#257)
//
// The stream store of the web (`web/src/platform/streams/stream-store.ts`),
// without React and without DOM. Its promises are about the other side: how
// many streams stand open at the arm, and when they close. A view built on a
// store that breaks one of them still renders lines — the mistake shows only
// as a `429` for somebody else.
//
// The release is deferred (rule 3 in the file head); here the scheduler is a
// hand-cranked queue, so a case says exactly when the grace period ends.

/** A scheduler whose deferred calls run only when the test says so. */
function manualScheduler() {
  const queue = new Set();
  const schedule = (run) => {
    const entry = { run };
    queue.add(entry);
    return () => queue.delete(entry);
  };
  const flush = () => {
    for (const entry of [...queue]) {
      queue.delete(entry);
      entry.run();
    }
  };
  return { schedule, flush, pending: () => queue.size };
}

/** A source the test drives by hand; records every opened stream. */
function fakeSource() {
  const runs = [];
  const source = (signal, sink) =>
    new Promise((resolve, reject) => {
      runs.push({ signal, sink, resolve, reject });
    });
  return { source, runs, last: () => runs[runs.length - 1] };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function store(cap = 100) {
  const scheduler = manualScheduler();
  const fake = fakeSource();
  const created = createStreamStore(fake.source, { cap, schedule: scheduler.schedule });
  return { store: created, scheduler, fake };
}

test("the phases follow connecting → open → closed, lines in between", async () => {
  const { store: s, fake } = store();
  const phases = [];
  s.subscribe(() => phases.push(s.getSnapshot().phase));
  assert.equal(s.getSnapshot().phase, "connecting");
  assert.equal(fake.runs.length, 1, "the first reader opens the stream");

  fake.last().sink.open();
  fake.last().sink.line("a");
  fake.last().sink.line("b");
  fake.last().resolve();
  await tick();

  assert.deepEqual(phases, ["open", "open", "open", "closed"]);
  assert.deepEqual(s.getSnapshot().lines, ["a", "b"]);
});

test("an error before the first line is failed with the error, not closed", async () => {
  const { store: s, fake } = store();
  s.subscribe(() => {});
  const error = new Error("502");
  fake.last().reject(error);
  await tick();
  assert.equal(s.getSnapshot().phase, "failed");
  assert.equal(s.getSnapshot().error, error);
});

test("a failure line keeps the lines and stays failed when the stream ends", async () => {
  const { store: s, fake } = store();
  s.subscribe(() => {});
  fake.last().sink.open();
  fake.last().sink.line("before");
  fake.last().sink.fail({ reason: "container-gone" });
  fake.last().resolve();
  await tick();
  const snapshot = s.getSnapshot();
  assert.equal(snapshot.phase, "failed");
  assert.deepEqual(snapshot.failure, { reason: "container-gone" });
  assert.deepEqual(snapshot.lines, ["before"], "the lines received are the reason somebody is here");
});

test("the cap drops the oldest lines and counts them", () => {
  const { store: s, fake } = store(3);
  s.subscribe(() => {});
  for (const line of ["1", "2", "3", "4", "5"]) fake.last().sink.line(line);
  assert.deepEqual(s.getSnapshot().lines, ["3", "4", "5"]);
  assert.equal(s.getSnapshot().dropped, 2);
});

test("a cap that is not a positive integer is refused", () => {
  assert.throws(() => createStreamStore(fakeSource().source, { cap: 0 }), RangeError);
  assert.throws(() => createStreamStore(fakeSource().source, { cap: 2.5 }), RangeError);
});

test("the last reader leaving aborts the stream after the grace period", () => {
  const { store: s, scheduler, fake } = store();
  const unsubscribe = s.subscribe(() => {});
  unsubscribe();
  assert.equal(fake.last().signal.aborted, false, "not yet: a StrictMode remount may follow");
  scheduler.flush();
  assert.equal(fake.last().signal.aborted, true, "a stream nobody reads would hold a slot at the arm");
});

test("leave and come back within the grace period: still one stream (StrictMode)", () => {
  const { store: s, scheduler, fake } = store();
  // What React does in development: subscribe, unsubscribe, subscribe.
  s.subscribe(() => {})();
  s.subscribe(() => {});
  scheduler.flush();
  assert.equal(fake.runs.length, 1, "StrictMode must not open a second stream");
  assert.equal(fake.last().signal.aborted, false);
});

test("two readers share one stream; it ends when the second leaves", () => {
  const { store: s, scheduler, fake } = store();
  const seen = [[], []];
  const leaveFirst = s.subscribe(() => seen[0].push(s.getSnapshot().lines.length));
  const leaveSecond = s.subscribe(() => seen[1].push(s.getSnapshot().lines.length));
  assert.equal(fake.runs.length, 1);
  fake.last().sink.line("x");
  assert.deepEqual(seen, [[1], [1]], "both readers see the same line");

  leaveFirst();
  scheduler.flush();
  assert.equal(fake.last().signal.aborted, false, "the second reader still reads");
  leaveSecond();
  scheduler.flush();
  assert.equal(fake.last().signal.aborted, true);
});

test("reconnect after failed opens a fresh attempt with an empty buffer", async () => {
  const { store: s, fake } = store();
  s.subscribe(() => {});
  fake.last().sink.line("old");
  fake.last().reject(new Error("429"));
  await tick();
  assert.equal(s.getSnapshot().phase, "failed");

  s.reconnect();
  assert.equal(fake.runs.length, 2);
  assert.deepEqual(s.getSnapshot(), {
    phase: "connecting",
    lines: [],
    dropped: 0,
    error: null,
    failure: null,
    attempt: 1
  });
  // A late line of the first attempt does not land in the second.
  fake.runs[0].sink.line("late");
  assert.deepEqual(s.getSnapshot().lines, []);
});

test("reconnect after a failure line aborts the old, still reading stream", () => {
  const { store: s, fake } = store();
  s.subscribe(() => {});
  fake.last().sink.fail({ reason: "engine-unreachable" });
  s.reconnect();
  assert.equal(fake.runs[0].signal.aborted, true, "the old stream must not keep its slot");
  assert.equal(fake.runs.length, 2);
});

test("reconnect while the stream runs does nothing", () => {
  const { store: s, fake } = store();
  s.subscribe(() => {});
  fake.last().sink.open();
  s.reconnect();
  assert.equal(fake.runs.length, 1);
  assert.equal(s.getSnapshot().attempt, 0);
});

test("coming back after the release opens a new stream, the old one stays closed", () => {
  const { store: s, scheduler, fake } = store();
  s.subscribe(() => {})();
  scheduler.flush();
  s.subscribe(() => {});
  assert.equal(fake.runs.length, 2);
  assert.equal(fake.runs[0].signal.aborted, true);
  assert.equal(fake.runs[1].signal.aborted, false);
});

test("a store nobody ever subscribes to opens nothing and releases itself", () => {
  const scheduler = manualScheduler();
  const fake = fakeSource();
  let released = 0;
  createStreamStore(fake.source, { cap: 10, schedule: scheduler.schedule, onRelease: () => (released += 1) });
  scheduler.flush();
  assert.equal(fake.runs.length, 0);
  assert.equal(released, 1);
});

test("sharedStream hands two readers of one key the same store and forgets it on release", () => {
  const scheduler = manualScheduler();
  const fake = fakeSource();
  const before = sharedStreamCount();
  const create = (hooks) => createStreamStore(fake.source, { cap: 10, schedule: scheduler.schedule, ...hooks });
  const first = sharedStream("host-1/abc", create);
  const second = sharedStream("host-1/abc", create);
  const other = sharedStream("host-1/def", create);
  assert.equal(first, second);
  assert.notEqual(first, other);

  const leave = first.subscribe(() => {});
  second.subscribe(() => {})();
  scheduler.flush();
  assert.equal(fake.runs.length, 1, "one key, one stream");
  assert.equal(sharedStreamCount(), before + 1, "`other` was never read and released itself");

  leave();
  scheduler.flush();
  assert.equal(sharedStreamCount(), before);
  assert.notEqual(sharedStream("host-1/abc", create), first, "after the release a new reader gets a new store");
  scheduler.flush();
});
