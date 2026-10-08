import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { archiveEntries, type ArchiveEntry } from "./archive-reader.js";
import { backupTarHeader, safeBackupArchive, extractVisible, archiveSize, type SkippedEntry } from "./backup-archive.js";
import { archivePolicy } from "./archive-test-support.js";
function entry(name: string, content = Buffer.alloc(0), kind: ArchiveEntry["kind"] = "file"): ArchiveEntry {
  return { name, content, kind, size: content.length, changedAt: 0, mode: kind === "directory" ? 0o755 : kind === "symlink" ? 0o777 : 0o644, uid: process.getuid!(), gid: process.getgid!(), linkTarget: "" };
}
function tar(entries: ArchiveEntry[]) {
  return Buffer.concat([...entries.flatMap((item) => [backupTarHeader(item), item.content, Buffer.alloc((512 - item.size % 512) % 512)]), Buffer.alloc(1024)]);
}
async function* chunks(buffer: Buffer) { for (let offset = 0; offset < buffer.length; offset += 127) yield buffer.subarray(offset, offset + 127); }
async function collect(stream: AsyncIterable<Buffer>) { const parts = []; for await (const chunk of stream) parts.push(chunk); return Buffer.concat(parts); }
function checksum(header: Buffer) { header.fill(32, 148, 156); header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8); }
test("K18/K20: streamed tar filtering excludes protected subpaths and counts exact archive bytes", async () => {
  const input = tar([entry("data", Buffer.alloc(0), "directory"), entry("data/file", Buffer.from("kept")), entry("data/.env", Buffer.from("synthetic")), entry("data/compose.yaml", Buffer.from("synthetic")), entry("data/backups", Buffer.alloc(0), "directory")]);
  assert.equal(await archiveSize(chunks(input)), input.length);
  const output = await collect(safeBackupArchive(chunks(input), "/data", async (relative) => ![".env", "compose.yaml", "backups"].includes(relative)));
  assert.deepEqual(archiveEntries(output).map((item) => item.name), ["data", "data/file"]);
  assert.equal(archiveEntries(output)[1].content.toString(), "kept");
});
for (const name of ["/outside", "data/../outside", "data//outside", "data/\\outside", "other/file"]) test(`K22: unsafe archive name ${JSON.stringify(name)} is rejected`, async () => {
  await assert.rejects(collect(safeBackupArchive(chunks(tar([entry(name)])), "/data", async () => true)), /restore-path-unsafe/);
});
for (const flag of ["1", "2", "3", "4", "6", "7"]) test(`K22: unsafe link or special tar type ${flag} is skipped in backups and rejected in restores`, async () => {
  const input = tar([entry("data/file"), entry("data", Buffer.alloc(0), "directory")]); input.write(flag, 156); input.write("../../outside", 157); checksum(input.subarray(0, 512));
  const skipped: SkippedEntry[] = [];
  const output = await collect(safeBackupArchive(chunks(input), "/data", async () => true, undefined, () => {}, skipped));
  assert.deepEqual(archiveEntries(output).map((item) => item.name), ["data"]);
  assert.equal(skipped.length, 1); assert.equal(skipped[0].path, "file");
  assert.equal(skipped[0].reason, flag === "1" ? "hardlink-outside-archive" : flag === "2" ? "link-target-outside" : "special-file");
  await assert.rejects(collect(safeBackupArchive(chunks(input), "/data", async () => true, undefined, () => {}, [], true)), /restore-path-unsafe/);
});
test("K22: internal symlinks survive backup and descriptor restore without being followed", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "restore-links-")); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.mkdir(root);
  const link = { ...entry("data/current", Buffer.alloc(0), "symlink"), linkTarget: "releases/3" };
  const input = tar([entry("data", Buffer.alloc(0), "directory"), link, entry("data/releases", Buffer.alloc(0), "directory"), entry("data/releases/3", Buffer.from("saved"))]);
  const saved = await collect(safeBackupArchive(chunks(input), "/data", async () => true));
  const entries = archiveEntries(saved); assert.equal(entries.at(-1)!.kind, "symlink"); assert.equal(entries.at(-1)!.linkTarget, "releases/3");
  await extractVisible(chunks(saved), root, base, archivePolicy, "/data");
  assert.equal(await fs.readlink(path.join(root, "current")), "releases/3");
  assert.equal(await fs.readFile(path.join(root, "releases/3"), "utf8"), "saved");
  const skipped: SkippedEntry[] = [];
  const put = await collect(safeBackupArchive(chunks(saved), "/data", async () => true, undefined, () => {}, skipped, true, true));
  assert.equal(archiveEntries(put).some((item) => item.kind === "symlink"), false);
  assert.deepEqual(skipped, [{ path: "current", reason: "archive-put-link-unsupported" }]);
});
for (const target of ["/outside", "../outside"]) test(`K22: unsafe symlink target ${target} is reported`, async () => {
  const skipped: SkippedEntry[] = [];
  const input = tar([entry("data", Buffer.alloc(0), "directory"), { ...entry("data/link", Buffer.alloc(0), "symlink"), linkTarget: target }]);
  await collect(safeBackupArchive(chunks(input), "/data", async () => true, undefined, () => {}, skipped));
  assert.deepEqual(skipped, [{ path: "link", reason: target.startsWith("/") ? "absolute-link-target" : "link-target-outside" }]);
});
for (const target of ["../..", "b"]) test(`K22: malicious restore symlink ${target} cannot become an archive parent`, async () => {
  const input = tar([{ ...entry("data/a", Buffer.alloc(0), "symlink"), linkTarget: target }, entry("data/a/x", Buffer.from("unsafe"))]);
  await assert.rejects(collect(safeBackupArchive(chunks(input), "/data", async () => true, undefined, () => {}, [], true)), /restore-path-unsafe/);
});
test("K22: malformed checksum and truncated file bodies fail closed", async () => {
  const input = tar([entry("data/file", Buffer.alloc(1024))]);
  const damaged = Buffer.from(input); damaged[5] ^= 1;
  for (const buffer of [damaged, input.subarray(0, 700)]) await assert.rejects(collect(safeBackupArchive(chunks(buffer), "/data", async () => true)), /restore-path-unsafe/);
});
test("K22: descriptor extraction overwrites regular data and refuses an existing symlink", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "restore-descriptor-")); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.mkdir(root); const file = path.join(root, "file");
  await fs.writeFile(file, "old"); const input = tar([entry("data", Buffer.alloc(0), "directory"), entry("data/file", Buffer.from("restored"))]);
  await extractVisible(chunks(input), root, base, archivePolicy, "/data");
  assert.equal(await fs.readFile(file, "utf8"), "restored");
  await fs.unlink(file); await fs.symlink(path.join(base, "outside"), file);
  await assert.rejects(extractVisible(chunks(input), root, base, archivePolicy, "/data"), /restore-path-unsafe/);
  await assert.rejects(fs.stat(path.join(base, "outside")), { code: "ENOENT" });
});

test("internal hardlinks retain their target in backups and restore regular data through descriptors", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "restore-hardlinks-")); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.mkdir(root);
  const input = tar([entry("data/file", Buffer.from("saved")), { ...entry("data/alias", Buffer.alloc(0), "other"), tarType: "1", linkTarget: "data/file" }]);
  const saved = await collect(safeBackupArchive(chunks(input), "/data", async () => true));
  assert.equal(archiveEntries(saved)[1].tarType, "1");
  await extractVisible(chunks(saved), root, base, archivePolicy, "/data");
  assert.equal(await fs.readFile(path.join(root, "alias"), "utf8"), "saved");
});
test("long internal symlink targets are preserved with GNU link metadata", async () => {
  const target = "nested/".repeat(20) + "file";
  const input = tar([{ ...entry("data/link", Buffer.alloc(0), "symlink"), linkTarget: target }]);
  const saved = await collect(safeBackupArchive(chunks(input), "/data", async () => true));
  assert.equal(archiveEntries(saved)[0].linkTarget, target);
});
