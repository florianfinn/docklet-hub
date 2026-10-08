import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateBudget } from "./update-budget.js";
import { backupTarHeader } from "./backup-archive.js";
import { archiveEntries } from "./archive-reader.js";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "data-runtime-"));
const state = path.join(base, "state"); fs.mkdirSync(state);
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: base,
  DOCKER_AGENT_REGISTRY_FILE: path.join(state, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(state, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(state, "monitor.json") });
const { engine, registry, stopIntents } = await import("./runtime/state.js");
const { restoreRunner } = await import("./runtime/restores.js");
const { agentJobs, updateRuntimeOps } = await import("./runtime/updates.js");
const { backupSources, backupStore, restoreArchives, dataJournal } = await import("./runtime/backups.js");
after(() => fs.rmSync(base, { recursive: true, force: true }));
for (const visible of [true, false]) for (const mode of ["stop", "live"] as const) test(`K18–K22: ${mode} backup and restore after replacement; visible=${visible}`, async (t) => {
  fs.rmSync(path.join(state, "data-pending.json"), { force: true });
  const source = path.join(base, "data"); fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, "file"), "old");
  let raw = { Id: "original", Name: "/demo", Image: "image", Config: { Image: "example/app:1.0", Labels: {} },
    Mounts: [{ Type: "bind", Source: visible ? source : "/synthetic/invisible", Destination: "/data", RW: true }],
    State: { Status: "running", Running: true, Paused: false, StartedAt: "seen" }, HostConfig: {} };
  const trace: string[] = []; const target = { kind: "container", containerName: "demo" } as const;
  registry.replaceAll([{ containerId: raw.Id, containerName: "demo", imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(engine, "inspect", async () => structuredClone(raw));
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" }));
  t.mock.method(engine, "listContainerIds", async () => [raw.Id]);
  t.mock.method(engine, "inspectImage", async () => ({ Id: "image", RepoDigests: [`example/app@sha256:${"a".repeat(64)}`] }));
  t.mock.method(engine, "statArchive", async (_id: string, destination: string) => ({ name: path.posix.basename(destination), size: destination.endsWith("file") ? 3 : 0,
    mode: destination.endsWith("file") ? 0o644 : 0x80000000, mtime: "2026-10-08T00:00:00Z", linkTarget: "" }));
  const entry = { name: "data", kind: "directory" as const, size: 0, content: Buffer.alloc(0), mode: 0o755,
    uid: process.getuid!(), gid: process.getgid!(), changedAt: 0, linkTarget: "" };
  const archive = Buffer.concat([backupTarHeader(entry), backupTarHeader({ ...entry, name: "data/file", kind: "file", size: 3, mode: 0o644 }), Buffer.from("new"), Buffer.alloc(509),
    backupTarHeader({ ...entry, name: "data/current", kind: "symlink", mode: 0o777, linkTarget: "file" }),
    backupTarHeader({ ...entry, name: "data/outside", kind: "symlink", mode: 0o777, linkTarget: "/outside" }), Buffer.alloc(1024)]);
  t.mock.method(engine, "openArchiveStream", async () => (async function* () { for (let offset = 0; offset < archive.length; offset += 127) yield archive.subarray(offset, offset + 127); })());
  t.mock.method(engine, "stop", async () => { trace.push("stop"); raw.State = { ...raw.State, Running: false, Status: "exited" }; });
  t.mock.method(engine, "start", async () => { trace.push("start"); raw.State = { ...raw.State, Running: true, Status: "running" }; });
  t.mock.method(engine, "putArchiveStream", async (_id: string, destination: string, stream: AsyncIterable<Buffer>) => {
    assert.equal(destination, "/"); trace.push("put"); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const restored = archiveEntries(Buffer.concat(chunks));
    assert.equal(restored[1].content.toString(), "new");
    assert.equal(restored.some((item) => item.kind === "symlink"), false);
  });
  const sources = await backupSources(raw.Id, null, new UpdateBudget(60_000), true);
  assert.equal(sources.resolved[0].source.backupEligible, true); assert.equal(sources.resolved[0].source.restoreEligible, true);
  const sourceId = sources.resolved[0].source.sourceId;
  const snapshot = await updateRuntimeOps.prepare({ target, expectedContainer: { containerId: raw.Id, status: "running", startedAt: "seen" },
    startDeadlineSeconds: 120, backup: { mode, mounts: [{ sourceId, estimatedBytes: sources.resolved[0].source.estimatedBytes }] } }, null, new UpdateBudget(60_000));
  const finish = updateRuntimeOps.intentional([snapshot]);
  const backupId = await updateRuntimeOps.backup!(snapshot, new UpdateBudget(4_320_000), () => false);
  const saved = await backupStore.archive(target, backupId, sourceId);
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(saved.file), "metadata.json"), "utf8"));
  assert.deepEqual(metadata.skipped, [{ path: "outside", reason: "absolute-link-target", sourceId }]);
  assert.equal(archiveEntries(fs.readFileSync(saved.file)).at(-1)!.linkTarget, "file");
  assert.equal(stopIntents.updateIntentActive(raw), true); assert.equal(trace.includes("stop"), mode === "stop");
  await updateRuntimeOps.resume!(snapshot, new UpdateBudget(720_000)); finish();
  assert.equal(raw.State.Running, true); assert.deepEqual(dataJournal.read(), []);
  raw = { ...raw, Id: "replacement" }; registry.replaceContainerId("original", raw.Id);
  const current = await backupSources(raw.Id, null, new UpdateBudget(60_000));
  assert.equal(current.resolved[0].source.sourceId, sourceId);
  assert.equal((await backupStore.list(target)).some((entry) => entry.backupId === backupId), true);
  await restoreArchives(current, target, backupId, [{ sourceId }], new UpdateBudget(60_000), true);
  await restoreArchives(current, target, backupId, [{ sourceId }], new UpdateBudget(60_000));
  const preview = await restoreRunner.preview({ target, backupId, mounts: [{ sourceId }] }, null);
  const { jobId } = restoreRunner.start({ target, backupId, mounts: preview.mounts, previewId: preview.previewId,
    expectedContainer: preview.expectedContainer, startDeadlineSeconds: 120, confirmed: true }, null);
  let progress = agentJobs.get(jobId);
  for (let attempt = 0; progress?.phase !== "completed" && attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5)); progress = agentJobs.get(jobId);
  }
  assert.equal(progress?.phase, "completed");
  if (progress?.kind === "restore") {
    assert.equal(progress.extractStarted, true); assert.equal(progress.result?.outcome, "restored");
    assert.equal(progress.result?.state.status, "running");
  } else assert.fail("restore progress is missing");
  if (visible) {
    assert.equal(fs.readFileSync(path.join(source, "file"), "utf8"), "new");
    assert.equal(fs.readlinkSync(path.join(source, "current")), "file");
  } else {
    assert.equal(trace.includes("put"), true);
    const directory = path.dirname(saved.file);
    const file = fs.readdirSync(directory).find((name) => name.startsWith("restore-skipped-"))!;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")).skipped,
      [{ path: "current", reason: "archive-put-link-unsupported" }]);
  }
});

test("restore rejects a scaled Compose service before backup lookup or extraction", async (t) => {
  const projectDir = path.join(base, "demo"); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "compose.yaml"), "services: {}\n");
  const target = { kind: "compose", projectName: "demo", serviceName: "web" } as const;
  const labels = { "com.docker.compose.project": "demo", "com.docker.compose.service": "web",
    "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": path.join(projectDir, "compose.yaml") };
  registry.replaceAll([{ containerId: "scaled", containerName: "demo-web", imageRef: "example/app:1.0", allowed: true,
    compose: { projectDir, projectName: "demo", serviceName: "web", composeFileName: "compose.yaml", origin: "dashboard" } }]);
  t.mock.method(engine, "inspect", async () => ({ Id: "scaled", Name: "/demo-web", Config: { Image: "example/app:1.0", Labels: labels },
    State: { Status: "running", Running: true, StartedAt: "seen" }, HostConfig: {} }));
  t.mock.method(engine, "listWithComposeLabels", async () => ["first", "second"].map((id) => ({ id, name: id, image: "example/app:1.0", imageId: "image", status: "running", labels })));
  await assert.rejects(restoreRunner.preview({ target, backupId: "absent", mounts: [{ sourceId: "data" }] }, null), { code: "scaled-service-unsupported" });
});
test("R1: visible root metadata fallback sends a named owner header and persists a failed path", async (t) => {
  fs.rmSync(path.join(state, "data-pending.json"), { force: true });
  const root = path.join(base, "metadata-data"); fs.mkdirSync(root, { recursive: true });
  const target = { kind: "container", containerName: "metadata-demo" } as const;
  const raw = { Id: "metadata", Name: "/metadata-demo", Config: { Image: "example/app:1.0" }, State: { Status: "exited", Running: false },
    Mounts: [{ Type: "bind", Source: root, Destination: "/data", RW: true }] };
  registry.replaceAll([{ containerId: raw.Id, containerName: "metadata-demo", imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(engine, "inspect", async () => raw); t.mock.method(engine, "inspectImage", async () => null);
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" })); t.mock.method(engine, "listContainerIds", async () => [raw.Id]);
  t.mock.method(engine, "statArchive", async () => ({ name: "data", size: 0, mode: 0x80000000, mtime: "2026-10-08T00:00:00Z", linkTarget: "" }));
  const sources = await backupSources(raw.Id, null, new UpdateBudget(60_000)); const sourceId = sources.resolved[0].source.sourceId;
  const entry = { name: "data", kind: "directory" as const, size: 0, content: Buffer.alloc(0), mode: 0o700, uid: 12345, gid: 12345, changedAt: 0, linkTarget: "" };
  const saved = await backupStore.create(target, { mode: "stop", mounts: [{ sourceId, estimatedBytes: 1024 }] }, async () => ({ target: "/data",
    stream: (async function* () { yield backupTarHeader(entry); yield Buffer.alloc(1024); })() }));
  const originalOpen = fs.promises.open; let put = false;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    t.mock.method(handle, "chown", async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }); return handle;
  });
  t.mock.method(engine, "putArchiveStream", async (_id: string, destination: string, stream: AsyncIterable<Buffer>) => {
    put = true; assert.equal(destination, "/"); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const header = archiveEntries(Buffer.concat(chunks))[0]; assert.equal(header.name, "data"); assert.equal(header.uid, 12345); assert.equal(header.gid, 12345);
  });
  await assert.rejects(restoreArchives(sources, target, saved.backupId, [{ sourceId }], new UpdateBudget(60_000)), { code: "restore-extract-failed" });
  assert.equal(put, true);
  const archive = await backupStore.archive(target, saved.backupId, sourceId);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(archive.file), "restore-failure.json"), "utf8")), { sourceId, path: "metadata-data", error: "restore-extract-failed" });
});
