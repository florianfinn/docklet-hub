import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-healing-"));
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: base,
  DOCKER_AGENT_REGISTRY_FILE: path.join(base, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(base, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(base, "monitor.json") });
const { registry, engine, selfHealingState, selfHealingConfig, config } = await import("./runtime/state.js");
const { updateJournal, updateRecovery, recoveryBlocksHealing } = await import("./runtime/update-recovery.js");
const { selfHealing } = await import("./runtime/self-healing.js");
after(() => { updateRecovery.stop(); selfHealing.shutdown(); fs.rmSync(base, { recursive: true, force: true }); });
test("real healing ports skip original, parked original and replacement while recovery is pending", async (t) => {
  t.mock.property(config, "readOnly", false);
  registry.replaceAll([{ containerId: "old", containerName: "demo", imageRef: "example/app:1.0", allowed: true }]);
  updateJournal.begin({ target: { kind: "container", containerName: "demo" }, containerId: "old", containerName: "demo" });
  selfHealing.setObserving(true);
  t.mock.method(engine, "inspect", async () => { assert.fail("Journal targets cannot heal"); });
  for (const [id, name] of [["old", "demo"], ["old", "demo-update-00000000-0000-4000-8000-000000000001"], ["new", "demo"]]) {
    const raw = { Id: id, Name: `/${name}`, Config: {}, State: { Running: false, Status: "exited", ExitCode: 1 } };
    assert.equal(recoveryBlocksHealing(raw), true); selfHealing.reconcile(raw);
    selfHealing.observe({ action: "die", containerId: id, atMs: Date.now() }, raw, "unexpected");
  }
  await selfHealing.tick();
  const status = selfHealingState.status(selfHealingConfig.read(), true, Date.now());
  assert.deepEqual(status.budgets, []); assert.deepEqual(status.incidents, []);
  assert.equal(recoveryBlocksHealing({ Id: "other", Name: "/other", Config: {} }), false);
});
