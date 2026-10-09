import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UpdateBudget } from "./update-budget.js";
import { backupTarHeader } from "./backup-archive.js";
import { archiveEntries, type ArchiveEntry } from "./archive-reader.js";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "restore-put-"));
const state = path.join(base, "state"); fs.mkdirSync(state);
Object.assign(process.env, { DOCKER_AGENT_SECRET: "s".repeat(64), DOCKER_AGENT_BIND_BASE_PATH: base,
  DOCKER_AGENT_REGISTRY_FILE: path.join(state, "registry.json"), DOCKER_AGENT_AUDIT_FILE: path.join(state, "audit.jsonl"),
  DOCKER_AGENT_MONITOR_FILE: path.join(state, "monitor.json") });
const { engine, registry } = await import("./runtime/state.js");
const { backupSources, backupStore, restoreArchives } = await import("./runtime/backups.js");
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
  const state = { putOpen: false, blocked: 0 };
  t.mock.method(engine, "statArchive", async (_id: string, destination: string) => {
    if (state.putOpen) { state.blocked++; throw new Error("archive-timeout"); }
    return { name: path.posix.basename(destination), size: 0, mode: 0x80000000, mtime: "2026-10-09T00:00:00Z", linkTarget: "" };
  });
  const sources = await backupSources(raw.Id, null, new UpdateBudget(60_000)); const sourceId = sources.resolved[0].source.sourceId;
  const saved = await backupStore.create(target, { mode: "stop", mounts: [{ sourceId, estimatedBytes: 1024 }] }, async () => ({ target: "/data",
    stream: tar([rootEntry, ...entries]) }));
  t.mock.method(engine, "openArchiveStream", async () => tar([rootEntry]));
  return { sources, sourceId, backupId: saved.backupId, state };
}
for (const item of cases) test(`restore PUT: ${item.name} sends no Docker request while the PUT is open`, async (t) => {
  const { sources, sourceId, backupId, state } = await scenario(t, item.entries, { ...root, ...item.root });
  let puts = 0; const sent: Buffer[] = [];
  t.mock.method(engine, "putArchiveStream", async (_id: string, destination: string, stream: AsyncIterable<Buffer>) => {
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
