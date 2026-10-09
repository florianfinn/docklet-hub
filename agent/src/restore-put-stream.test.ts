import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateBudget, UpdateFailure } from "./update-budget.js";
import { backupTarHeader } from "./backup-archive.js";
import { archiveEntries, type ArchiveEntry } from "./archive-reader.js";
import { EngineError } from "./engine-errors.js";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "restore-put-"));
const state = path.join(base, "state"); fs.mkdirSync(state);
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: base,
  DOCKER_AGENT_REGISTRY_FILE: path.join(state, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(state, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(state, "monitor.json") });
const { engine, registry, audit } = await import("./runtime/state.js");
const { backupSources, backupStore, restoreArchives } = await import("./runtime/backups.js");
const { restoreRunner } = await import("./runtime/restores.js");
const { agentJobs } = await import("./runtime/updates.js");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root: ArchiveEntry = { name: "data", kind: "directory", size: 0, content: Buffer.alloc(0), mode: 0o755, uid: 0, gid: 0, changedAt: 0, linkTarget: "" };
const file = (name: string, text: string, mode = 0o644): ArchiveEntry => ({ ...root, name: `data/${name}`, kind: "file", mode, size: text.length, content: Buffer.from(text) });
const directory = (name: string, mode = 0o755): ArchiveEntry => ({ ...root, name: `data/${name}`, mode });
const symlink = (name: string, linkTarget: string): ArchiveEntry => ({ ...root, name: `data/${name}`, kind: "symlink", mode: 0o777, linkTarget });
const hardlink = (name: string, linkTarget: string): ArchiveEntry => ({ ...root, name: `data/${name}`, kind: "file", tarType: "1", linkTarget });
async function* tar(entries: ArchiveEntry[]) {
  for (const entry of entries) { yield backupTarHeader(entry); yield entry.content; yield Buffer.alloc((512 - entry.size % 512) % 512); }
  yield Buffer.alloc(1024);
}
const acceptance = [file("marker.txt", "v1-marker\n"), file("started.txt", "2026-10-09 10:27:00 UTC started\n")];
const cases: { name: string; root?: Partial<ArchiveEntry>; entries: ArchiveEntry[]; put: string[] }[] = [
  { name: "root 0/0 755 with two small files", entries: acceptance, put: ["marker.txt", "started.txt"] },
  { name: "empty file between files", entries: [file("a", "x"), file("empty", ""), file("b", "y")], put: ["a", "empty", "b"] },
  { name: "nested directories", entries: [directory("sub"), file("sub/one", "1"), directory("sub/deeper", 0o700), file("sub/deeper/two", "2"), file("top", "t")],
    put: ["sub", "sub/one", "sub/deeper", "sub/deeper/two", "top"] },
  { name: "symlink and hardlink are left out of the PUT", entries: [file("target", "data"), symlink("current", "target"), hardlink("copy", "data/target"), file("last", "z")],
    put: ["target", "last"] },
  { name: "root with another mode", root: { mode: 0o2770, uid: 1000, gid: 2000 }, entries: acceptance, put: ["marker.txt", "started.txt"] },
  { name: "file larger than one block", entries: [file("big", "b".repeat(1300)), file("after", "a")], put: ["big", "after"] }
];
const target = { kind: "container", containerName: "put-demo" } as const;
// Docker serializes archive requests per container, so a request issued while a PUT is open stalls.
async function scenario(t: import("node:test").TestContext, entries: ArchiveEntry[], rootEntry = root) {
  const raw = { Id: "put-demo", Name: "/put-demo", Config: { Image: "example/app:1.0" }, State: { Status: "exited", Running: false },
    Mounts: [{ Type: "bind", Source: "/synthetic/invisible", Destination: "/data", RW: true }] };
  registry.replaceAll([{ containerId: raw.Id, containerName: "put-demo", imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(engine, "inspect", async () => raw); t.mock.method(engine, "inspectImage", async () => null);
  t.mock.method(engine, "info", async () => ({ DockerRootDir: "/var/lib/docker" })); t.mock.method(engine, "listContainerIds", async () => [raw.Id]);
  const state = { putOpen: false, blocked: 0, checked: [] as string[] };
  t.mock.method(engine, "statArchive", async (_id: string, destination: string) => {
    if (state.putOpen) { state.blocked++; throw new Error("archive-timeout"); }
    state.checked.push(destination);
    return { name: path.posix.basename(destination), size: 0, mode: 0x80000000, mtime: "2026-10-09T00:00:00Z", linkTarget: "" };
  });
  const sources = await backupSources(raw.Id, null, new UpdateBudget(60_000)); const sourceId = sources.resolved[0].source.sourceId;
  const saved = await backupStore.create(target, { mode: "stop", mounts: [{ sourceId, estimatedBytes: 1024 }] }, async () => ({ target: "/data",
    stream: tar([rootEntry, ...entries]) }));
  assert.equal(sources.visibleRoots.has(sourceId), false);
  state.checked.length = 0;
  t.mock.method(engine, "openArchiveStream", async () => tar([rootEntry]));
  return { sources, sourceId, backupId: saved.backupId, state };
}
for (const item of cases) test(`restore PUT: ${item.name} sends no Docker request while the PUT is open`, async (t) => {
  const { sources, sourceId, backupId, state } = await scenario(t, item.entries, { ...root, ...item.root });
  let puts = 0; const sent: Buffer[] = [];
  t.mock.method(engine, "putArchiveStream", async (_id: string, destination: string, stream: AsyncIterable<Buffer>) => {
    for (const entry of [root, ...item.entries]) {
      assert.ok(state.checked.includes(`/${entry.name}`), `${entry.name} must be checked before the PUT opens`);
    }
    assert.equal(destination, "/data"); puts++; state.putOpen = true;
    try { for await (const chunk of stream) { sent.push(chunk); await new Promise((resolve) => setImmediate(resolve)); } } finally { state.putOpen = false; }
  });
  await restoreArchives(sources, target, backupId, [{ sourceId }], new UpdateBudget(60_000));
  assert.equal(state.blocked, 0); assert.equal(puts, 1);
  const restored = archiveEntries(Buffer.concat(sent));
  assert.deepEqual(restored.map((entry) => entry.name), item.put);
  for (const entry of restored) {
    const expected = item.entries.find((candidate) => candidate.name === `data/${entry.name}`)!;
    assert.equal(entry.content.toString(), expected.content.toString()); assert.equal(entry.mode & 0o7777, expected.mode);
  }
});
const unsafeComponents = [
  { name: "symlink target", mode: 0x80000000, linkTarget: "/outside" },
  { name: "symlink mode", mode: 0x08000000, linkTarget: "" },
  { name: "regular file", mode: 0, linkTarget: "" }
];
for (const component of unsafeComponents) for (const validateOnly of [false, true]) {
  test(`restore ${validateOnly ? "validation" : "PUT"} rejects a Docker-side ${component.name} in an intermediate component`, async (t) => {
    const { sources, sourceId, backupId, state } = await scenario(t, [file("first", "1"), file("sub/nested", "2"), file("last", "3")]);
    const stat = engine.statArchive.bind(engine);
    t.mock.method(engine, "statArchive", async (id: string, destination: string) => {
      const result = await stat(id, destination);
      return destination === "/data/sub" ? { ...result!, ...component } : result;
    });
    let puts = 0;
    t.mock.method(engine, "putArchiveStream", async (_id: string, _destination: string, stream: AsyncIterable<Buffer>) => {
      puts++; for await (const chunk of stream) { void chunk; }
    });
    await assert.rejects(restoreArchives(sources, target, backupId, [{ sourceId }], new UpdateBudget(60_000), validateOnly),
      (error: unknown) => error instanceof UpdateFailure && error.code === "restore-path-unsafe");
    assert.ok(state.checked.includes("/data/first"));
    assert.ok(state.checked.includes("/data/sub"));
    assert.equal(puts, 0);
  });
}
async function runRestore(backupId: string, sourceId: string) {
  const preview = await restoreRunner.preview({ target, backupId, mounts: [{ sourceId }] }, null);
  const { jobId } = restoreRunner.start({ target, backupId, mounts: preview.mounts, previewId: preview.previewId,
    expectedContainer: preview.expectedContainer, startDeadlineSeconds: 120, confirmed: true }, null);
  let progress = agentJobs.get(jobId);
  for (let attempt = 0; progress?.phase !== "completed" && attempt < 200; attempt++) { await new Promise((resolve) => setTimeout(resolve, 5)); progress = agentJobs.get(jobId); }
  assert.equal(progress?.phase, "completed");
  return progress;
}
// The result keeps the stable restore-extract-failed code; the audit log names the internal cause without foreign text.
test("restore audits the internal cause of a failing PUT", async (t) => {
  const { backupId, sourceId } = await scenario(t, acceptance);
  t.mock.method(engine, "putArchiveStream", async () => { throw new EngineError("daemon said: private-detail", 500); });
  const progress = await runRestore(backupId, sourceId);
  assert.equal(progress?.kind === "restore" && progress.result?.restoreError, "restore-extract-failed");
  const audit = fs.readFileSync(path.join(state, "audit.jsonl"), "utf8");
  assert.match(audit, /"action":"restore-cause".*"reason":"EngineError:500"/);
  assert.doesNotMatch(audit, /private-detail/);
});
test("restore preserves its failure code when the cause audit write fails", async (t) => {
  const { backupId, sourceId } = await scenario(t, acceptance);
  t.mock.method(engine, "putArchiveStream", async () => { throw new UpdateFailure("restore-path-unsafe"); });
  const write = audit.write.bind(audit); let causeWrites = 0;
  t.mock.method(audit, "write", (entry: Parameters<typeof audit.write>[0]) => {
    if (entry.action === "restore-cause") {
      causeWrites++; throw Object.assign(new Error("audit-write-failed"), { code: "ENOSPC" });
    }
    write(entry);
  });
  const progress = await runRestore(backupId, sourceId);
  assert.equal(causeWrites, 1);
  assert.equal(progress?.kind === "restore" && progress.result?.restoreError, "restore-path-unsafe");
});
