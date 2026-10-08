import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ENTRIES } from "contract";
import { archiveFixture, archiveOf } from "./archive-test-support.js";
import { FileArchive } from "./file-archive.js";
import { hashOf } from "./compose-store.js";
import { protectedWritableMount } from "./file-sources.js";

function header(name: string, kind: "file" | "directory", size = 0) {
  const block = Buffer.from(archiveOf([{ name, kind, uid: 2100, gid: 2200, mode: 0o640, mtime: 1 }]).subarray(0, 512));
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  block.fill(32, 148, 156);
  block.write(block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return block;
}
test("archive listings discard more than 16 MiB of bodies and still show later direct children", async () => {
  const f = archiveFixture();
  const size = 65 * 1024 * 1024;
  let closed = false;
  f.engine.openArchiveStream = async () => (async function* () {
    try {
      yield header("data", "directory");
      yield header("data/large", "file", size);
      const body = Buffer.alloc(65536, 255);
      for (let remaining = size; remaining > 0; remaining -= body.length) yield body;
      yield header("data/nested", "directory");
      yield header("data/nested/hidden", "file");
      yield header("data/next", "file");
      yield Buffer.alloc(1024);
    } finally { closed = true; }
  })();
  const result = await f.files.list("/data");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.list.entries.map((entry) => entry.name), ["large", "nested", "next"]);
  assert.equal(result.list.entries[0].size, size);
  assert.equal(result.list.truncated, false);
  assert.equal(result.root.content.length, 0);
  assert.equal(closed, true);
});
test("archive downloads stream beyond the former 64 MiB limit with bounded chunks", async () => {
  const f = archiveFixture();
  const size = 65 * 1024 * 1024;
  f.engine.file("/data/large", "");
  const stat = f.engine.statArchive.bind(f.engine);
  f.engine.statArchive = async (id, target) => { const value = await stat(id, target); return target === "/data/large" && value ? { ...value, size } : value; };
  f.engine.openArchiveStream = async () => (async function* () {
    yield header("large", "file", size);
    const bytes = Buffer.alloc(65536, 255);
    for (let remaining = size; remaining > 0; remaining -= bytes.length) yield bytes;
    yield Buffer.alloc(1024);
  })();
  const result = await f.files.download("/data/large");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  let received = 0;
  for await (const bytes of result.stream) { received += bytes.length; assert.equal(bytes.every((byte) => byte === 255), true); assert.ok(bytes.length <= 65536); }
  assert.equal(received, size);
  assert.deepEqual(await f.files.text("/data/large"), { ok: false, reason: "too-large" });
});
test("archive entry and elapsed-time limits return partial lists with the existing truncated flag", async () => {
  const f = archiveFixture();
  for (let index = 0; index <= MAX_ENTRIES; index++) f.engine.file(`/data/file-${index}`, "");
  const result = await f.files.list("/data");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.list.entries.length, MAX_ENTRIES);
  assert.equal(result.list.truncated, true);
  let cancelled = false;
  f.engine.openArchiveStream = async (_id, _target, signal) => (async function* () {
    try {
      yield header("data", "directory");
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } finally { cancelled = true; }
  })();
  const timed = await f.files.list("/data", 20);
  assert.equal(timed.ok, true);
  if (!timed.ok) return;
  assert.equal(timed.list.truncated, true);
  assert.equal(cancelled, true);
});
test("archive PUT models Moby replacement and mountpoint EBUSY; singleton mounts are read-only", async () => {
  const f = archiveFixture();
  f.engine.file("/data/value", "old");
  const inode = f.engine.inodes.get("/data/value");
  f.engine.entries.set("/data/hardlink", f.engine.entries.get("/data/value")!);
  f.engine.inodes.set("/data/hardlink", inode!);
  f.engine.attributes.set("/data/value", { acl: "fixture-acl", xattrs: { "user.example": "fixture-value" } });
  assert.equal((await f.files.write("/data", "value", Buffer.from("new"), hashOf("old"))).ok, true);
  assert.notEqual(f.engine.inodes.get("/data/value"), inode);
  assert.equal(f.engine.entries.get("/data/hardlink")!.content?.toString(), "old");
  assert.equal(f.engine.inodes.get("/data/hardlink"), inode);
  assert.equal(f.engine.attributes.has("/data/value"), false);
  f.engine.mountFiles.add("/data/value");
  const replacement = archiveOf([{ name: "value", kind: "file", content: Buffer.from("unsafe"), uid: 1, gid: 2, mode: 0o640, mtime: 1 }]);
  await assert.rejects(f.engine.putArchive("target", "/data", replacement), { code: "EBUSY" });
  assert.equal(f.engine.entries.get("/data/value")!.content?.toString(), "new");
  const singleton = new FileArchive(f.engine, { ...f.scope, root: "/data/value", mounts: [{ Type: "bind", Source: f.scope.hostRoot, Destination: "/data/value", RW: true }] });
  assert.equal((await singleton.text("/data/value")).ok, true);
  f.engine.calls.length = 0;
  assert.deepEqual(await singleton.write("/data", "value", Buffer.from("unsafe"), hashOf("new")), { ok: false, reason: "source-read-only" });
  assert.equal(f.engine.calls.some((call) => call.method === "PUT"), false);
});
test("every protected writable mount blocks archive writes even to a different safe source", async () => {
  const f = archiveFixture();
  for (const Source of ["/etc", "/root", "/boot", "/var/lib/docker", "/backup", "/agent-state", "/srv/example/.env"]) {
    const mounts = [...f.scope.mounts, { Type: "bind", Source, Destination: "/protected", RW: true }];
    assert.equal(await protectedWritableMount(mounts, f.scope.policy), true);
    const files = new FileArchive(f.engine, { ...f.scope, mounts });
    f.engine.calls.length = 0;
    assert.deepEqual(await files.write("/data", "new", Buffer.from("draft")), { ok: false, reason: "source-protected" });
    assert.equal(f.engine.calls.length, 0);
    assert.equal(await protectedWritableMount(mounts.map((mount) => ({ ...mount, RW: false })), f.scope.policy), false);
  }
  assert.equal(await protectedWritableMount([{ Type: "volume", Name: "v", Source: "/var/lib/docker/volumes/v/_data", Destination: "/protected", RW: true }], f.scope.policy,
    ["/var/lib/docker/volumes/v/_data"], new Map([["v", "/backup"]])), true);
});
test("missing archive downloads expose missing status without attempting GET", async () => {
  const f = archiveFixture();
  assert.deepEqual(await f.files.download("/data/missing"), { ok: false, reason: "not-readable", missing: true });
  assert.equal(f.engine.calls.some((call) => call.method === "GET"), false);
});

test("PAX owner overrides preserve numeric identities and malformed owners fail closed", async () => {
  const { archiveHeader } = await import("./archive-reader.js");
  const block = header("value", "file");
  const entry = archiveHeader(block, { uid: "10000001", gid: "10000002" }).entry;
  assert.deepEqual([entry.uid, entry.gid], [10000001, 10000002]);
  for (const value of ["-1", "unknown", "4294967296"]) assert.throws(() => archiveHeader(block, { uid: value }), /not-readable/);
});
