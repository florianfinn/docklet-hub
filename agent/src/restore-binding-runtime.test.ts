import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
import { UpdateBudget } from "./update-budget.js";
import { archiveEntries } from "./archive-reader.js";
import { backupTarHeader } from "./backup-archive.js";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "restore-runtime-binding-"));
const state = path.join(base, "state"); fs.mkdirSync(state);
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: base,
  DOCKER_AGENT_REGISTRY_FILE: path.join(state, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(state, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(state, "monitor.json") });
const { engine, registry, selfHealingState } = await import("./runtime/state.js");
const { backupSources, backupStore, restoreArchives } = await import("./runtime/backups.js");
after(() => fs.rmSync(base, { recursive: true, force: true }));
async function fixture(t: import("node:test").TestContext, file = false) {
  const root = fs.mkdtempSync(path.join(base, "data-")); fs.mkdirSync(path.join(root, "parent/sub"), { recursive: true });
  const outside = fs.mkdtempSync(path.join(base, "foreign-")); fs.writeFileSync(path.join(outside, "victim"), "untouched");
  const target = { kind: "container", containerName: path.basename(root) } as const;
  const raw = { Id: path.basename(root), Name: "/" + target.containerName, Config: { Image: "example/app:1.0" }, State: { Status: "exited", Running: false },
    Mounts: [{ Type: "bind", Source: root, Destination: "/data", RW: true }] };
  registry.replaceAll([{ containerId: raw.Id, containerName: target.containerName, imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(engine, "inspect", async () => raw); t.mock.method(engine, "inspectImage", async () => null);
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" })); t.mock.method(engine, "listContainerIds", async () => [raw.Id]);
  const stat = { name: "data", size: 0, mode: 0x80000000, mtime: "2026-10-08T00:00:00Z", linkTarget: "" };
  t.mock.method(engine, "statArchive", async () => stat);
  const sources = await backupSources(raw.Id, null, new UpdateBudget(60_000)); const sourceId = sources.resolved[0].source.sourceId;
  assert.equal(sources.archiveBlocked, false); assert.equal(sources.visibleRoots.get(sourceId), root);
  const entry = { name: file ? "data/parent/victim" : "data/parent/sub", kind: file ? "file" as const : "directory" as const, size: file ? 11 : 0, content: file ? Buffer.from("overwritten") : Buffer.alloc(0), mode: 0o700,
    uid: 12345, gid: 12345, changedAt: 0, linkTarget: "" };
  const saved = await backupStore.create(target, { mode: "stop", mounts: [{ sourceId, estimatedBytes: 1024 }] }, async () => ({ target: "/data",
    stream: (async function* () { yield backupTarHeader(entry); yield entry.content; yield Buffer.alloc((512 - entry.size % 512) % 512); yield Buffer.alloc(1024); })() }));
  const owners = new Map<number, { uid: number; gid: number }>(); const originalOpen = fs.promises.open; const originalStat = fs.promises.lstat;
  const owned = (stat: fs.Stats) => Object.assign(stat, owners.get(stat.ino) ?? {});
  t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof originalStat>) => owned(await originalStat(...args) as fs.Stats));
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args); const stat = handle.stat.bind(handle);
    t.mock.method(handle, "stat", async () => owned(await stat()));
    t.mock.method(handle, "chown", async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }); return handle;
  });
  const run = () => restoreArchives(sources, target, saved.backupId, [{ sourceId }], new UpdateBudget(60_000));
  return { root, outside, raw, target, entry, saved, sourceId, run, stat, owners };
}
for (const protectedMount of [false, true]) test(`R5: review symlink redirection cannot overwrite foreign file; protected writable mount=${protectedMount}`, async (t) => {
  const f = await fixture(t, true); let puts = 0; let swapped = false;
  if (protectedMount) t.mock.method(engine, "inspect", async () => ({ ...f.raw,
    Mounts: [...f.raw.Mounts, { Type: "bind", Source: state, Destination: "/agent-data", RW: true }] }));
  else t.mock.method(engine, "statArchive", async (_id: string, target: string) => {
    if (target === "/data/parent/victim" && !swapped) {
      await fs.promises.rename(path.join(f.root, "parent"), path.join(f.root, "parent-held"));
      await fs.promises.symlink(f.outside, path.join(f.root, "parent")); swapped = true;
    }
    return f.stat;
  });
  t.mock.method(engine, "putArchiveStream", async (_id: string, destination: string, stream: AsyncIterable<Buffer>) => {
    puts++; assert.equal(destination, "/data/parent");
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const restored = archiveEntries(Buffer.concat(chunks))[0]; assert.equal(restored.name, "victim");
    if (!swapped) { await fs.promises.rename(path.join(f.root, "parent"), path.join(f.root, "parent-held")); await fs.promises.symlink(f.outside, path.join(f.root, "parent")); }
    // Simulate Moby resolving the container path again after the host checks.
    await fs.promises.writeFile(path.join(f.root, "parent", restored.name), restored.content);
  });
  await assert.rejects(f.run(), { code: "restore-extract-failed" });
  assert.equal(await fs.promises.readFile(path.join(f.outside, "victim"), "utf8"), "untouched"); assert.equal(puts, 0);
});
test("R5: post-PUT ancestor replacement records a private path and recovery incident", async (t) => {
  const f = await fixture(t); let puts = 0;
  t.mock.method(engine, "putArchiveStream", async () => {
    puts++; const sub = path.join(f.root, "parent/sub"); const stat = await fs.promises.lstat(sub);
    f.owners.set(stat.ino, { uid: f.entry.uid, gid: f.entry.gid }); await fs.promises.chmod(sub, f.entry.mode);
    await fs.promises.rename(f.root, f.root + "-held"); await fs.promises.symlink(f.root + "-held", f.root);
  });
  await assert.rejects(f.run(), { code: "restore-extract-failed" }); assert.equal(puts, 1);
  const incidents = selfHealingState.status(DEFAULT_SELF_HEALING_CONFIG, false, 0).incidents.filter((item) => item.containerId === f.raw.Id);
  assert.equal(incidents.length, 1); assert.equal(incidents[0].cause.engineError, "restore-path-binding-changed");
  const archive = await backupStore.archive(f.target, f.saved.backupId, f.sourceId);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(path.dirname(archive.file), "restore-failure.json"), "utf8")),
    { sourceId: f.sourceId, path: "parent/sub", error: "restore-extract-failed" });
});
