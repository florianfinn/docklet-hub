import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedMutex, KeyedMutexBusyError, mapLimit, StreamLimit } from "./concurrency.js";

test("mapLimit bewahrt die Reihenfolge, auch wenn spaetere Elemente frueher fertig sind", async () => {
  // Frueher Index loest absichtlich zuletzt auf — trotzdem muss Ergebnis[i] zu
  // items[i] gehoeren.
  const items = [0, 1, 2, 3, 4];
  const result = await mapLimit(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, (items.length - n) * 5));
    return n * 10;
  });
  assert.deepEqual(result, [0, 10, 20, 30, 40]);
});

test("mapLimit haelt den Nebenlaeufigkeits-Deckel ein", async () => {
  let running = 0;
  let maxRunning = 0;
  await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  });
  assert.equal(maxRunning, 3);
});

test("mapLimit verarbeitet jedes Element genau einmal", async () => {
  const seen: number[] = [];
  await mapLimit([10, 20, 30, 40], 2, async (n) => {
    seen.push(n);
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), [10, 20, 30, 40]);
});

test("mapLimit reicht einen Fehler aus fn durch", async () => {
  await assert.rejects(
    () =>
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("kaputt");
        return n;
      }),
    /kaputt/
  );
});

test("mapLimit auf leerer Liste ergibt eine leere Liste", async () => {
  const result = await mapLimit([], 4, async () => 1);
  assert.deepEqual(result, []);
});

test("KeyedMutex lehnt ein bereits laufendes Compose-Projekt sofort ab", async () => {
  const mutex = new KeyedMutex();
  let release!: () => void;
  const first = mutex.runExclusive(
    "homepage",
    () => new Promise<void>((resolve) => { release = resolve; })
  );
  await assert.rejects(
    () => mutex.runExclusive("homepage", async () => undefined),
    KeyedMutexBusyError
  );
  release();
  await first;
  assert.equal(mutex.pendingKeys(), 0);
});

test("KeyedMutex blockiert verschiedene Projekte nicht gegenseitig", async () => {
  const mutex = new KeyedMutex();
  let running = 0;
  let maxRunning = 0;
  const operation = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
  };
  await Promise.all([
    mutex.runExclusive("homepage", operation),
    mutex.runExclusive("minecraft", operation)
  ]);
  assert.equal(maxRunning, 2);
});

test("KeyedMutex gibt die Sperre auch nach einem Fehler frei", async () => {
  const mutex = new KeyedMutex();
  const order: string[] = [];
  const first = mutex.runExclusive("stack", async () => {
    order.push("a");
    throw new Error("kaputt");
  });
  await assert.rejects(first, /kaputt/);
  await mutex.runExclusive("stack", async () => {
    order.push("b");
  });
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(mutex.pendingKeys(), 0);
});

// --- Stream limit (R3) ------------------------------------------------------

test("stream limit lets through up to the maximum and refuses after that", () => {
  const limit = new StreamLimit(2);
  assert.equal(limit.count, 0);
  assert.notEqual(limit.tryAcquire(), null);
  assert.notEqual(limit.tryAcquire(), null);
  assert.equal(limit.count, 2);
  assert.equal(limit.isFull(), true);
  // The third stream gets no slot — that is the 429 in the router.
  assert.equal(limit.tryAcquire(), null);
});

test("stream limit gives the slot back after release", () => {
  const limit = new StreamLimit(1);
  const share = limit.tryAcquire();
  assert.notEqual(share, null);
  assert.equal(limit.tryAcquire(), null);
  share!();
  assert.equal(limit.count, 0);
  assert.notEqual(limit.tryAcquire(), null);
});

test("stream limit counts a double release only once", () => {
  // The most important case: every stream releases twice — once in the
  // router's `finally`, once via `response.once("close", ...)` as a fallback.
  // If both counted, the counter would go negative and the cap would be
  // silently defeated.
  const limit = new StreamLimit(2);
  const share = limit.tryAcquire()!;
  limit.tryAcquire();
  share();
  share();
  share();
  assert.equal(limit.count, 1);
  assert.equal(limit.isFull(), false);
  // And the second slot is still taken: one stream, one slot.
  assert.notEqual(limit.tryAcquire(), null);
  assert.equal(limit.isFull(), true);
});

test("stream limit keeps the cap over many cycles", () => {
  const limit = new StreamLimit(3);
  let peak = 0;
  const open: Array<() => void> = [];
  for (let i = 0; i < 50; i += 1) {
    const share = limit.tryAcquire();
    if (share) open.push(share);
    peak = Math.max(peak, limit.count);
    // Every second round releases the oldest stream again.
    if (i % 2 === 1 && open.length > 0) open.shift()!();
  }
  assert.equal(peak, 3);
  while (open.length > 0) open.shift()!();
  assert.equal(limit.count, 0);
});

test("stream limit measures how long the oldest open stream has been running", () => {
  // R5 started with "measure first": only the agent knows how long the
  // long-lived paths are ACTUALLY open. The clock is injected so that the test
  // proves the duration without waiting for it.
  let time = 1_000;
  const limit = new StreamLimit(4, () => time);
  assert.equal(limit.oldestMs, 0);

  const old = limit.tryAcquire()!;
  time += 5_000;
  const young = limit.tryAcquire()!;
  time += 1_000;

  // The oldest counts, not the last one.
  assert.equal(limit.oldestMs, 6_000);
  old();
  assert.equal(limit.oldestMs, 1_000);
  young();
  assert.equal(limit.oldestMs, 0);
});

test("stream limit keeps the longest duration even after the stream is gone", () => {
  // Otherwise the value would only be a snapshot — and the one question R5
  // had to answer ("does anything here ever run longer than the deadline?")
  // could only be answered by someone looking at the right moment.
  let time = 0;
  const limit = new StreamLimit(2, () => time);
  const share = limit.tryAcquire()!;
  time += 30 * 60_000;
  share();
  assert.equal(limit.count, 0);
  assert.equal(limit.oldestMs, 0);
  assert.equal(limit.longestMs, 30 * 60_000);

  // A running stream counts as soon as it overtakes the previous record.
  limit.tryAcquire();
  time += 45 * 60_000;
  assert.equal(limit.longestMs, 45 * 60_000);
});

test("a double release does not falsify the measured duration", () => {
  let time = 0;
  const limit = new StreamLimit(2, () => time);
  const share = limit.tryAcquire()!;
  time += 10_000;
  share();
  time += 60_000;
  // The second call comes from the `close` fallback and must not extend the
  // duration to the time until NOW.
  share();
  assert.equal(limit.longestMs, 10_000);
  assert.equal(limit.count, 0);
});
