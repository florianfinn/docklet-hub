import assert from "node:assert/strict";
import test from "node:test";
import { UnauthThrottle } from "./unauth-log.js";

test("the first attempt is logged immediately", () => {
  const throttle = new UnauthThrottle(60_000);
  assert.deepEqual(throttle.report(1_000), { write: true, suppressed: 0 });
});

test("further attempts in the same window do not write", () => {
  const throttle = new UnauthThrottle(60_000);
  throttle.report(1_000);
  assert.deepEqual(throttle.report(1_500), { write: false });
  assert.deepEqual(throttle.report(59_000), { write: false });
});

test("the next window carries the number of suppressed attempts", () => {
  // The point of the whole throttle: a flood becomes a NUMBER, not
  // silence. If the counter got lost, an attack would have turned into a
  // single knock in the log.
  const throttle = new UnauthThrottle(60_000);
  throttle.report(0);
  for (let i = 1; i <= 5; i++) throttle.report(i * 100);
  assert.deepEqual(throttle.report(60_000), { write: true, suppressed: 5 });
});

test("after a quiet window the counter is back at zero", () => {
  const throttle = new UnauthThrottle(60_000);
  throttle.report(0);
  throttle.report(10);
  assert.deepEqual(throttle.report(60_000), { write: true, suppressed: 1 });
  assert.deepEqual(throttle.report(120_000), { write: true, suppressed: 0 });
});
