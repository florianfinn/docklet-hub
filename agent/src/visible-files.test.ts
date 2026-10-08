import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VisibleFiles } from "./visible-files.js";
import { visibleRootOf } from "./file-descriptors.js";
import { FileArchive } from "./file-archive.js";
import { archiveFixture } from "./archive-test-support.js";
import { archiveEntries as archiveEntriesForTest } from "./archive-reader.js";
import { hashOf } from "./compose-store.js";
import { MAX_TEXT_BYTES } from "contract";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "visible-files-"));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "share");
  await fs.promises.mkdir(root);
  const f = archiveFixture(root);
  const files = new VisibleFiles(f.files, root, base, f.scope.policy, true);
  return { ...f, base, root, files };
}
test("backend selection uses realpath under the base, including aliases, and not the request", async (t) => {
  const f = await fixture(t);
  await fs.promises.symlink(f.root, path.join(f.base, "alias"));
  assert.equal(await visibleRootOf(f.root, f.base), f.root);
  assert.equal(await visibleRootOf(path.join(f.base, "alias"), f.base), f.root);
  assert.equal(await visibleRootOf(f.root, path.join(f.base, "other")), null);
  assert.equal(await visibleRootOf(path.join(f.base, "missing"), f.base), null);
});
test("visible listings inspect direct children without reading large subtrees or the daemon", async (t) => {
  const f = await fixture(t);
  await fs.promises.mkdir(path.join(f.root, "sub"));
  const huge = await fs.promises.open(path.join(f.root, "sub", "huge"), "w");
  await huge.truncate(80 * 1024 * 1024); await huge.close();
  await fs.promises.writeFile(path.join(f.root, "value.txt"), "bytes");
  const listing = await f.files.list("/data");
  assert.equal(listing.ok, true);
  if (!listing.ok) return;
  assert.deepEqual(listing.list.entries.map((entry) => entry.name), ["sub", "value.txt"]);
  assert.equal(listing.list.truncated, false);
  assert.equal(f.engine.calls.length, 0);
});
test("descriptor writes preserve inode, owner, mode and hardlinks and recheck the actual hash", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "value");
  await fs.promises.writeFile(target, "old", { mode: 0o640 });
  await fs.promises.link(target, path.join(f.root, "hardlink"));
  const before = await fs.promises.stat(target);
  assert.deepEqual(await f.files.write("/data", "value", Buffer.from("draft"), hashOf("external")), { ok: false, reason: "file-changed-externally", hash: hashOf("old") });
  assert.equal((await f.files.write("/data", "value", Buffer.from("new"), hashOf("old"))).ok, true);
  const after = await fs.promises.stat(target);
  assert.deepEqual([after.dev, after.ino, after.uid, after.gid, after.mode], [before.dev, before.ino, before.uid, before.gid, before.mode]);
  assert.equal(await fs.promises.readFile(path.join(f.root, "hardlink"), "utf8"), "new");
  await fs.promises.writeFile(target, "external-2");
  assert.deepEqual(await f.files.write("/data", "value", Buffer.from("draft"), hashOf("new")), { ok: false, reason: "file-changed-externally", hash: hashOf("external-2") });
  assert.equal(f.engine.calls.length, 0);
});
test("visible singleton mounts write their own inode rather than replacing a mountpoint", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "single.txt");
  await fs.promises.writeFile(target, "old");
  const stat = await fs.promises.stat(target);
  const scope = { ...f.scope, root: "/single.txt", hostRoot: target, mounts: [{ Type: "bind", Source: target, Destination: "/single.txt", RW: true }] };
  const files = new VisibleFiles(new FileArchive(f.engine, scope), target, f.base, scope.policy, true);
  assert.equal((await files.write("/", "single.txt", Buffer.from("new"), hashOf("old"))).ok, true);
  assert.equal((await fs.promises.stat(target)).ino, stat.ino);
  assert.equal((await files.text("/single.txt")).ok, true);
  assert.equal(f.engine.calls.length, 0);
});
test("new visible entries use daemon tar owners inherited from the descriptor parent", async (t) => {
  const f = await fixture(t);
  const parent = await fs.promises.stat(f.root);
  for (const [name, content] of [["new", Buffer.from("new")], ["folder", undefined]] as const) {
    assert.equal((await f.files.write("/data", name, content)).ok, true);
    const header = archiveEntriesForTest(f.engine.lastWrite!)[0];
    assert.deepEqual([header.uid, header.gid, header.mode], [parent.uid, parent.gid, parent.mode & (content ? 0o666 : 0o777) & ~0o002]);
  }
  assert.deepEqual(f.engine.calls.map((call) => call.method), ["PUT", "PUT"]);
});
test("descriptor permission failures never fall back to archive replacement", async (t) => {
  const f = await fixture(t);
  await fs.promises.writeFile(path.join(f.root, "value"), "old");
  const readOnly = new VisibleFiles(new FileArchive(f.engine, f.scope), f.root, f.base, f.scope.policy, false);
  assert.deepEqual(await readOnly.write("/data", "new", Buffer.from("new")), { ok: false, reason: "not-writable" });
  t.mock.method(fs.promises, "open", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  assert.deepEqual(await f.files.write("/data", "value", Buffer.from("new"), hashOf("old")), { ok: false, reason: "not-writable" });
  assert.equal((await f.files.text("/data/value")).ok, false);
  assert.equal(f.engine.calls.length, 0);
});
test("visible downloads stream beyond 64 MiB, preserve bytes and close on cancellation", async (t) => {
  const f = await fixture(t);
  const file = await fs.promises.open(path.join(f.root, "huge"), "w");
  const size = 65 * 1024 * 1024;
  await file.truncate(size); await file.close();
  const download = await f.files.download("/data/huge");
  assert.equal(download.ok, true);
  if (!download.ok) return;
  let received = 0;
  for await (const bytes of download.stream) { received += bytes.length; assert.equal(bytes.every((byte) => byte === 0), true); }
  assert.equal(received, size);
  assert.equal((await f.files.text("/data/huge")).ok, false);
  const partial = await f.files.download("/data/huge");
  assert.equal(partial.ok, true);
  if (partial.ok) { for await (const _bytes of partial.stream) break; await partial.cancel(); }
  assert.equal(f.engine.calls.length, 0);
});
test("visible text limits and named/protected/symlink subpaths remain enforced", async (t) => {
  const f = await fixture(t);
  await fs.promises.writeFile(path.join(f.root, "text"), Buffer.alloc(MAX_TEXT_BYTES, 65));
  assert.equal((await f.files.text("/data/text")).ok, true);
  await fs.promises.appendFile(path.join(f.root, "text"), "A");
  assert.deepEqual(await f.files.text("/data/text"), { ok: false, reason: "too-large" });
  assert.deepEqual(await f.files.write("/data", "text", Buffer.alloc(MAX_TEXT_BYTES + 1, 65), hashOf("old")), { ok: false, reason: "too-large" });
  for (const content of [Buffer.from([0]), Buffer.from([255])]) {
    await fs.promises.writeFile(path.join(f.root, "invalid"), content);
    assert.deepEqual(await f.files.text("/data/invalid"), { ok: false, reason: "not-a-text-file" });
    assert.deepEqual(await f.files.write("/data", "text", content, hashOf("old")), { ok: false, reason: "not-a-text-file" });
  }
  await fs.promises.writeFile(path.join(f.root, ".env"), "SECRET");
  await fs.promises.symlink(path.join(f.root, "text"), path.join(f.root, "link"));
  for (const target of ["/data/.env", "/data/link", "/outside/text"]) {
    assert.equal((await f.files.text(target)).ok, false);
    assert.equal((await f.files.download(target)).ok, false);
  }
  assert.equal(f.engine.calls.length, 0);
});

test("canonical protection aliases remain local and block visible backup contents", async (t) => {
  const f = await fixture(t);
  const { canonicalPolicy } = await import("./file-descriptors.js");
  const backup = path.join(f.base, "actual-backup");
  const alias = path.join(f.base, "backup-alias");
  await fs.promises.mkdir(backup);
  await fs.promises.symlink(backup, alias);
  await fs.promises.writeFile(path.join(backup, "value"), "SECRET");
  const policy = await canonicalPolicy({ ...f.scope.policy, backupDirectory: alias });
  assert.equal(policy.backupAliases?.includes(backup), true);
  assert.equal(f.scope.policy.backupAliases, undefined);
  const files = new VisibleFiles(new FileArchive(f.engine, { ...f.scope, hostRoot: backup, policy }), backup, f.base, policy, true);
  assert.equal((await files.text("/data/value")).ok, false);
  assert.equal((await files.write("/data", "value", Buffer.from("draft"), hashOf("SECRET"))).ok, false);
  assert.equal(f.engine.calls.length, 0);
});
test("daemon ownership failures for new visible files return not-writable without local fallback", async (t) => {
  const f = await fixture(t);
  f.engine.putArchive = async () => { throw Object.assign(new Error("ownership denied"), { code: "EPERM" }); };
  assert.deepEqual(await f.files.write("/data", "new", Buffer.from("draft")), { ok: false, reason: "not-writable" });
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});

test("descriptor hash writes detect leaf replacement before touching the opened inode", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "value");
  await fs.promises.writeFile(target, "old");
  const outside = path.join(f.base, "outside");
  await fs.promises.writeFile(outside, "outside");
  const lstat = fs.promises.lstat.bind(fs.promises);
  let checks = 0;
  t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (String(args[0]) === target && ++checks === 2) {
      await fs.promises.rename(target, target + "-original");
      await fs.promises.symlink(outside, target);
    }
    return lstat(...args);
  });
  assert.deepEqual(await f.files.write("/data", "value", Buffer.from("draft"), hashOf("old")), { ok: false, reason: "file-replaced" });
  assert.equal(await fs.promises.readFile(outside, "utf8"), "outside");
  assert.equal(await fs.promises.readFile(target + "-original", "utf8"), "old");
  assert.equal(f.engine.calls.length, 0);
});

for (const directory of [false, true]) test(`visible ${directory ? "folder" : "file"} creation keeps descriptor ownership despite a writable socket mount`, async (t) => {
  const f = await fixture(t);
  f.scope.mounts.push({ Type: "bind", Source: "/run/docker.sock", Destination: "/run/docker.sock", RW: true });
  const parent = await fs.promises.stat(f.root);
  const content = directory ? undefined : Buffer.from("new bytes");
  const result = await f.files.write("/data", "created", content);
  assert.equal(result.ok, true);
  const header = archiveEntriesForTest(f.engine.lastWrite!)[0];
  assert.equal(header.kind, directory ? "directory" : "file");
  assert.deepEqual([header.uid, header.gid, header.mode], [parent.uid, parent.gid, parent.mode & (directory ? 0o777 : 0o666) & ~0o002]);
  if (content) assert.equal(header.content.equals(content), true);
  assert.deepEqual(f.engine.calls.map((call) => call.method), ["PUT"]);
});
