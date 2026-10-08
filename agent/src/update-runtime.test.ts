import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import type { ComposeProject, UpOptions } from "./compose-cli.js";
import type { RawInspect } from "./engine.js";
import type { UpdateServiceSelection } from "contract";
const { buildRegistryEntries, toRegistryRequestBody } = await import(new URL("../../server/src/domain/containers/registry-sync.ts", import.meta.url).href);
import { UpdateRunner } from "./update-runner.js";
import { AgentJobs } from "./agent-jobs.js";
import { KeyedMutex } from "./concurrency.js";
import { runtimeStateOf } from "./runtime-actions.js";
import { UpdateBudget } from "./update-budget.js";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "updates-runtime-"));
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: directory,
  DOCKER_AGENT_REGISTRY_FILE: path.join(directory, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(directory, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(directory, "monitor.json") });
const { engine, registry, config, stopIntents } = await import("./runtime/state.js");
const { updateRuntimeOps: ops, updateCompose, authorizeUpdateSelection, updateJournal } = await import("./runtime/updates.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const offered = `sha256:${"b".repeat(64)}`;
const digest = `sha256:${"c".repeat(64)}`;
function fixture(t: TestContext, status = "running", compose = false, reference = "example/app:1.0") {
  fs.rmSync(path.join(directory, "update-pending.json"), { force: true });
  const projectDir = path.join(directory, "demo"); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "compose.yaml"), "services: {}\n");
  const labels: Record<string, string> = compose ? { "com.docker.compose.project": "demo", "com.docker.compose.service": "web",
    "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": path.join(projectDir, "compose.yaml"), "com.docker.compose.config-hash": "original-definition" } : {};
  let raw: RawInspect = { Id: "old", Name: "/demo", Image: "old-image", RestartCount: 0,
    Config: { Image: reference, Env: ["DEMO=value"], Labels: labels, Healthcheck: { Test: ["CMD", "true"] } },
    HostConfig: { RestartPolicy: { Name: "no" } }, State: { Status: status, Running: ["running", "paused", "restarting"].includes(status),
      Paused: status === "paused", Restarting: status === "restarting", StartedAt: "seen", Health: { Status: "healthy" } } };
  const original = structuredClone(raw); const trace: string[] = []; let count = 0;
  registry.replaceAll([{ containerId: raw.Id, containerName: "demo", imageRef: reference, allowed: true,
    ...(compose ? { compose: { projectDir, projectName: "demo", serviceName: "web", composeFileName: "compose.yaml", origin: "dashboard" as const } } : {}) }]);
  t.mock.property(config, "readOnly", false);
  const containers = new Map<string, RawInspect>([[raw.Id, raw]]);
  let taggedImage = "old-image";
  const get = (id: string) => {
    if (id === raw.Id) return raw;
    const found = containers.get(id); if (!found) throw new Error(`Unknown container ${id}`); return found;
  };
  t.mock.method(engine, "inspect", async (id: string) => structuredClone(get(id)));
  t.mock.method(engine, "inspectImage", async (ref: string) => {
    const id = ref === "old-image" || ref === "new-image" ? ref : taggedImage;
    return { Id: id, RepoDigests: [`example/app@${id === "old-image" ? digest : offered}`] };
  });
  t.mock.method(engine, "remoteManifestDigest", async () => offered);
  t.mock.method(engine, "pull", async () => { trace.push("pull"); taggedImage = "new-image"; });
  t.mock.method(engine, "tagImage", async (id: string, repo: string, tag: string) => {
    assert.equal(repo, "example/app"); assert.equal(tag, reference === "example/app" ? "latest" : "1.0"); trace.push(`tag:${id}`); taggedImage = id;
  });
  t.mock.method(engine, "listWithComposeLabels", async () => [...containers.values()].map((c) => ({ id: c.Id,
    name: c.Name.slice(1), image: c.Config!.Image!, imageId: c.Image!, status: c.State!.Status!, labels: c.Config!.Labels! })));
  t.mock.method(engine, "stop", async (id: string) => { trace.push("stop"); const c = get(id); c.State = { ...c.State, Running: false, Status: "exited" }; });
  t.mock.method(engine, "rename", async (id: string, name: string) => { trace.push("rename"); get(id).Name = `/${name}`; });
  t.mock.method(engine, "create", async (name: string, payload: Record<string, unknown>) => {
    const ref = String(payload.Image); trace.push(`create:${ref}`);
    raw = { ...structuredClone(original), Name: `/${name}`, Id: `new-${++count}`, Image: ref === "old-image" || ref === "new-image" ? ref : taggedImage,
      Config: { ...original.Config, Image: ref }, State: { Status: "created", Running: false, StartedAt: "" } };
    containers.set(raw.Id, raw); return raw.Id;
  });
  t.mock.method(engine, "start", async (id: string) => { trace.push("start"); get(id).State = { Running: true, Status: "running", StartedAt: "new-start", Health: { Status: "healthy" } }; });
  t.mock.method(engine, "pause", async (id: string, paused: boolean) => { trace.push(`pause:${paused}`); const c = get(id); c.State = { ...c.State, Paused: paused, Status: paused ? "paused" : "running" }; });
  t.mock.method(engine, "remove", async (id: string) => { trace.push("remove"); containers.delete(id); });
  t.mock.method(updateCompose, "config", async () => ({ services: { web: { image: reference } } }));
  t.mock.method(updateCompose, "up", async (project: ComposeProject, options: UpOptions) => {
    assert.equal(project.composeFileName, "compose.yaml"); assert.equal(options.noStart, true); assert.equal(options.noDeps, true);
    assert.equal(options.pullNever, true); assert.equal(options.removeOrphans, false);
    assert.equal("snapshotOverrideFileName" in options, false); assert.notEqual(options.rollbackOverride, true);
    containers.delete(raw.Id);
    await engine.create("demo", { Image: original.Config!.Image });
    trace.push(`compose:${raw.Config!.Image}`);
  });
  const selection: UpdateServiceSelection = { target: compose ? { kind: "compose", projectName: "demo", serviceName: "web" }
    : { kind: "container", containerName: "demo" }, expectedContainer: { containerId: "old", status, startedAt: "seen" }, startDeadlineSeconds: 10, backup: null };
  return { original, selection, trace, get: () => structuredClone(raw), tag: (id: string) => { taggedImage = id; }, tagged: () => taggedImage, change: (patch: Partial<RawInspect>) => { raw = { ...raw, ...patch }; containers.set(raw.Id, raw); } };
}
for (const compose of [false, true]) for (const status of ["running", "paused", "restarting", "exited", "created"]) {
  test(`immutable image and captured definition rollback: compose=${compose}, status=${status}`, async (t) => {
    const f = fixture(t, status, compose); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
    f.tag("new-image"); const finish = ops.intentional([snapshot]); const updated = await ops.exchange(snapshot, "new-image", new UpdateBudget(60_000), () => {}, () => {});
    assert.equal(updated.Image, "new-image"); assert.equal(updated.Config!.Image, "example/app:1.0"); assert.equal(updated.State!.Running, f.original.State!.Running);
    assert.equal(Boolean(updated.State!.Paused), status === "paused"); assert.equal(stopIntents.updateIntentActive(updated), true);
    const restored = await ops.rollback(snapshot, new UpdateBudget(60_000)); finish();
    assert.equal(restored.Image, "old-image"); assert.equal(restored.Config!.Image, "example/app:1.0"); assert.equal(f.tagged(), "old-image"); assert.equal(restored.State!.Running, f.original.State!.Running);
    assert.equal(Boolean(restored.State!.Paused), status === "paused");
    assert.equal(f.trace.filter((entry) => entry === "start").length, f.original.State!.Running ? 2 : 0);
    assert.equal(fs.readdirSync(path.join(directory, "demo")).some((file) => file.startsWith(".docklet-update")), false);
  });
}
for (const mismatch of ["target", "status", "startedAt"]) test(`R8 rejects ${mismatch} against registry identity`, async (t) => {
  const f = fixture(t); const selection = structuredClone(f.selection);
  if (mismatch === "target") selection.target = { kind: "container", containerName: "other" }; else selection.expectedContainer[mismatch as "status" | "startedAt"] = "changed";
  await assert.rejects(authorizeUpdateSelection(selection, null, new UpdateBudget(60_000)), { code: "state-changed" }); assert.equal(f.trace.length, 0);
});
for (const mode of ["local", "oneoff", "foreign", "scaled", "backup", "system"] as const) test(`preview rejects ineligible ${mode} before mutation`, async (t) => {
  const f = fixture(t, "running", mode === "scaled");
  if (mode === "local") t.mock.method(engine, "inspectImage", async () => ({ Id: "old-image", RepoDigests: [] }));
  if (mode === "oneoff") f.change({ Config: { ...f.original.Config, Labels: { "com.docker.compose.oneoff": "True" } } });
  if (mode === "foreign") registry.replaceAll([{ ...registry.get("old")!, externallyManaged: true }]);
  if (mode === "scaled") t.mock.method(updateCompose, "config", async () => ({ services: { web: { image: "example/app:1.0", scale: 2 } } }));
  if (mode === "backup") f.selection.backup = { mode: "stop", mounts: [{ sourceId: "data", estimatedBytes: 1 }] };
  if (mode === "system") registry.replaceAll([{ ...registry.get("old")!, imageRef: "example/docklet-hub:1.0" }]);
  if (["foreign", "system"].includes(mode)) await assert.rejects(ops.prepare(f.selection, null, new UpdateBudget(60_000)));
  else { const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
    assert.equal(snapshot.preview.blocker, mode === "local" ? "local-image-no-registry-digest" : mode === "oneoff" ? "oneoff-unsupported" : mode === "scaled" ? "scaled-service-unsupported" : "source-protected"); }
  assert.deepEqual(f.trace, []);
});
for (const status of ["unhealthy", "paused", "restarting"]) test(`preview warns about initial ${status}`, async (t) => {
  const f = fixture(t, status === "unhealthy" ? "running" : status);
  if (status === "unhealthy") f.change({ State: { ...f.original.State, Health: { Status: "unhealthy" } } });
  const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000)); assert.equal(snapshot.preview.warnings.includes(status as "unhealthy" | "paused" | "restarting"), true);
});
for (const restart of [undefined, "no", "always"]) for (const status of ["running", "restarting", "paused", "exited"]) {
  test(`completion recognition uses resolved dependencies, initial ${status}, restart=${restart}`, async (t) => {
    const f = fixture(t, status, true);
    t.mock.method(updateCompose, "config", async () => ({ services: { web: { image: "example/app:1.0", restart },
      worker: { image: "example/worker:1.0", depends_on: { web: { condition: "service_completed_successfully" } } } } }));
    const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
    assert.equal(snapshot.preview.acceptance, status === "exited" ? "created" : status === "paused" || restart === "always" ? "service" : "completion-job");
  });
}
test("rollback failure produces the existing incident and live notification", async (t) => {
  fixture(t); const { selfHealingState, selfHealingConfig, audit, dockerEvents } = await import("./runtime/state.js");
  selfHealingState.change((state) => { state.incidents = []; }); const notifications: string[] = []; const records: unknown[] = [];
  t.mock.method(dockerEvents, "notifyLifecycleChange", (id: string) => notifications.push(id));
  t.mock.method(audit, "write", (record: unknown) => records.push(record));
  ops.finished({ target: { kind: "container", containerName: "demo" }, outcome: "rollback-failed", updateError: "update-health-timeout", rollbackError: "update-rollback-failed",
    services: [{ target: { kind: "container", containerName: "demo" }, outcome: "rollback-failed", state: { containerId: "old", status: "exited", startedAt: "seen", exitCode: 1, health: null },
      imageId: "new-image", definitionHash: "hash", backupId: null, updateError: "update-health-timeout", rollbackError: "update-rollback-failed", resumeError: null }] }, "operator");
  assert.equal(selfHealingState.status(selfHealingConfig.read(), true, Date.now()).incidents.length, 1);
  assert.deepEqual(notifications, ["old"]); assert.equal(records.length, 1);
});
for (const compose of [false, true]) for (const rollback of [false, true]) test(`reference survives registry sync and second update: compose=${compose}, rollback=${rollback}`, async (t) => {
  const f = fixture(t, "running", compose);
  const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  const pulled = await ops.pull(snapshot, new UpdateBudget(60_000));
  await ops.exchange(snapshot, pulled.imageId, new UpdateBudget(60_000), () => {}, () => {});
  if (rollback) await ops.rollback(snapshot, new UpdateBudget(60_000));
  const current = f.get(); const anchor = registry.get(current.Id)!.compose;
  const entries = buildRegistryEntries([{ id: current.Id, name: "demo", image: current.Config!.Image!, externalManagement: null }],
    anchor ? [{ ...anchor, services: [{ serviceName: "web", containerId: current.Id }] }] : []);
  registry.replaceAll(toRegistryRequestBody(entries).entries);
  assert.equal(registry.expectedImageRef(current.Id), "example/app:1.0");
  const state = runtimeStateOf(current);
  const next = await ops.prepare({ ...f.selection, expectedContainer: { containerId: state.containerId!, status: state.status!, startedAt: state.startedAt } }, null, new UpdateBudget(60_000));
  assert.equal(next.preview.blocker, null); assert.equal(await ops.manifest(next, new UpdateBudget(60_000)), offered);
  assert.equal(next.preview.currentDigest, rollback ? digest : offered);
  assert.equal(f.tagged(), rollback ? "old-image" : "new-image");
  const second = await ops.pull(next, new UpdateBudget(60_000));
  const updated = await ops.exchange(next, second.imageId, new UpdateBudget(60_000), () => {}, () => {});
  assert.equal(updated.Image, "new-image"); assert.equal(updated.Config!.Image, "example/app:1.0");
});
for (const compose of [false, true]) test(`tag race refuses the wrong image before start and restores the old reference: compose=${compose}`, async (t) => {
  const f = fixture(t, "running", compose); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  f.tag("new-image");
  await assert.rejects(ops.exchange(snapshot, "different-image", new UpdateBudget(60_000), () => {}, () => {}), { code: "update-state-mismatch" });
  assert.equal(f.trace.includes("start"), false);
  const restored = await ops.rollback(snapshot, new UpdateBudget(60_000));
  assert.equal(restored.Image, "old-image"); assert.equal(restored.Config!.Image, "example/app:1.0"); assert.equal(f.tagged(), "old-image");
});
test("compose rollback refuses a changed config-hash", async (t) => {
  const f = fixture(t, "running", true); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  f.tag("new-image"); await ops.exchange(snapshot, "new-image", new UpdateBudget(60_000), () => {}, () => {});
  const up = updateCompose.up;
  t.mock.method(updateCompose, "up", async (...args: Parameters<typeof up>) => {
    await up(...args); f.change({ Config: { ...f.get().Config, Labels: { ...f.get().Config!.Labels, "com.docker.compose.config-hash": "changed" } } });
  });
  await assert.rejects(ops.rollback(snapshot, new UpdateBudget(60_000)), { code: "update-rollback-failed" });
});

for (const compose of [false, true]) test(`digest reference never pulls, exchanges or retags: compose=${compose}`, async (t) => {
  const f = fixture(t, "running", compose, `example/app@${digest}`);
  t.mock.method(engine, "remoteManifestDigest", async () => digest);
  t.mock.method(engine, "pull", async () => { assert.fail("Digest refs never pull"); });
  t.mock.method(engine, "tagImage", async () => { assert.fail("Digest refs never retag"); });
  let finish!: (result: import("contract").UpdateResult) => void;
  const completed = new Promise<import("contract").UpdateResult>((resolve) => { finish = resolve; });
  const runner = new UpdateRunner(new AgentJobs(() => true), new KeyedMutex(), { ...ops, finished: (result) => finish(result) });
  const preview = await runner.preview({ target: f.selection.target, services: [f.selection] }, null);
  assert.equal(preview.services[0].offeredDigest, digest); assert.equal(preview.services[0].currentDigest, digest);
  runner.start({ previewId: preview.previewId, target: preview.target, confirmed: true, services: [{ ...preview.services[0], offeredDigest: digest }] }, null);
  assert.equal((await completed).outcome, "unchanged"); assert.deepEqual(f.trace, []);
  const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  const restored = await ops.rollback(snapshot, new UpdateBudget(60_000));
  assert.equal(restored.Image, "old-image"); assert.equal(restored.Config!.Image, `example/app@${digest}`);
});

test("implicit latest reference is preserved and retagged on rollback", async (t) => {
  const f = fixture(t, "running", false, "example/app"); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  f.tag("new-image"); const updated = await ops.exchange(snapshot, "new-image", new UpdateBudget(60_000), () => {}, () => {});
  assert.equal(updated.Config!.Image, "example/app");
  const restored = await ops.rollback(snapshot, new UpdateBudget(60_000)); assert.equal(restored.Image, "old-image");
  assert.equal(restored.Config!.Image, "example/app"); assert.equal(f.tagged(), "old-image");
});
for (const compose of [false, true]) test(`journal survives a restart before assessment and clears after success: compose=${compose}`, async (t) => {
  const f = fixture(t, "running", compose); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  let entered!: () => void; let resume!: () => void;
  const starting = new Promise<void>((resolve) => { entered = resolve; }); const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const start = engine.start;
  t.mock.method(engine, "start", async (...args: Parameters<typeof start>) => { await start(...args); entered(); await waiting; });
  f.tag("new-image"); const updating = ops.exchange(snapshot, "new-image", new UpdateBudget(60_000), () => {}, () => {});
  await starting;
  const pending = updateJournal.read(); assert.match(pending[0].journalId!, /^[a-f0-9-]{36}$/);
  assert.deepEqual(pending.map(({ journalId: _journalId, ...entry }) => entry), [{ target: snapshot.preview.target, containerId: "old", containerName: "demo" }]);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, "update-pending.json"), "utf8"));
  assert.deepEqual(persisted, updateJournal.read()); resume(); await updating; assert.deepEqual(updateJournal.read(), []);
});
test("creation failure after retag reports the old tag state in the rollback incident", async (t) => {
  const f = fixture(t); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  const { selfHealingState, selfHealingConfig, audit, dockerEvents } = await import("./runtime/state.js");
  selfHealingState.change((state) => { state.incidents = []; }); t.mock.method(audit, "write", () => {}); t.mock.method(dockerEvents, "notifyLifecycleChange", () => {});
  t.mock.method(engine, "create", async () => { throw new Error("synthetic create failure"); });
  f.tag("new-image"); await assert.rejects(ops.rollback(snapshot, new UpdateBudget(60_000)), { code: "update-rollback-failed" });
  assert.equal(f.tagged(), "old-image");
  ops.finished({ target: f.selection.target, outcome: "rollback-failed", updateError: "update-start-failed", rollbackError: "update-rollback-failed",
    services: [{ target: f.selection.target, outcome: "rollback-failed", state: { containerId: "old", status: "exited", startedAt: "seen", exitCode: 0, health: null },
      imageId: "old-image", definitionHash: "hash", backupId: null, updateError: "update-start-failed", rollbackError: "update-rollback-failed", resumeError: null }] }, null);
  const incident = selfHealingState.status(selfHealingConfig.read(), true, Date.now()).incidents[0];
  assert.match(incident.cause.engineError!, /update-start-failed; tag-restored: example\/app:1\.0 -> old-image/);
});
for (const compose of [false, true]) test(`a competing host-wide retag is detected before starting the replacement: compose=${compose}`, async (t) => {
  const f = fixture(t, "running", compose); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  const pulled = await ops.pull(snapshot, new UpdateBudget(60_000)); const create = engine.create; let raced = false;
  t.mock.method(engine, "create", async (...args: Parameters<typeof create>) => { if (!raced) { raced = true; f.tag("old-image"); } return create(...args); });
  await assert.rejects(ops.exchange(snapshot, pulled.imageId, new UpdateBudget(60_000), () => {}, () => {}), { code: "update-state-mismatch" });
  assert.equal(f.trace.includes("start"), false);
  const restored = await ops.rollback(snapshot, new UpdateBudget(60_000)); assert.equal(restored.Image, "old-image");
});
for (const kind of ["large", "slow"] as const) test(`R3: ${kind} unselected mounts never request archives during preview or update`, async (t) => {
  const f = fixture(t); f.change({ Mounts: [{ Type: "bind", Source: "/synthetic/data", Destination: "/data", RW: true }] });
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" }));
  t.mock.method(engine, "listContainerIds", async () => ["old"]);
  t.mock.method(engine, "statArchive", async () => ({ name: "data", size: 0, mode: 0x80000000, mtime: "2026-10-08T00:00:00Z", linkTarget: "" }));
  let archiveCalls = 0;
  t.mock.method(engine, "openArchiveStream", async () => {
    archiveCalls++; throw new Error(`${kind} archive must never be opened`);
  });
  let complete!: (result: import("contract").UpdateResult) => void;
  const completed = new Promise<import("contract").UpdateResult>((resolve) => { complete = resolve; });
  const runner = new UpdateRunner(new AgentJobs(() => true), new KeyedMutex(), { ...ops,
    manifest: async () => offered,
    exchange: async (snapshot, imageId, _budget, verify, begin) => { begin(); verify(); f.change({ Image: imageId }); return f.get(); },
    finished: (result) => complete(result) });
  const preview = await runner.preview({ target: f.selection.target, services: [f.selection] }, null);
  assert.equal(preview.services[0].blocker, null); assert.equal(preview.services[0].offeredDigest, offered);
  assert.equal(preview.services[0].mounts[0].estimatedBytes, null); assert.equal(archiveCalls, 0);
  runner.start({ confirmed: true, target: preview.target, previewId: preview.previewId, services: preview.services.map((service) => ({ ...service, offeredDigest: service.offeredDigest! })) }, null);
  assert.equal((await completed).outcome, "updated"); assert.equal(archiveCalls, 0);
});
test("R3: selected slow mount times out separately after manifest and leaves the image update usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t);
  f.change({ Mounts: ["data", "cache"].map((name) => ({ Type: "bind", Source: `/synthetic/${name}`, Destination: `/${name}`, RW: true })) });
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" }));
  t.mock.method(engine, "listContainerIds", async () => ["old"]);
  t.mock.method(engine, "statArchive", async () => ({ name: "data", size: 0, mode: 0x80000000, mtime: "2026-10-08T00:00:00Z", linkTarget: "" }));
  const archives: string[] = []; const trace: string[] = [];
  t.mock.method(engine, "openArchiveStream", async () => (async function* () { yield Buffer.alloc(1024); })());
  const initial = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
  assert.equal(initial.preview.mounts[0].backupEligible, true, JSON.stringify(initial.preview.mounts));
  const sourceId = initial.preview.mounts.find((mount) => mount.target === "/data")!.sourceId;
  t.mock.method(engine, "openArchiveStream", async (_id: string, target: string, signal: AbortSignal) => {
    archives.push(target); trace.push("archive");
    return (async function* () {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); yield Buffer.alloc(1024);
    })();
  });
  const selected = { ...f.selection, backup: { mode: "stop" as const, mounts: [{ sourceId, estimatedBytes: null }] } };
  const runner = new UpdateRunner(new AgentJobs(() => true), new KeyedMutex(), { ...ops, manifest: async () => { trace.push("manifest"); return offered; } });
  const pending = runner.preview({ target: selected.target, services: [selected] }, null);
  for (let attempt = 0; !archives.length && attempt < 2000; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, ["manifest", "archive"]); t.mock.timers.tick(5000);
  const preview = await pending;
  assert.deepEqual(archives, ["/data"]); assert.equal(preview.services[0].mounts.find((mount) => mount.sourceId === sourceId)!.estimatedBytes, null);
  assert.equal(preview.services[0].blocker, null); assert.equal(preview.services[0].offeredDigest, offered);
  const withoutBackup = await runner.preview({ target: f.selection.target, services: [f.selection] }, null);
  assert.equal(withoutBackup.services[0].blocker, null); assert.deepEqual(archives, ["/data"]);
});
