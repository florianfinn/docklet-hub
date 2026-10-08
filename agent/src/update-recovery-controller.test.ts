import assert from "node:assert/strict";
import test from "node:test";
import { UpdateRecoveryController } from "./update-recovery-controller.js";
const target = { kind: "container", containerName: "demo" } as const;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("recovery retries with backoff until success while only journal targets are blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let attempts = 0; const failures: number[] = [];
  const controller = new UpdateRecoveryController({ pending: () => [target], recover: async () => { if (++attempts < 3) throw new Error("offline"); },
    failed: (_error, delay) => failures.push(delay) }); t.after(() => controller.stop());
  assert.equal(controller.isReady(), false); controller.start(); controller.start(); await settle();
  assert.equal(attempts, 1); assert.equal(controller.blocks(target), true); assert.equal(controller.blocks({ kind: "container", containerName: "other" }), false);
  t.mock.timers.tick(999); await settle(); assert.equal(attempts, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(attempts, 2); assert.equal(controller.isReady(), false);
  t.mock.timers.tick(2000); await settle(); assert.equal(attempts, 3); assert.equal(controller.isReady(), true); assert.equal(controller.blocks(target), false);
  assert.deepEqual(failures, [1000, 2000]); t.mock.timers.tick(600_000); await settle(); assert.equal(attempts, 3);
});
test("unreadable journals do not prevent quarantine recovery and block healing until successful assessment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let broken = true; let attempts = 0; const errors: unknown[] = [];
  const controller = new UpdateRecoveryController({ pending: () => { if (broken) throw new Error("invalid"); return []; },
    recover: async () => { attempts++; broken = false; if (attempts === 1) throw new Error("quarantined"); }, failed: (error) => errors.push(error) });
  t.after(() => controller.stop()); assert.equal(controller.blocks(target), true); controller.start(); await settle();
  assert.equal(attempts, 1); assert.equal(errors.length, 1); assert.equal(controller.blocks(target), true);
  t.mock.timers.tick(1000); await settle(); assert.equal(controller.isReady(), true); assert.equal(controller.blocks(target), false);
});
test("backoff is bounded and shutdown cancels retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const failures: number[] = [];
  const controller = new UpdateRecoveryController({ pending: () => [], recover: async () => { throw new Error("offline"); }, failed: (_error, delay) => failures.push(delay) });
  controller.start(); await settle();
  for (let attempt = 0; attempt < 9; attempt++) { t.mock.timers.tick(failures.at(-1)!); await settle(); }
  assert.equal(failures.at(-1), 60_000); assert.equal(failures.every((delay) => delay <= 60_000), true);
  controller.stop(); t.mock.timers.tick(600_000); await settle(); assert.equal(failures.length, 10); assert.equal(controller.isReady(), false);
});
