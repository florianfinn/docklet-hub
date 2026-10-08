import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import type { ComposeProject, UpOptions } from "./compose-cli.js";
import type { RawInspect } from "./engine.js";
import type { UpdateServiceSelection } from "contract";
import { UpdateBudget } from "./update-budget.js";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "updates-runtime-"));
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: directory,
  DOCKER_AGENT_REGISTRY_FILE: path.join(directory, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(directory, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(directory, "monitor.json") });
const { engine, registry, config, stopIntents } = await import("./runtime/state.js");
const { updateRuntimeOps: ops, updateCompose, authorizeUpdateSelection } = await import("./runtime/updates.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const digest = `sha256:${"c".repeat(64)}`;
function fixture(t: TestContext, status = "running", compose = false) {
  const projectDir = path.join(directory, "demo"); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "compose.yaml"), "services: {}\n");
  const labels: Record<string, string> = compose ? { "com.docker.compose.project": "demo", "com.docker.compose.service": "web",
    "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": path.join(projectDir, "compose.yaml") } : {};
  let raw: RawInspect = { Id: "old", Name: "/demo", Image: "old-image", RestartCount: 0,
    Config: { Image: "example/app:1.0", Env: ["DEMO=value"], Labels: labels, Healthcheck: { Test: ["CMD", "true"] } },
    HostConfig: { RestartPolicy: { Name: "no" } }, State: { Status: status, Running: ["running", "paused", "restarting"].includes(status),
      Paused: status === "paused", Restarting: status === "restarting", StartedAt: "seen", Health: { Status: "healthy" } } };
  const original = structuredClone(raw); const trace: string[] = []; let count = 0;
  registry.replaceAll([{ containerId: raw.Id, containerName: "demo", imageRef: "example/app:1.0", allowed: true,
    ...(compose ? { compose: { projectDir, projectName: "demo", serviceName: "web", composeFileName: "compose.yaml", origin: "dashboard" as const } } : {}) }]);
  t.mock.property(config, "readOnly", false);
  t.mock.method(engine, "inspect", async () => structuredClone(raw));
  t.mock.method(engine, "inspectImage", async () => ({ Id: "old-image", RepoDigests: [`example/app@${digest}`] }));
  t.mock.method(engine, "listWithComposeLabels", async () => [{ id: raw.Id, name: "demo", image: "example/app:1.0", status: raw.State!.Status!, labels: raw.Config!.Labels! }]);
  t.mock.method(engine, "stop", async () => { trace.push("stop"); raw.State = { ...raw.State, Running: false, Status: "exited" }; });
  t.mock.method(engine, "rename", async () => { trace.push("rename"); });
  t.mock.method(engine, "create", async (_name: string, payload: Record<string, unknown>) => {
    trace.push(`create:${payload.Image}`); raw = { ...structuredClone(original), Id: `new-${++count}`, Image: String(payload.Image),
      Config: { ...original.Config, Image: String(payload.Image) }, State: { Status: "created", Running: false, StartedAt: "" } }; return raw.Id;
  });
  t.mock.method(engine, "start", async () => { trace.push("start"); raw.State = { Running: true, Status: "running", StartedAt: "new-start", Health: { Status: "healthy" } }; });
  t.mock.method(engine, "pause", async (_id: string, paused: boolean) => { trace.push(`pause:${paused}`); raw.State = { ...raw.State, Paused: paused, Status: paused ? "paused" : "running" }; });
  t.mock.method(engine, "remove", async () => { trace.push("remove"); });
  t.mock.method(updateCompose, "config", async () => ({ services: { web: { image: "example/app:1.0" } } }));
  t.mock.method(updateCompose, "up", async (project: ComposeProject, options: UpOptions) => {
    assert.equal(project.composeFileName, "compose.yaml"); assert.equal(options.noStart, true); assert.equal(options.noDeps, true);
    assert.equal(options.pullNever, true); assert.equal(options.removeOrphans, false);
    const file = path.join(project.projectDir, options.snapshotOverrideFileName!); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8")); trace.push(`compose:${snapshot.services.web.image}`);
    raw = { ...structuredClone(original), Id: `new-${++count}`, Image: snapshot.services.web.image, State: { Status: "created", Running: false, StartedAt: "" } };
  });
  const selection: UpdateServiceSelection = { target: compose ? { kind: "compose", projectName: "demo", serviceName: "web" }
    : { kind: "container", containerName: "demo" }, expectedContainer: { containerId: "old", status, startedAt: "seen" }, startDeadlineSeconds: 10, backup: null };
  return { original, selection, trace, change: (patch: Partial<RawInspect>) => { raw = { ...raw, ...patch }; } };
}
for (const compose of [false, true]) for (const status of ["running", "paused", "restarting", "exited", "created"]) {
  test(`immutable image and captured definition rollback: compose=${compose}, status=${status}`, async (t) => {
    const f = fixture(t, status, compose); const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
    const finish = ops.intentional([snapshot]); const updated = await ops.exchange(snapshot, "new-image", new UpdateBudget(60_000), () => {}, () => {});
    assert.equal(updated.Image, "new-image"); assert.equal(updated.State!.Running, f.original.State!.Running);
    assert.equal(Boolean(updated.State!.Paused), status === "paused"); assert.equal(stopIntents.updateIntentActive(updated), true);
    const restored = await ops.rollback(snapshot, new UpdateBudget(60_000)); finish();
    assert.equal(restored.Image, "old-image"); assert.equal(restored.State!.Running, f.original.State!.Running);
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
for (const mode of ["local", "oneoff", "foreign", "scaled", "backup", "system"] as const) test(`preview rejects unsupported ${mode} before mutation`, async (t) => {
  const f = fixture(t, "running", mode === "scaled");
  if (mode === "local") t.mock.method(engine, "inspectImage", async () => ({ Id: "old-image", RepoDigests: [] }));
  if (mode === "oneoff") f.change({ Config: { ...f.original.Config, Labels: { "com.docker.compose.oneoff": "True" } } });
  if (mode === "foreign") registry.replaceAll([{ ...registry.get("old")!, externallyManaged: true }]);
  if (mode === "scaled") t.mock.method(updateCompose, "config", async () => ({ services: { web: { image: "example/app:1.0", scale: 2 } } }));
  if (mode === "backup") f.selection.backup = { mode: "stop", mounts: [{ sourceId: "data", estimatedBytes: 1 }] };
  if (mode === "system") registry.replaceAll([{ ...registry.get("old")!, imageRef: "example/docklet-hub:1.0" }]);
  if (["foreign", "system"].includes(mode)) await assert.rejects(ops.prepare(f.selection, null, new UpdateBudget(60_000)));
  else { const snapshot = await ops.prepare(f.selection, null, new UpdateBudget(60_000));
    assert.equal(snapshot.preview.blocker, mode === "local" ? "local-image-no-registry-digest" : mode === "oneoff" ? "oneoff-unsupported" : mode === "scaled" ? "scaled-service-unsupported" : "backup-incomplete"); }
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
