import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { MAX_TEXT_BYTES, MAX_ENTRIES } from "contract";
import { archiveFixture, archiveOf, archivePolicy } from "./archive-test-support.js";
import { FileArchive } from "./file-archive.js";
import { archiveEntries } from "./archive-reader.js";
import { hashOf } from "./compose-store.js";
import { checkEntryPath } from "./webftp.js";

test("unseen foreign-owned binds read and write only through the target container", async (t) => {
  for (const method of ["stat", "access", "realpath", "open", "writeFile", "readFile"] as const) t.mock.method(fs, method, () => { throw new Error("agent filesystem forbidden"); });
  const { engine, files } = archiveFixture();
  engine.file("/data/config.txt", "old", 7001, 7002, 0o640);
  assert.deepEqual(await files.text("/data/config.txt"), { ok: true, content: "old", hash: hashOf("old"), size: 3 });
  assert.equal((await files.write("/data", "config.txt", Buffer.from("new"), hashOf("old"))).ok, true);
  const stored = engine.entries.get("/data/config.txt")!;
  assert.deepEqual([stored.uid, stored.gid, stored.mode, stored.content?.toString()], [7001, 7002, 0o640, "new"]);
  assert.equal(engine.calls.every((call) => call.id === "target" && call.target.startsWith("/data")), true);
});
test("allocated named volumes use the same archive path, despite Docker storage protection", async () => {
  const f = archiveFixture("/var/lib/docker/volumes/data/_data");
  f.engine.file("/data/value", "old");
  const files = new FileArchive(f.engine, { ...f.scope, volumeRoots: [f.scope.hostRoot], mounts: [{ Type: "volume", Name: "data", Source: f.scope.hostRoot, Destination: "/data", RW: true }] });
  assert.equal((await files.write("/data", "value", Buffer.from("new"), hashOf("old"))).ok, true);
  assert.equal((await files.text("/data/value")).ok, true);
});
test("new files and directories inherit parent owners without world-write permissions", async () => {
  const { engine, files } = archiveFixture();
  engine.entries.get("/data")!.mode = 0o777;
  for (const [name, content] of [["binary", Buffer.from([0, 255, 10, 13, 128])], ["folder", undefined]] as const) {
    assert.equal((await files.write("/data", name, content)).ok, true);
    const entry = engine.entries.get(`/data/${name}`)!;
    assert.deepEqual([entry.uid, entry.gid, entry.mode], [2100, 2200, content === undefined ? 0o775 : 0o664]);
    if (content) assert.deepEqual((await files.read(`/data/${name}`)).ok && entry.content, content);
  }
});
test("existing uploads and folders conflict instead of overwriting", async () => {
  const { engine, files } = archiveFixture();
  engine.file("/data/existing", "preserved");
  engine.directory("/data/folder");
  for (const name of ["existing", "folder"]) assert.deepEqual(await files.write("/data", name, Buffer.from("new")), { ok: false, reason: "already-exists" });
  assert.equal(engine.calls.some((call) => call.method === "PUT"), false);
  assert.equal(engine.entries.get("/data/existing")!.content?.toString(), "preserved");
});
test("hash conflicts detect every external change including after deliberate resolution", async () => {
  const { engine, files } = archiveFixture();
  engine.file("/data/text", "external-1");
  assert.deepEqual(await files.write("/data", "text", Buffer.from("draft"), hashOf("old")), { ok: false, reason: "file-changed-externally", hash: hashOf("external-1") });
  engine.file("/data/text", "external-2");
  assert.deepEqual(await files.write("/data", "text", Buffer.from("draft"), hashOf("external-1")), { ok: false, reason: "file-changed-externally", hash: hashOf("external-2") });
  assert.equal(engine.calls.some((call) => call.method === "PUT"), false);
});
test("protected names and subpaths fail before any daemon request", async () => {
  for (const [hostRoot, suffix, reason] of [["/", "backup/value", "backup-directory-protected"], ["/", "agent-state/value", "source-protected"], ["/safe", ".env", "path-blocked"], ["/safe", "compose.yaml", "path-blocked"], ["/safe", "manual.yaml", "path-blocked"]]) {
    const f = archiveFixture(hostRoot);
    const files = new FileArchive(f.engine, { ...f.scope, policy: { ...archivePolicy, blockedFiles: ["/safe/manual.yaml"] } });
    assert.deepEqual(await files.read(`/data/${suffix}`), { ok: false, reason });
    assert.equal(f.engine.calls.length, 0);
  }
  const f = archiveFixture();
  const files = new FileArchive(f.engine, { ...f.scope, policy: undefined as never });
  assert.deepEqual(await files.read("/data/value"), { ok: false, reason: "source-protected" });
  assert.equal(f.engine.calls.length, 0);
});
test("all control characters, noncanonical and absolute paths are rejected", () => {
  for (const value of ["/absolute", "..", "a/../b", "a//b", "a/./b", "a/", "a\\b", ...Array.from({ length: 32 }, (_, index) => `a${String.fromCharCode(index)}b`), "a\x7fb"])
    assert.equal(checkEntryPath(value, "/data").ok, false, JSON.stringify(value));
});
test("link components including root, intermediate and final links never reach GET or PUT", async () => {
  for (const target of ["/data", "/data/sub", "/data/sub/file"]) {
    const { engine, files } = archiveFixture();
    engine.file("/data/sub/file", "private");
    engine.entries.get(target)!.linkTarget = "/outside";
    assert.deepEqual(await files.read("/data/sub/file"), { ok: false, reason: "path-outside" });
    assert.equal(engine.calls.some((call) => call.method !== "HEAD"), false);
  }
});
test("listing exposes metadata without resolving links and hides protected children", async () => {
  const { engine, files } = archiveFixture();
  engine.file("/data/plain", "text");
  engine.file("/data/.env", "SECRET=fixture");
  engine.file("/data/compose.yaml", "services: {}");
  engine.file("/data/link", ""); engine.entries.get("/data/link")!.linkTarget = "/outside";
  const listing = await files.list("/data");
  assert.equal(listing.ok, true);
  if (!listing.ok) return;
  assert.deepEqual(listing.list.entries.map((entry) => [entry.name, entry.kind]), [["link", "symlink"], ["plain", "file"]]);
  assert.equal(listing.diagnostics.deletable, false);
  assert.deepEqual(Object.keys(listing.list.entries[0]).sort(), ["changedAt", "gid", "kind", "name", "size", "uid"]);
});
test("listing remains bounded by entry count", async () => {
  const { engine, files } = archiveFixture();
  for (let index = 0; index <= MAX_ENTRIES; index++) engine.file(`/data/f${index}`, "");
  const result = await files.list("/data");
  assert.equal(result.ok && result.list.entries.length, MAX_ENTRIES);
  assert.equal(result.ok && result.list.truncated, true);
});
test("text limits accept exact UTF-8 bytes and reject overflow, invalid UTF-8 and NUL", async () => {
  const { engine, files } = archiveFixture();
  engine.file("/data/exact", Buffer.from("ä".repeat(MAX_TEXT_BYTES / 2)));
  assert.equal((await files.text("/data/exact")).ok, true);
  assert.deepEqual(await files.write("/data", "exact", Buffer.alloc(MAX_TEXT_BYTES + 1, 65), hashOf("ä".repeat(MAX_TEXT_BYTES / 2))), { ok: false, reason: "too-large" });
  for (const content of [Buffer.alloc(MAX_TEXT_BYTES + 1, 65), Buffer.from([0]), Buffer.from([255])]) {
    engine.file("/data/bad", content);
    assert.deepEqual(await files.text("/data/bad"), { ok: false, reason: content.length > MAX_TEXT_BYTES ? "too-large" : "not-a-text-file" });
  }
  engine.file("/data/empty", "");
  assert.deepEqual(await files.text("/data/empty"), { ok: true, content: "", hash: hashOf(""), size: 0 });
  assert.deepEqual(await files.text("/data"), { ok: false, reason: "wrong-kind" });
});
test("archive header replacement, malformed checksum and traversal fail closed", async () => {
  const f = archiveFixture(); f.engine.file("/data/plain", "old");
  f.engine.getArchive = async () => archiveOf([{ name: "other", kind: "file", content: Buffer.from("bad"), mode: 0o644, uid: 1, gid: 1, mtime: 0 }]);
  assert.deepEqual(await f.files.read("/data/plain"), { ok: false, reason: "file-replaced" });
  const archive = archiveOf([{ name: "../outside", kind: "file", mode: 0o644, uid: 1, gid: 1, mtime: 0 }]);
  assert.throws(() => archiveEntries(archive), /path-outside/);
  archive[100] = 0xff;
  assert.throws(() => archiveEntries(archive), /not-readable/);
});
test("write failures remain sanitized and report not-writable", async () => {
  const f = archiveFixture();
  f.engine.putArchive = async () => { throw new Error("SECRET=not-for-logs"); };
  assert.deepEqual(await f.files.write("/data", "new", Buffer.from("new")), { ok: false, reason: "not-writable" });
});

test("allocated volume metadata does not exempt backup subdirectories", async () => {
  const f = archiveFixture("/var/lib/docker/volumes/data/_data");
  const files = new FileArchive(f.engine, { ...f.scope, policy: { ...archivePolicy, backupDirectory: f.scope.hostRoot + "/backup" }, volumeRoots: [f.scope.hostRoot], mounts: [{ Type: "volume", Name: "data", Source: f.scope.hostRoot, Destination: "/data", RW: true }] });
  assert.deepEqual(await files.read("/data/backup/secret"), { ok: false, reason: "backup-directory-protected" });
  assert.equal(f.engine.calls.length, 0);
});
test("a nested mount cannot bypass the selected source boundary or readonly mode", async () => {
  const f = archiveFixture();
  const files = new FileArchive(f.engine, { ...f.scope, mounts: [...f.scope.mounts, { Type: "bind", Source: "/other", Destination: "/data/nested", RW: false }] });
  assert.deepEqual(await files.read("/data/nested/value"), { ok: false, reason: "path-outside" });
  assert.deepEqual(await files.boundary("/data/nested/value", true), { ok: false, reason: "path-outside" });
  assert.equal(f.engine.calls.length, 0);
});
test("independent policies remain isolated across concurrent requests", async () => {
  const f = archiveFixture(); f.engine.file("/data/value", "text");
  const protectedFiles = new FileArchive(f.engine, { ...f.scope, policy: { ...archivePolicy, backupDirectory: f.scope.hostRoot } });
  const [safe, denied] = await Promise.all([f.files.text("/data/value"), protectedFiles.text("/data/value")]);
  assert.equal(safe.ok, true);
  assert.deepEqual(denied, { ok: false, reason: "backup-directory-protected" });
});

test("the agent selects the backend and neither file backend executes container tools", async () => {
  for (const source of ["file-archive.ts", "webftp.ts", "runtime/access.ts", "routes/file-routes.ts", "file-sources.ts"]) {
    const text = await fs.readFile(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(text, /from "node:fs(?:\/promises)?"|openBelow|writePinned|descriptorPath|execCreate/);
  }
  for (const source of ["file-descriptors.ts", "visible-files.ts", "visible-file-actions.ts", "file-archive.ts"]) {
    assert.doesNotMatch(await fs.readFile(new URL(source, import.meta.url), "utf8"), /node:child_process|execCreate|execFile/);
  }
  const archive = await fs.readFile(new URL("file-archive.ts", import.meta.url), "utf8");
  assert.doesNotMatch(archive, /\.getArchive\(/);
  const actions = await fs.readFile(new URL("visible-file-actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(actions, /readFile|writeFile|createReadStream|getArchive|putArchive|execCreate/);
  const routes = await fs.readFile(new URL("routes/file-routes.ts", import.meta.url), "utf8");
  assert.deepEqual([...routes.matchAll(/entryActions\.(\w+)\(/g)].map((match) => match[1]).sort(), ["available", "delete", "rename"]);
  await assert.rejects(fs.access(new URL("file-write.ts", import.meta.url)), { code: "ENOENT" });
});

test("a path exchanged while the archive is read is rejected before returning bytes", async () => {
  const f = archiveFixture(); f.engine.file("/data/sub/value", "inside");
  const get = f.engine.getArchive.bind(f.engine);
  f.engine.getArchive = async (...args) => {
    const tar = await get(...args);
    f.engine.entries.get("/data/sub")!.linkTarget = "/outside";
    return tar;
  };
  assert.deepEqual(await f.files.read("/data/sub/value"), { ok: false, reason: "path-outside" });
});
test("a new target appearing during parent lookup conflicts without PUT", async () => {
  const f = archiveFixture();
  const get = f.engine.getArchive.bind(f.engine);
  f.engine.getArchive = async (...args) => {
    const tar = await get(...args);
    f.engine.file("/data/new", "external");
    return tar;
  };
  assert.deepEqual(await f.files.write("/data", "new", Buffer.from("draft")), { ok: false, reason: "already-exists" });
  assert.equal(f.engine.calls.some((call) => call.method === "PUT"), false);
  assert.equal(f.engine.entries.get("/data/new")!.content?.toString(), "external");
});

test("header-only listings hide protected and nested mount subtrees without returning contents", async () => {
  const f = archiveFixture();
  f.engine.directory("/data/backup"); f.engine.file("/data/backup/value", "SECRET_BACKUP_CONTENT");
  f.engine.directory("/data/state"); f.engine.file("/data/state/value", "SECRET_AGENT_CONTENT");
  f.engine.directory("/data/nested"); f.engine.file("/data/nested/value", "SECRET_MOUNT_CONTENT");
  const files = new FileArchive(f.engine, { ...f.scope, policy: { ...archivePolicy, backupDirectory: f.scope.hostRoot + "/backup", agentPaths: [f.scope.hostRoot + "/state"] },
    mounts: [...f.scope.mounts, { Source: "/backup", Destination: "/data/nested", Type: "bind" }] });
  const listing = await files.list("/data");
  assert.equal(listing.ok, true);
  if (!listing.ok) return;
  assert.deepEqual(listing.list.entries, []);
  assert.equal(listing.root.content.length, 0);
  assert.doesNotMatch(JSON.stringify(listing), /SECRET_/);
});
