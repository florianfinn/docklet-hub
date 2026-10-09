import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ArchiveEntry } from "./archive-reader.js";
import { backupTarHeader, extractVisible, safeBackupArchive } from "./backup-archive.js";
import { archivePolicy } from "./archive-test-support.js";
const uid = process.getuid!(); const gid = process.getgid!();
const root = (mode = 0o755, owner = { uid, gid }): ArchiveEntry => ({ name: "data", kind: "directory", size: 0, content: Buffer.alloc(0), mode,
  changedAt: 1_700_000_000, linkTarget: "", ...owner });
const file = (name: string, text: string, mode = 0o644): ArchiveEntry => ({ ...root(mode), name: `data/${name}`, kind: "file", size: text.length, content: Buffer.from(text) });
const directory = (name: string, mode = 0o755): ArchiveEntry => ({ ...root(mode), name: `data/${name}` });
const symlink = (name: string, linkTarget: string): ArchiveEntry => ({ ...root(0o777), name: `data/${name}`, kind: "symlink", linkTarget });
const hardlink = (name: string, linkTarget: string): ArchiveEntry => ({ ...root(), name: `data/${name}`, kind: "file", tarType: "1", linkTarget });
function tar(entries: ArchiveEntry[]) {
  return Buffer.concat([...entries.flatMap((item) => [backupTarHeader(item), item.content, Buffer.alloc((512 - item.size % 512) % 512)]), Buffer.alloc(1024)]);
}
async function* chunks(buffer: Buffer) { for (let offset = 0; offset < buffer.length; offset += 127) yield buffer.subarray(offset, offset + 127); }
// The same filter the restore applies before extraction, so the matrix covers real archive streams.
const restore = (entries: ArchiveEntry[], target: string, base: string) => extractVisible(
  safeBackupArchive(chunks(tar(entries)), "/data", async () => true, undefined, () => {}, [], true), target, base, archivePolicy, "/data");
async function target(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "restore-matrix-")); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directoryPath = path.join(base, "data"); await fs.mkdir(directoryPath, { mode: 0o755 }); await fs.chmod(directoryPath, 0o755);
  return { base, root: directoryPath };
}
const read = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
test("restore of the acceptance archive overwrites existing files, keeps later files and applies the root mode", async (t) => {
  const { base, root: data } = await target(t);
  await fs.writeFile(path.join(data, "marker.txt"), "v2-changed\n"); await fs.writeFile(path.join(data, "new-after-backup.txt"), "later\n");
  await restore([root(), file("marker.txt", "v1-marker\n"), file("started.txt", "2026-10-09 10:27:00 UTC started\n")], data, base);
  assert.equal(await read(data, "marker.txt"), "v1-marker\n"); assert.equal(await read(data, "started.txt"), "2026-10-09 10:27:00 UTC started\n");
  assert.equal(await read(data, "new-after-backup.txt"), "later\n");
  assert.equal((await fs.stat(data)).mode & 0o7777, 0o755);
});
for (const mode of [0o700, 0o750, 0o755, 0o775]) test(`restore applies root mode ${mode.toString(8)} after its children`, async (t) => {
  const { base, root: data } = await target(t);
  await restore([root(mode), file("a", "a"), directory("sub", 0o500), file("sub/b", "b")], data, base);
  assert.equal((await fs.stat(data)).mode & 0o7777, mode); assert.equal((await fs.stat(path.join(data, "sub"))).mode & 0o7777, 0o500);
  assert.equal(await read(data, "sub", "b"), "b");
  await fs.chmod(path.join(data, "sub"), 0o700);
});
test("restore handles empty files, nested directories, symlinks and hardlinks together", async (t) => {
  const { base, root: data } = await target(t);
  await restore([root(), file("empty", ""), directory("a"), directory("a/b"), file("a/b/deep", "deep"), file("target", "shared"),
    symlink("current", "a/b/deep"), hardlink("copy", "data/target"), file("last", "z")], data, base);
  assert.equal(await read(data, "empty"), ""); assert.equal(await read(data, "a", "b", "deep"), "deep");
  assert.equal(await fs.readlink(path.join(data, "current")), "a/b/deep"); assert.equal(await read(data, "copy"), "shared"); assert.equal(await read(data, "last"), "z");
});
test("restore truncates a longer existing file to the saved size", async (t) => {
  const { base, root: data } = await target(t);
  await fs.writeFile(path.join(data, "grown"), "x".repeat(2000)); await fs.writeFile(path.join(data, "emptied"), "later content");
  await restore([root(), file("grown", "short"), file("emptied", "")], data, base);
  assert.equal(await read(data, "grown"), "short"); assert.equal(await read(data, "emptied"), "");
});
// Excluded from success: descriptors cannot give a non-root agent a root owned by another user, so the restore fails closed on the root.
// Mounts the agent cannot see take the Docker PUT path instead (restore-put-stream.test.ts).
test("restore with a foreign root owner fails closed on the root", async (t) => {
  const { base, root: data } = await target(t);
  await assert.rejects(restore([root(0o755, { uid: uid + 1, gid }), file("marker.txt", "v1")], data, base), { code: "restore-extract-failed", relative: "data" });
});
