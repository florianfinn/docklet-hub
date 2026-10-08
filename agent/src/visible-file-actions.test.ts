import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VisibleFileActions } from "./visible-file-actions.js";
import type { SourcePolicy } from "./file-sources.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "file-actions-"));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "share");
  await fs.promises.mkdir(root);
  await fs.promises.writeFile(path.join(root, "value.txt"), "preserved");
  const policy: SourcePolicy = { socketPath: "/var/run/docker.sock", dockerRootDir: "/var/lib/docker", agentPaths: [path.join(base, "agent")], backupDirectory: path.join(base, "backup") };
  return { base, root, policy, actions: new VisibleFileActions(root, base, policy, true) };
}

test("visible shares rename and delete files and directories under the base", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.actions.available(""), true);
  assert.deepEqual(await f.actions.rename("value.txt", "renamed.txt"), { ok: true, name: "renamed.txt" });
  assert.equal(await fs.promises.readFile(path.join(f.root, "renamed.txt"), "utf8"), "preserved");
  assert.deepEqual(await f.actions.delete("renamed.txt"), { ok: true, kind: "file" });
  await fs.promises.mkdir(path.join(f.root, "folder"));
  assert.deepEqual(await f.actions.rename("folder", "new-folder"), { ok: true, name: "new-folder" });
  assert.deepEqual(await f.actions.delete("new-folder"), { ok: true, kind: "directory" });
  assert.deepEqual(await fs.promises.readdir(f.root), []);
});
test("outside, invisible, shared and read-only sources reject both actions", async (t) => {
  const f = await fixture(t);
  for (const actions of [new VisibleFileActions(f.root, path.join(f.base, "other"), f.policy, true),
    new VisibleFileActions(path.join(f.base, "missing"), f.base, f.policy, true),
    new VisibleFileActions(f.root, f.base, f.policy, false)]) {
    assert.equal(await actions.available(""), false);
    assert.deepEqual(await actions.rename("value.txt", "renamed.txt"), { ok: false, reason: "not-writable" });
    assert.deepEqual(await actions.delete("value.txt"), { ok: false, reason: "not-writable" });
  }
  assert.equal(await fs.promises.readFile(path.join(f.root, "value.txt"), "utf8"), "preserved");
});
test("protected sources and protected nested paths reject both actions", async (t) => {
  const f = await fixture(t);
  for (const policy of [{ ...f.policy, backupDirectory: f.root }, { ...f.policy, agentPaths: [f.root] }, { ...f.policy, dockerRootDir: f.root }]) {
    const actions = new VisibleFileActions(f.root, f.base, policy, true);
    assert.equal(await actions.available(""), false);
    assert.equal((await actions.rename("value.txt", "renamed.txt")).ok, false);
    assert.equal((await actions.delete("value.txt")).ok, false);
  }
  for (const name of [".env", "compose.yaml"]) {
    await fs.promises.writeFile(path.join(f.root, name), "preserved");
    assert.equal((await f.actions.rename(name, "renamed.txt")).ok, false);
    assert.equal((await f.actions.delete(name)).ok, false);
    assert.equal((await f.actions.rename("value.txt", name)).ok, false);
  }
});
test("rename is exclusive for file and directory collisions", async (t) => {
  const f = await fixture(t);
  await fs.promises.writeFile(path.join(f.root, "existing.txt"), "existing");
  await fs.promises.mkdir(path.join(f.root, "folder"));
  await fs.promises.mkdir(path.join(f.root, "existing-folder"));
  for (const [source, target] of [["value.txt", "existing.txt"], ["folder", "existing-folder"]])
    assert.deepEqual(await f.actions.rename(source, target), { ok: false, reason: "already-exists" });
  assert.equal(await fs.promises.readFile(path.join(f.root, "existing.txt"), "utf8"), "existing");
  assert.equal(await fs.promises.readFile(path.join(f.root, "value.txt"), "utf8"), "preserved");
});
test("canonical paths and symlink ancestors never reach outside the share", async (t) => {
  const f = await fixture(t);
  await fs.promises.symlink(f.base, path.join(f.root, "link"));
  for (const relative of ["../value.txt", "/value.txt", "link/value.txt", "value.txt\n", ""]) {
    assert.equal((await f.actions.rename(relative, "renamed.txt")).ok, false);
    assert.equal((await f.actions.delete(relative)).ok, false);
  }
});
for (const operation of ["rename", "delete"] as const) for (const directory of [false, true]) for (const reusedInode of [false, true]) {
  test(`${operation} detects a symlink swap before mutation${directory ? " for a directory" : ""}${reusedInode ? " even with reused dev/ino" : ""}`, async (t) => {
    const f = await fixture(t);
    const outside = path.join(f.base, "outside.txt");
    await fs.promises.writeFile(outside, "outside");
    const source = path.join(f.root, "value.txt");
    if (directory) {
      await fs.promises.unlink(source);
      await fs.promises.mkdir(source);
    }
    const lstat = fs.promises.lstat.bind(fs.promises);
    type Prepared = { leaf: string; stat: fs.Stats };
    const checks = f.actions as unknown as { unchanged(entry: Prepared): Promise<void> };
    const unchanged = checks.unchanged.bind(checks);
    let swapped = false;
    let reusedIdentityChecked = false;
    t.mock.method(checks, "unchanged", async (entry: Prepared) => {
      if (!swapped) {
        // Inject after the snapshot, immediately before the production identity check.
        swapped = true;
        if (reusedInode) { if (directory) await fs.promises.rmdir(source); else await fs.promises.unlink(source); }
        else await fs.promises.rename(source, path.join(f.base, "retained.txt"));
        await fs.promises.symlink(outside, source);
        if (reusedInode) t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof fs.promises.lstat>) => {
          const stat = await lstat(...args);
          if (String(args[0]) === entry.leaf || String(args[0]) === path.join(path.dirname(entry.leaf), "renamed.txt")) {
            // Model inode reuse without depending on the filesystem allocator.
            assert.equal(stat.isSymbolicLink(), true);
            Object.defineProperties(stat, { dev: { value: entry.stat.dev }, ino: { value: entry.stat.ino } });
            reusedIdentityChecked = true;
          }
          return stat;
        });
      }
      return unchanged(entry);
    });
    const result = operation === "rename" ? await f.actions.rename("value.txt", "renamed.txt") : await f.actions.delete("value.txt");
    assert.equal(swapped, true);
    assert.equal(reusedIdentityChecked, reusedInode);
    assert.deepEqual(result, { ok: false, reason: "file-replaced" });
    assert.equal(await fs.promises.readFile(outside, "utf8"), "outside");
    assert.equal((await lstat(source)).isSymbolicLink(), true);
    if (!reusedInode) {
      if (directory) assert.equal((await fs.promises.stat(path.join(f.base, "retained.txt"))).isDirectory(), true);
      else assert.equal(await fs.promises.readFile(path.join(f.base, "retained.txt"), "utf8"), "preserved");
    }
    await assert.rejects(fs.promises.access(path.join(f.root, "renamed.txt")), { code: "ENOENT" });
  });
}
test("missing directory permissions deny both actions and diagnostics", async (t) => {
  const f = await fixture(t);
  t.mock.method(fs.promises, "access", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  assert.equal(await f.actions.available(""), false);
  assert.deepEqual(await f.actions.rename("value.txt", "renamed.txt"), { ok: false, reason: "not-writable" });
  assert.deepEqual(await f.actions.delete("value.txt"), { ok: false, reason: "not-writable" });
  assert.equal(await fs.promises.readFile(path.join(f.root, "value.txt"), "utf8"), "preserved");
});
for (const operation of ["rename", "delete"] as const) test(`${operation} detects a swapped parent while retaining the original descriptor`, async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, "outside");
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, "value.txt"), "outside");
  const lstat = fs.promises.lstat.bind(fs.promises);
  let parentChecks = 0;
  t.mock.method(fs.promises, "lstat", async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (String(args[0]) === f.root && ++parentChecks === 2) {
      await fs.promises.rename(f.root, f.root + "-original");
      await fs.promises.symlink(outside, f.root);
    }
    return lstat(...args);
  });
  const result = operation === "rename" ? await f.actions.rename("value.txt", "renamed.txt") : await f.actions.delete("value.txt");
  assert.deepEqual(result, { ok: false, reason: "file-replaced" });
  assert.equal(await fs.promises.readFile(path.join(outside, "value.txt"), "utf8"), "outside");
  assert.equal(await fs.promises.readFile(path.join(f.root + "-original", "value.txt"), "utf8"), "preserved");
});

for (const operation of ["rename", "delete"] as const) test(`${operation} requires directory permission without requiring leaf read permission`, async (t) => {
  const f = await fixture(t);
  await fs.promises.chmod(path.join(f.root, "value.txt"), 0);
  if (operation === "rename") {
    assert.deepEqual(await f.actions.rename("value.txt", "renamed.txt"), { ok: true, name: "renamed.txt" });
    assert.equal((await fs.promises.stat(path.join(f.root, "renamed.txt"))).mode & 0o777, 0);
    await fs.promises.chmod(path.join(f.root, "renamed.txt"), 0o600);
    assert.equal(await fs.promises.readFile(path.join(f.root, "renamed.txt"), "utf8"), "preserved");
  } else {
    assert.deepEqual(await f.actions.delete("value.txt"), { ok: true, kind: "file" });
    await assert.rejects(fs.promises.access(path.join(f.root, "value.txt")), { code: "ENOENT" });
  }
});
