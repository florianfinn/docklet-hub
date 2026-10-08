import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileSourcesResponseSchema, type MountSource } from "contract";
import { protectionOf, resolveFileSources, type SourcePolicy } from "./file-sources.js";
import { checkEntryPath, deleteEntry, renameEntry, readTextFile, listDirectory, protectFilePaths } from "./webftp.js";
import type { RawInspect } from "./engine-model.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy: SourcePolicy = { socketPath: path.join(root, "engine.sock"), agentPaths: [path.join(root, "agent")], backupDirectory: path.join(root, "backup") };
  for (const name of ["project", "external", "volume", "agent", "backup"]) await fs.mkdir(path.join(root, name));
  const inspect: RawInspect = { Id: "c1", Name: "/web", Config: { Labels: { "com.docker.compose.service": "web" } }, Mounts: [
    { Type: "bind", Source: path.join(root, "project"), Destination: "/project", RW: true },
    { Type: "bind", Source: path.join(root, "external"), Destination: "/data", RW: true },
    { Type: "volume", Name: "data", Source: path.join(root, "volume"), Destination: "/volume", RW: true }
  ] };
  const definitions: MountSource[] = (inspect.Mounts ?? []).map((mount) => ({ service: "web", kind: mount.Type === "volume" ? "volume" : mount.Destination === "/project" ? "project" : "external", source: mount.Name ?? mount.Source!, target: mount.Destination!, readOnly: false, shared: false }));
  const input = { containerId: "c1", inspect, definitions, projectDir: path.join(root, "project"), shares: ["public"], containers: [inspect], volumes: new Map([["data", { Name: "data" }]]), policy, readOnly: false };
  return { root, policy, input };
}

test("all mount classes expose validated capabilities; project roots require a share", async (t) => {
  const f = await fixture(t);
  let entries = await resolveFileSources(f.input);
  assert.deepEqual(entries.map((entry) => entry.source.kind), ["project", "external", "volume"]);
  assert.equal(entries[0].source.readable, false);
  await fs.mkdir(path.join(f.root, "project/public"));
  entries = await resolveFileSources(f.input);
  assert.equal(entries[0].absolute, path.join(f.root, "project/public"));
  assert.equal(entries[0].source.source, "public");
  assert.equal(entries[0].source.target, "/project/public");
  assert.equal(entries.every((entry) => entry.source.writable), true);
  assert.equal(entries.every((entry) => entry.source.estimatedBytes === null), true);
  assert.equal(fileSourcesResponseSchema.safeParse({ sources: entries.map((entry) => entry.source) }).success, true);
});

test("shared, ambiguous, missing survey and readonly sources fail closed", async (t) => {
  const f = await fixture(t);
  const another: RawInspect = { Id: "other", Name: "/other", Mounts: [{ Type: "bind", Source: path.join(f.root, "external/nested"), Destination: "/shared" }] };
  const shared = await resolveFileSources({ ...f.input, containers: [f.input.inspect, another] });
  assert.equal(shared[1].source.writeBlocker, "source-shared");
  assert.equal(shared[1].source.backupEligible, true);
  assert.equal(shared[1].source.restoreEligible, false);
  for (const variation of [{ containers: null }, { definitions: [] }, { readOnly: true }]) {
    const sources = await resolveFileSources({ ...f.input, ...variation });
    assert.equal(sources.some((entry) => entry.source.writable), false);
  }
});

test("volume driver paths and backup aliases cannot bypass protection", async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.policy.backupDirectory, path.join(f.root, "alias"));
  assert.equal(await protectionOf(path.join(f.root, "alias/child"), f.policy), "backup");
  assert.equal(await protectionOf("/", f.policy), "system");
  assert.equal(await protectionOf("/etc/example", f.policy), "system");
  assert.equal(await protectionOf(path.join(f.root, "agent/child"), f.policy), "agent");
  for (const [device, protection] of [[f.policy.backupDirectory, "backup"], ["/etc", "system"], [f.policy.agentPaths[0], "agent"]]) {
    const sources = await resolveFileSources({ ...f.input, volumes: new Map([["data", { Name: "data", Options: { device } }]]) });
    assert.equal(sources[2].source.protection, protection);
    assert.equal(sources[2].source.writable, false);
    assert.equal(sources[2].source.backupEligible, false);
    assert.equal(sources[2].source.restoreEligible, false);
    if (protection === "backup") assert.equal(sources[2].source.readable, false);
  }
});

test("protected subpaths are hidden and denied by direct reads and mutations", async (t) => {
  const f = await fixture(t);
  protectFilePaths(f.policy);
  await fs.writeFile(path.join(f.root, "backup/secret"), "private-fixture");
  const listing = await listDirectory(f.root, f.root);
  assert.equal(listing.ok, true);
  if (listing.ok) assert.equal(listing.list.entries.some((entry) => entry.name === "backup" || entry.name === "agent"), false);
  assert.equal((await readTextFile(path.join(f.root, "backup/secret"), f.root)).ok, false);
  assert.equal((await deleteEntry(path.join(f.root, "backup/secret"), f.root)).ok, false);
  assert.equal((await renameEntry(path.join(f.root, "backup/secret"), "new", f.root)).ok, false);
  for (const name of ["../outside", "/absolute", ".env", "compose.yaml"]) assert.equal(checkEntryPath(name, f.root).ok, false);
});

test("descriptor mutations preserve existing targets, reject symlinks and delete safely", async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.root, "external");
  await fs.writeFile(path.join(dir, "one"), "one");
  await fs.writeFile(path.join(dir, "two"), "two");
  assert.deepEqual(await renameEntry(path.join(dir, "one"), "two", dir), { ok: false, reason: "already-exists" });
  assert.equal(await fs.readFile(path.join(dir, "two"), "utf8"), "two");
  assert.equal((await renameEntry(path.join(dir, "one"), "three", dir)).ok, true);
  assert.equal((await deleteEntry(path.join(dir, "three"), dir)).ok, true);
  await fs.symlink(f.policy.backupDirectory, path.join(dir, "link"));
  assert.equal((await deleteEntry(path.join(dir, "link"), dir)).ok, false);
  await fs.mkdir(path.join(dir, "folder"));
  assert.equal((await renameEntry(path.join(dir, "folder"), "renamed", dir)).ok, true);
  assert.equal((await deleteEntry(path.join(dir, "renamed"), dir)).ok, true);
});

test("writes preserve owner, mode and bytes; stale hashes conflict again after resolution", async (t) => {
  const { writePinned } = await import("./file-write.js");
  const { hashOf } = await import("./compose-store.js");
  const f = await fixture(t);
  const dir = path.join(f.root, "external");
  const destination = path.join(dir, "text");
  await fs.writeFile(destination, "initial", { mode: 0o640 });
  const before = await fs.stat(destination);
  const write = (content: string, expectedHash: string) => writePinned({ directory: dir, root: dir, name: "text", content: Buffer.from(content), expectedHash });
  assert.equal((await write("draft", hashOf("initial"))).ok, true);
  const after = await fs.stat(destination);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode, before.mode);
  await fs.writeFile(destination, "external-1");
  assert.deepEqual(await write("draft-2", hashOf("draft")), { ok: false, reason: "file-changed-externally", hash: hashOf("external-1") });
  await fs.writeFile(destination, "external-2");
  assert.deepEqual(await write("draft-2", hashOf("external-1")), { ok: false, reason: "file-changed-externally", hash: hashOf("external-2") });
  assert.equal(await fs.readFile(destination, "utf8"), "external-2");
  assert.equal((await writePinned({ directory: dir, root: dir, name: "text", content: Buffer.from("upload") })).ok, false);
  const payload = Buffer.from([0, 255, 10, 13, 128]);
  assert.equal((await writePinned({ directory: dir, root: dir, name: "binary", content: payload })).ok, true);
  assert.deepEqual(await fs.readFile(path.join(dir, "binary")), payload);
  assert.equal((await fs.stat(path.join(dir, "binary"))).uid, (await fs.stat(dir)).uid);
});

test("all directory components reject symlink traversal, including internal aliases", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "external/value"), "value");
  await fs.symlink(path.join(f.root, "external"), path.join(f.root, "project/link"));
  const result = await readTextFile(path.join(f.root, "project/link/value"), path.join(f.root, "project"));
  assert.equal(result.ok, false);
});

test("single-file mounts remain editable without replacing their inode or owner", async (t) => {
  const { writePinned } = await import("./file-write.js");
  const { hashOf } = await import("./compose-store.js");
  const f = await fixture(t);
  const file = path.join(f.root, "external/config.txt");
  await fs.writeFile(file, "original", { mode: 0o640 });
  const before = await fs.stat(file);
  const result = await writePinned({ directory: path.dirname(file), root: file, name: path.basename(file), content: Buffer.from("updated"), expectedHash: hashOf("original") });
  assert.equal(result.ok, true);
  const after = await fs.stat(file);
  assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
  assert.equal(await fs.readFile(file, "utf8"), "updated");
});

test("pinned mutations cannot follow a parent exchanged for an outside symlink", async (t) => {
  const { writePinned } = await import("./file-write.js");
  const f = await fixture(t);
  const dir = path.join(f.root, "external");
  const outside = path.join(f.root, "outside");
  const original = path.join(f.root, "original");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "created"), "untouched");
  const lstat = fs.lstat;
  let swapped = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (!swapped && String(args[0]).startsWith("/proc/self/fd/")) {
      swapped = true;
      await fs.rename(dir, original);
      await fs.symlink(outside, dir);
    }
    return lstat(...args);
  });
  const result = await writePinned({ directory: dir, root: dir, name: "created", content: Buffer.from("inside") });
  assert.equal(result.ok, true);
  assert.equal(swapped, true);
  assert.equal(await fs.readFile(path.join(outside, "created"), "utf8"), "untouched");
  assert.equal(await fs.readFile(path.join(original, "created"), "utf8"), "inside");
});

test("project grants cannot expose an unmounted source through a symlink", async (t) => {
  const f = await fixture(t);
  await fs.symlink(path.join(f.root, "external"), path.join(f.root, "project/public"));
  const sources = await resolveFileSources(f.input);
  assert.equal(sources[0].source.readable, false);
  assert.equal(sources[0].source.writable, false);
});

test("failed ownership transfer refuses a write without changing the existing file", async (t) => {
  const { writePinned } = await import("./file-write.js");
  const f = await fixture(t);
  const dir = path.join(f.root, "external");
  const file = path.join(dir, "owned");
  await fs.writeFile(file, "original");
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === dir) {
      const stat = await handle.stat();
      t.mock.method(handle, "stat", async () => Object.create(stat, { uid: { value: stat.uid + 1 } }));
    }
    if (String(args[0]).includes("/.docklet-")) t.mock.method(handle, "chown", async () => { throw Object.assign(new Error("synthetic ownership refusal"), { code: "EPERM" }); });
    return handle;
  });
  assert.deepEqual(await writePinned({ directory: dir, root: dir, name: "new", content: Buffer.from("changed") }), { ok: false, reason: "not-writable" });
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.deepEqual(await fs.readdir(dir), ["owned"]);
});

test("manual Compose selections and single-file env mounts keep protected editing routes", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "external/manual.yaml");
  await fs.writeFile(file, "services: {}\n");
  const policy = { ...f.policy, blockedFiles: [file] };
  protectFilePaths(policy);
  assert.deepEqual(await readTextFile(file, path.join(f.root, "external")), { ok: false, reason: "path-blocked" });
  assert.equal((await renameEntry(file, "plain.txt", path.join(f.root, "external"))).ok, false);
  await fs.writeFile(path.join(f.root, "external/.env"), "API_KEY=private-fixture\n");
  const inspect: RawInspect = { Id: "c1", Name: "/web", Config: f.input.inspect.Config, Mounts: [{ Type: "bind", Source: file, Destination: "/config", RW: true }] };
  const definitions: MountSource[] = [{ service: "web", kind: "external", source: file, target: "/config", readOnly: false, shared: false }];
  const sources = await resolveFileSources({ ...f.input, inspect, definitions, policy });
  assert.equal(sources[0].source.readable, false);
  assert.equal(sources[0].source.writeBlocker, "path-blocked");
  assert.equal(sources[0].source.backupEligible, false);
  assert.equal(sources[0].source.restoreEligible, false);
});
