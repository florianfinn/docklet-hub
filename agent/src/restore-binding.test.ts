import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractVisible, backupTarHeader } from "./backup-archive.js";
import { archivePolicy } from "./archive-test-support.js";
import { openDescriptor } from "./file-descriptors.js";
import { putRestoreMetadata } from "./restore-metadata.js";
import type { ArchiveEntry } from "./archive-reader.js";
const directory = (name: string, mode = 0o700): ArchiveEntry => ({ name, mode, uid: process.getuid!(), gid: process.getgid!(),
  kind: "directory", size: 0, changedAt: 0, linkTarget: "", content: Buffer.alloc(0) });
async function* tar(entries: ArchiveEntry[]) {
  for (const entry of entries) { yield backupTarHeader(entry); yield entry.content; yield Buffer.alloc((512 - entry.size % 512) % 512); }
  yield Buffer.alloc(1024);
}
async function fixture(t: import("node:test").TestContext) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "restore-binding-"));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "data"); await fs.promises.mkdir(path.join(root, "parent/sub"), { recursive: true });
  return { base, root };
}
test("R6: mount root equal to descriptor base restores metadata without parent or PUT", async (t) => {
  const { root } = await fixture(t); const before = await fs.promises.stat(root); let puts = 0;
  await extractVisible(tar([directory("data", 0o710)]), root, root, archivePolicy, "/data", undefined, async () => { puts++; });
  const after = await fs.promises.stat(root); assert.equal(after.ino, before.ino); assert.equal(after.mode & 0o7777, 0o710); assert.equal(puts, 0);
});
test("R6: denied root metadata never escapes to parent PUT", async (t) => {
  const { root, base } = await fixture(t); let puts = 0; const original = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    t.mock.method(handle, "chown", async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }); return handle;
  });
  await assert.rejects(extractVisible(tar([{ ...directory("data"), uid: 12345, gid: 12345 }]), root, base, archivePolicy, "/data", undefined,
    async () => { puts++; }), { code: "restore-extract-failed", relative: "data" });
  assert.equal(puts, 0);
});
test("R6: file mount restores through its own inode without parent replacement", async (t) => {
  const { root, base } = await fixture(t); const file = path.join(root, "file"); await fs.promises.writeFile(file, "old-long-content");
  const before = await fs.promises.stat(file);
  await extractVisible(tar([{ ...directory("file", 0o640), kind: "file", size: 3, content: Buffer.from("new") }]), file, base, archivePolicy, "/file");
  const after = await fs.promises.stat(file); assert.equal(after.ino, before.ino); assert.equal(after.mode & 0o7777, 0o640);
  assert.equal(await fs.promises.readFile(file, "utf8"), "new");
});
for (const when of ["before", "after"] as const) test(`R5: ancestor symlink replacement ${when} PUT cannot retain path binding`, async (t) => {
  const { root, base } = await fixture(t); const parent = await openDescriptor(root, base, "parent", archivePolicy, "directory", true);
  t.after(() => parent.handle.close()); let puts = 0;
  const swap = async () => { await fs.promises.rename(root, root + "-held"); await fs.promises.symlink(root + "-held", root); };
  if (when === "before") await swap();
  await assert.rejects(putRestoreMetadata(parent, directory("data/parent/sub"), "parent/sub", async () => {
    puts++; await fs.promises.chmod(path.join(parent.pinned, "sub"), 0o700); if (when === "after") await swap();
  }), { code: "restore-extract-failed" });
  assert.equal(puts, when === "before" ? 0 : 1);
});
test("R5: pre-PUT callback catches a symlink swap after asynchronous engine checks", async (t) => {
  const { root, base } = await fixture(t); const parent = await openDescriptor(root, base, "parent", archivePolicy, "directory", true);
  t.after(() => parent.handle.close()); let puts = 0;
  await assert.rejects(putRestoreMetadata(parent, directory("data/parent/sub"), "parent/sub", async (_entry, _relative, _body, verify) => {
    await fs.promises.rename(root, root + "-held"); await fs.promises.symlink(root + "-held", root);
    await verify?.(); puts++; await fs.promises.chmod(path.join(parent.pinned, "sub"), 0o700);
  }), { code: "restore-extract-failed" });
  assert.equal(puts, 0);
});
test("R5: replacing the expected directory inode during PUT is rejected", async (t) => {
  const { root, base } = await fixture(t); const parent = await openDescriptor(root, base, "parent", archivePolicy, "directory", true);
  t.after(() => parent.handle.close());
  await assert.rejects(putRestoreMetadata(parent, directory("data/parent/sub"), "parent/sub", async () => {
    await fs.promises.rename(path.join(parent.pinned, "sub"), path.join(parent.pinned, "old"));
    await fs.promises.mkdir(path.join(parent.pinned, "sub"), { mode: 0o700 });
  }), { code: "restore-extract-failed" });
});
test("R5: existing regular file cannot use a PUT that replaces its expected inode", async (t) => {
  const { root, base } = await fixture(t); await fs.promises.writeFile(path.join(root, "parent/file"), "old");
  const parent = await openDescriptor(root, base, "parent", archivePolicy, "directory", true); t.after(() => parent.handle.close()); let puts = 0;
  await assert.rejects(putRestoreMetadata(parent, { ...directory("data/parent/file"), kind: "file" }, "parent/file", async () => { puts++; }), { code: "restore-extract-failed" });
  assert.equal(puts, 0); assert.equal(await fs.promises.readFile(path.join(root, "parent/file"), "utf8"), "old");
});
