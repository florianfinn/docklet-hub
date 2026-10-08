import test from "node:test";
import assert from "node:assert/strict";
import { archiveEntries, type ArchiveEntry } from "./archive-reader.js";
import { archiveRoot, withoutArchiveRoot } from "./restore-root-archive.js";
import { backupTarHeader } from "./backup-archive.js";
const root: ArchiveEntry = { name: "data", kind: "directory", size: 0, content: Buffer.alloc(0), mode: 0o755,
  uid: 12345, gid: 23456, changedAt: 0, linkTarget: "" };
async function* tar(entries: ArchiveEntry[]) {
  for (const entry of entries) { yield backupTarHeader(entry); yield entry.content; yield Buffer.alloc((512 - entry.size % 512) % 512); }
  yield Buffer.alloc(1024);
}
test("R6: invisible restore PUT contains children relative to mount, never its root", async () => {
  const chunks = []; for await (const chunk of withoutArchiveRoot(tar([root, { ...root, name: "data/file", kind: "file", size: 3, content: Buffer.from("new") }]), "/data", root)) chunks.push(chunk);
  const entries = archiveEntries(Buffer.concat(chunks)); assert.deepEqual(entries.map((entry) => entry.name), ["file"]);
  assert.equal(entries[0].content.toString(), "new"); assert.equal(entries[0].uid, 12345);
});
for (const change of [{ uid: 999 }, { gid: 999 }, { mode: 0o700 }]) test(`R6: invisible root ${Object.keys(change)[0]} mismatch aborts before any PUT bytes`, async () => {
  let bytes = 0;
  await assert.rejects(async () => { for await (const chunk of withoutArchiveRoot(tar([root]), "/data", { ...root, ...change })) bytes += chunk.length; },
    { code: "restore-extract-failed", relative: "/data" }); assert.equal(bytes, 0);
});
test("R6: root header inspection stops the GET stream before file bodies", async () => {
  let closed = false; let body = false;
  const input = (async function* () { try { yield backupTarHeader(root); body = true; throw new Error("must-not-read-body"); } finally { closed = true; } })();
  assert.deepEqual(await archiveRoot(input, "/data"), { ...root, tarType: "5" }); assert.equal(closed, true); assert.equal(body, false);
});
