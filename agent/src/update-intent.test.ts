import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StopIntentStore } from "./stop-intent.js";
import type { RawInspect } from "./engine.js";
import { SelfHealingController } from "./self-healing.js";
import { SelfHealingStore } from "./self-healing-store.js";

test("original and replacement stop/die events consume no healing budget or incident, including delayed events", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "update-intent-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 10; const intents = new StopIntentStore(path.join(directory, "intents.json"), () => now);
  const state = new SelfHealingStore(path.join(directory, "healing.json"));
  const original: RawInspect = { Id: "old", Name: "/demo", Config: {}, State: { Status: "running", Running: true } };
  const replacement = { ...original, Id: "new", State: { Status: "exited", Running: false, ExitCode: 1 } };
  const policy = { enabled: true, attempts: 2, retryDelaysSeconds: [1], stabilityWindowSeconds: 600, maintenanceDurationSeconds: 3600 };
  const controller = new SelfHealingController(state, { intentional: (raw) => intents.updateIntentActive(raw),
    eligible: () => true, config: () => policy,
    check: async () => replacement,
    inspect: async () => replacement, start: async () => { throw new Error("update must never heal"); },
    evidence: async () => { throw new Error("update must never create an incident"); } }, () => now);
  controller.setObserving(true);
  const finish = intents.beginUpdate([original]);
  for (const raw of [original, replacement]) for (const action of ["stop", "die", "destroy"] as const) {
    const event = { action, containerId: raw.Id, atMs: now, attributes: {} };
    assert.equal(intents.updateIntentActive(raw), true); intents.observe(event, raw);
    controller.reconcile(raw); controller.observe(event, raw, "unexpected");
  }
  assert.equal(state.status(policy, true, now).budgets.length, 0); assert.equal(state.status(policy, true, now).incidents.length, 0);
  now = 20; finish(); now = 30;
  assert.equal(intents.updateIntentActive(replacement), false); assert.equal(intents.updateIntentActive(replacement, 15), true);
});
