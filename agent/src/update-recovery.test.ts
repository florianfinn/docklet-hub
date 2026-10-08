import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRegistry } from "./registry.js";
import { SelfHealingStore } from "./self-healing-store.js";
import { UpdateJournal, recoverUpdateRemnants } from "./update-recovery.js";
import type { DockerEngine } from "./engine.js";
import { DEFAULT_SELF_HEALING_CONFIG, SELF_HEALING_RECOMMENDATION } from "contract";

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
  registry.replaceAll([{ containerId: "old", containerName: "demo", imageRef: "example/app:1.0", allowed: true }]);
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
test("restart appends context without overwriting an open cause and closed unchanged remnants stay acknowledged", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const registry = new AgentRegistry(path.join(base, "registry.json")); const stateFile = path.join(base, "healing.json");
  const state = new SelfHealingStore(stateFile); const file = path.join(base, "pending.json"); const journal = new UpdateJournal(file);
  const target = { kind: "container", containerName: "demo" } as const;
  registry.replaceAll([{ containerId: "old", containerName: "demo", imageRef: "example/app:1.0", allowed: true }]);
  journal.begin({ target, containerId: "old", containerName: "demo", journalId: "journal-identity" });
  const parked = { id: "old", name: "demo-update-00000000-0000-4000-8000-000000000001", image: "example/app:1.0", imageId: "old-image", status: "exited", labels: {} };
  const original: import("contract").SelfHealingIncident = { id: "incident", target, containerId: "old", openedAt: new Date().toISOString(), closedAt: null, closedReason: null,
    cause: { exitCode: 17, engineError: "update-rollback-failed; tag-restored: example/app:1.0" }, attempts: [],
    recommendation: SELF_HEALING_RECOMMENDATION, logs: { available: false as const, reason: "logs-unavailable" as const } };
  state.change((value) => { value.incidents.push(original); });
  const recover = (store: SelfHealingStore) => recoverUpdateRemnants({ registry, state: store, journal: new UpdateJournal(file), basePath: base,
    notify: () => {}, engine: { listWithComposeLabels: async () => [parked] } });
  await recover(state);
  const open = state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents[0];
  assert.equal(open.cause.exitCode, 17); assert.match(open.cause.engineError!, /^update-rollback-failed; tag-restored: example\/app:1\.0; update-interrupted:/);
  state.change((value) => { value.incidents[0].closedAt = new Date().toISOString(); value.incidents[0].closedReason = "acknowledged"; });
  const restarted = new SelfHealingStore(stateFile); await recover(restarted);
  assert.equal(restarted.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents.length, 1);
  assert.notEqual(restarted.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents[0].closedAt, null);
  parked.status = "running"; await recover(new SelfHealingStore(stateFile));
  assert.equal(new SelfHealingStore(stateFile).status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents.length, 2);
});
test("parked-name pattern never turns unrelated containers into update incidents", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const state = new SelfHealingStore(path.join(base, "healing.json"));
  const named = { id: "foreign", name: "foreign-update-00000000-0000-4000-8000-000000000001", image: "example/app:1.0", imageId: "image", status: "exited", labels: {} };
  await recoverUpdateRemnants({ registry: new AgentRegistry(path.join(base, "registry.json")), state, journal: new UpdateJournal(path.join(base, "pending.json")),
    basePath: base, notify: () => { assert.fail("Unrelated container must not notify"); }, engine: { listWithComposeLabels: async () => [named] } });
  assert.deepEqual(state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents, []);
});
for (const contents of ["{invalid", JSON.stringify([{ containerName: "demo", containerId: "old" }])]) test("invalid journal is quarantined before any Engine request and reported without exposing its contents", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-recovery-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "pending.json"); fs.writeFileSync(file, contents, { mode: 0o644 });
  const state = new SelfHealingStore(path.join(base, "healing.json"));
  await assert.rejects(recoverUpdateRemnants({ registry: new AgentRegistry(path.join(base, "registry.json")), state, journal: new UpdateJournal(file), basePath: base,
    notify: () => {}, engine: { listWithComposeLabels: async () => { assert.fail("Corrupt journals are assessed before Docker"); } } }), /update-journal-invalid/);
  const renamed = fs.readdirSync(base).find((name) => name.startsWith("pending.json.invalid-"))!;
  assert.match(renamed, /\.invalid-\d+-/); assert.equal(fs.existsSync(file), false);
  assert.equal(fs.statSync(path.join(base, renamed)).mode & 0o777, 0o600); assert.equal(fs.readFileSync(path.join(base, renamed), "utf8"), contents);
  const cause = state.status(DEFAULT_SELF_HEALING_CONFIG, true, Date.now()).incidents[0].cause.engineError!;
  assert.match(cause, /update-journal-invalid/); assert.equal(cause.includes(contents), false);
});

test("damaged recovery history is quarantined with a named warning and bounded retention", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "update-history-")); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "pending.json"); const journal = new UpdateJournal(file); const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const entry = { target: { kind: "container" as const, containerName: "demo" }, containerId: "old", containerName: "demo", journalId: "journal" };
  for (let index = 0; index < 5; index++) {
    fs.writeFileSync(`${file}.seen`, "{", { mode: 0o600 });
    assert.equal(journal.seen(entry, "demo", "state"), false);
  }
  const quarantined = fs.readdirSync(base).filter((name) => name.startsWith("pending.json.seen.invalid-"));
  assert.equal(quarantined.length, 3); assert.equal(warnings.length, 5);
  assert.equal(warnings.every((warning) => /pending\.json\.seen\.invalid-/.test(warning)), true);
  for (const name of quarantined) assert.equal(fs.statSync(path.join(base, name)).mode & 0o777, 0o600);
  for (let index = 0; index < 300; index++) journal.remember({ ...entry, journalId: String(index) }, `demo-${index}`, "state");
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(`${file}.seen`, "utf8"))).length <= 512, true);
});
