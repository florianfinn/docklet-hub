import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { HUB_RUNTIME_TIMEOUT_MS, RUNTIME_TRANSPORT_RESERVE_MS } from "contract";
import { RuntimeBudget } from "./runtime-budget.js";
import { StackEndpointError } from "./stack-control.js";

const expired = (error: unknown) => error instanceof StackEndpointError && error.code === "runtime-deadline-exceeded";

test("budget expires a busy operation, aborts its request and forbids the next phase", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const budget = new RuntimeBudget(100);
  let signal: AbortSignal | undefined;
  const pending = budget.run((options) => { signal = options.signal; return new Promise<void>(() => {}); });
  const rejected = assert.rejects(pending, expired);
  now = 100;
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(signal!.aborted, true);
  let started = false;
  await assert.rejects(budget.run(async () => { started = true; }), expired);
  assert.equal(started, false);
});

test("wall clock changes neither extend nor shorten the monotonic deadline", (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const budget = new RuntimeBudget(100);
  t.mock.method(Date, "now", () => 1e12);
  now += 20;
  assert.equal(budget.remaining(), 80);
  t.mock.method(Date, "now", () => 0);
  assert.equal(budget.remaining(30), 30);
  now += 80;
  assert.throws(() => budget.remaining(), expired);
});

test("completed phases clear their abort timer and deduct elapsed time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const budget = new RuntimeBudget(100);
  let signal: AbortSignal | undefined;
  const value = await budget.run(async (options) => { signal = options.signal; now = 40; return "read"; });
  assert.equal(value, "read");
  assert.equal(budget.remaining(), 60);
  t.mock.timers.tick(100);
  assert.equal(signal!.aborted, false);
});

test("autonomous starts receive the same finite default envelope", (t) => {
  t.mock.method(performance, "now", () => 0);
  assert.equal(new RuntimeBudget().remaining(), HUB_RUNTIME_TIMEOUT_MS - RUNTIME_TRANSPORT_RESERVE_MS);
});
