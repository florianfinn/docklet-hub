import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRegistry } from "./registry.js";
import { SelfHealingStore } from "./self-healing-store.js";
import { UpdateJournal, recoverUpdateRemnants } from "./update-recovery.js";
import type { DockerEngine } from "./engine.js";
import { DEFAULT_SELF_HEALING_CONFIG } from "contract";

test("startup detects parked originals and unassessed replacements without removing containers", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const registry = new AgentRegistry(path.join(base, "registry.json"));
  const state = new SelfHealingStore(path.join(base, "healing.json"));
  const file = path.join(base, "pending.json"); const journal = new UpdateJournal(file);
  const parked = "demo-update-00000000-0000-4000-8000-000000000001";
  const targets = [{ kind: "container", containerName: "demo" }, { kind: "container", containerName: "worker" }] as const;
  registry.replaceAll(targets.map((target, i) => ({ containerId: `old-${i}`, containerName: target.containerName, imageRef: "example/app:1.0", allowed: true })));
  targets.forEach((target, i) => journal.begin({ target, containerId: `old-${i}`, containerName: target.containerName }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.doesNotMatch(fs.readFileSync(file, "utf8"), /Env|password|definition/);
  const containers = [{ id: "old-0", name: parked }, { id: "new-0", name: "demo" }, { id: "new-1", name: "worker" }].map((c) => ({ ...c, image: "example/app:1.0", imageId: "image", status: "running", labels: {} }));
  const notified: string[] = [];
  const deps = { engine: { listWithComposeLabels: async () => containers } as Pick<DockerEngine, "listWithComposeLabels">,
    registry, state, journal: new UpdateJournal(file), basePath: base, notify: (id: string) => notified.push(id) };
  await recoverUpdateRemnants(deps);
  const incidents = state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents;
  assert.equal(incidents.length, 2); assert.match(incidents[0].cause.engineError!, new RegExp(parked));
  assert.match(incidents[1].cause.engineError!, /worker/); assert.deepEqual(notified, ["old-0", "new-0", "new-1"]);
  assert.equal(containers.length, 3); assert.equal(journal.read().length, 0);
  await recoverUpdateRemnants(deps); assert.equal(state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents.length, 2);
});
test("legacy parked originals are discovered without a journal", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const registry = new AgentRegistry(path.join(base, "registry.json")); const state = new SelfHealingStore(path.join(base, "healing.json"));
  const parked = "demo-update-00000000-0000-4000-8000-000000000001";
  await recoverUpdateRemnants({ registry, state, journal: new UpdateJournal(path.join(base, "pending.json")), basePath: base, notify: () => {},
    engine: { listWithComposeLabels: async () => [{ id: "old", name: parked, image: "example/app:1.0", imageId: "image", status: "exited", labels: {} }] } });
  assert.equal(state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents[0].cause.engineError, `update-interrupted: ${parked}`);
});
test("startup deletes resolved environment snapshots only within anchored real project directories", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "update-outside-"));
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const project = path.join(base, "demo"); fs.mkdirSync(project); fs.symlinkSync(outside, path.join(base, "linked"));
  const temporary = ".docklet-update-00000000-0000-4000-8000-000000000001.json";
  for (const dir of [project, outside]) fs.writeFileSync(path.join(dir, temporary), '{"environment":{"TOKEN":"synthetic"}}');
  fs.writeFileSync(path.join(project, "compose.yaml"), "services: {}\n"); fs.writeFileSync(path.join(project, ".docklet-update-user.json"), "keep");
  await recoverUpdateRemnants({ registry: new AgentRegistry(path.join(base, "registry.json")), state: new SelfHealingStore(path.join(base, "healing.json")),
    journal: new UpdateJournal(path.join(base, "pending.json")), basePath: base, notify: () => {},
    engine: { listWithComposeLabels: async () => [project, outside, path.join(base, "linked")].map((dir, i) => ({ id: `id-${i}`, name: `name-${i}`,
      image: "example/app:1.0", imageId: "image", status: "running", labels: { "com.docker.compose.project.working_dir": dir } })) } });
  assert.equal(fs.existsSync(path.join(project, temporary)), false); assert.equal(fs.existsSync(path.join(outside, temporary)), true);
  assert.equal(fs.existsSync(path.join(project, "compose.yaml")), true); assert.equal(fs.existsSync(path.join(project, ".docklet-update-user.json")), true);
});
test("startup inspection failures fail recovery instead of silently skipping it", async () => {
  await assert.rejects(recoverUpdateRemnants({ engine: { listWithComposeLabels: async () => { throw new Error("unreachable"); } }, registry: {} as AgentRegistry,
    state: {} as SelfHealingStore, journal: {} as UpdateJournal, basePath: "/unused", notify: () => {} }), /unreachable/);
});
test("startup completes remnant recovery before accepting requests or enabling healing", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.equal(source.indexOf("await recoverUpdates();") > 0, true);
  assert.equal(source.indexOf("await recoverUpdates();") < source.indexOf("server.listen("), true);
  assert.equal(source.indexOf("await recoverUpdates();") < source.indexOf("  startSelfHealing();"), true);
});
test("interrupted exchanges report a missing target instead of discarding the journal", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const state = new SelfHealingStore(path.join(base, "healing.json")); const journal = new UpdateJournal(path.join(base, "pending.json"));
  journal.begin({ target: { kind: "compose", projectName: "demo", serviceName: "web" }, containerId: "original", containerName: "demo-web" });
  const notified: string[] = [];
  await recoverUpdateRemnants({ engine: { listWithComposeLabels: async () => [] }, registry: new AgentRegistry(path.join(base, "registry.json")),
    state, journal, basePath: base, notify: (id) => notified.push(id) });
  const incident = state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents[0];
  assert.equal(incident.cause.engineError, "update-interrupted: demo-web"); assert.equal(incident.target.kind, "compose");
  assert.deepEqual(notified, ["original"]); assert.deepEqual(journal.read(), []);
});
