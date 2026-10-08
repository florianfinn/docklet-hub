import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { backupTarHeader, extractVisible } from "./backup-archive.js";
import type { ArchiveEntry } from "./archive-reader.js";
import { archivePolicy } from "./archive-test-support.js";

const directory = (name: string, mode: number, uid = process.getuid!(), gid = process.getgid!()): ArchiveEntry =>
  ({ name, mode, uid, gid, kind: "directory", size: 0, changedAt: 0, linkTarget: "", content: Buffer.alloc(0) });
async function* tar(entries: ArchiveEntry[]) {
  for (const entry of entries) { yield backupTarHeader(entry); yield entry.content; yield Buffer.alloc((512 - entry.size % 512) % 512); }
  yield Buffer.alloc(1024);
}
for (const initial of [0o777, 0o500, 0o000]) test(`R1: restore existing directory ${initial.toString(8)}, new directories and mount root metadata`, async (t) => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restore-mode-"));
  t.after(async () => { await fs.promises.chmod(path.join(base, "data/old"), 0o700); await fs.promises.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, "data"); await fs.promises.mkdir(root, { mode: 0o755 });
  await fs.promises.mkdir(path.join(root, "old"), { mode: initial });
  const file = { ...directory("data/old/file", 0o640), kind: "file" as const, content: Buffer.from("restored"), size: 8 };
  await extractVisible(tar([directory("data", 0o710), directory("data/old", 0o700), directory("data/new", 0o750), file]), root, base, archivePolicy, "/data", undefined, async (entry) => {
    await fs.promises.chmod(path.join(base, entry.name), entry.mode);
  });
  for (const [relative, mode] of [["", 0o710], ["old", 0o700], ["new", 0o750], ["old/file", 0o640]] as const) {
    const stat = await fs.promises.lstat(path.join(root, relative));
    assert.equal(stat.mode & 0o7777, mode); assert.equal(stat.uid, process.getuid!()); assert.equal(stat.gid, process.getgid!());
  }
  assert.equal(await fs.promises.readFile(path.join(root, "old/file"), "utf8"), "restored");
});
for (const fallback of [false, true]) test(`R1: foreign directory owners are preserved; archive PUT fallback=${fallback}`, async (t) => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restore-owner-")); t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.promises.mkdir(root); await fs.promises.mkdir(path.join(root, "old"), { mode: 0o777 });
  const owners = new Map<number, { uid: number; gid: number }>(); const originalOpen = fs.promises.open; const originalStat = fs.promises.lstat;
  const owned = (stat: fs.Stats) => Object.assign(stat, owners.get(stat.ino) ?? {});
  t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof fs.promises.lstat>) => owned(await originalStat(...args) as fs.Stats));
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args); const stat = handle.stat.bind(handle);
    t.mock.method(handle, "stat", async () => owned(await stat()));
    t.mock.method(handle, "chown", async (uid: number, gid: number) => {
      if (fallback) throw Object.assign(new Error("denied"), { code: "EPERM" });
      owners.set((await stat()).ino, { uid, gid });
    });
    return handle;
  });
  const calls: string[] = [];
  await extractVisible(tar([directory("data", 0o700, 12345, 12345), directory("data/old", 0o710, 12345, 12345), directory("data/new", 0o750, 12345, 12345),
    { ...directory("data/file", 0o2750, 12345, 12345), kind: "file", size: 5, content: Buffer.from("saved") },
    { ...directory("data/alias", 0o640, 12345, 12345), kind: "other", tarType: "1", linkTarget: "data/file" }]), root, base, archivePolicy, "/data", undefined,
    async (entry, relative, body) => {
      assert.equal(fallback, true); assert.equal(entry.uid, 12345); assert.equal(entry.gid, 12345);
      const absolute = path.join(base, entry.name); calls.push(relative);
      if (body) {
        const chunks = []; for await (const chunk of body) chunks.push(chunk);
        await fs.promises.writeFile(absolute, Buffer.concat(chunks));
      }
      const stat = await originalStat(absolute); owners.set(stat.ino, { uid: entry.uid, gid: entry.gid });
      await fs.promises.chmod(absolute, entry.mode);
    });
  for (const [relative, mode] of [["", 0o700], ["old", 0o710], ["new", 0o750], ["file", 0o2750], ["alias", 0o640]] as const) {
    const stat = await fs.promises.lstat(path.join(root, relative));
    assert.equal(stat.uid, 12345); assert.equal(stat.gid, 12345); assert.equal(stat.mode & 0o7777, mode);
  }
  assert.equal(calls.length, fallback ? 5 : 0);
});
test("R1: a PUT that leaves wrong directory metadata fails with the private path", async (t) => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restore-mismatch-")); t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.promises.mkdir(root);
  const originalOpen = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    t.mock.method(handle, "chown", async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    return handle;
  });
  let called = false;
  await assert.rejects(extractVisible(tar([directory("data", 0o700, 12345, 12345)]), root, base, archivePolicy, "/data", undefined,
    async () => { called = true; }), (error: unknown) => {
      assert.equal((error as { code: string }).code, "restore-extract-failed"); assert.equal((error as { relative: string }).relative, "data"); return true;
    });
  assert.equal(called, true);
});

test("R1: visible restore refuses unrepresentable Linux symlink modes instead of reporting wrong metadata", async (t) => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restore-link-mode-")); t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.promises.mkdir(root);
  const link = { ...directory("data/current", 0o600), kind: "symlink" as const, linkTarget: "file" };
  await assert.rejects(extractVisible(tar([link]), root, base, archivePolicy, "/data"), { code: "restore-extract-failed", relative: "data/current" });
  await assert.rejects(fs.promises.lstat(path.join(root, "current")), { code: "ENOENT" });
});
