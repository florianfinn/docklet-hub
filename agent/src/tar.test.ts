import assert from "node:assert/strict";
import test from "node:test";
import { TAR_BLOCK, TarNameInvalid, TarNameTooLong, tarHeader, tarWithOneEntry } from "./tar.js";

const Base = { name: "save.sav", kind: "file" as const, mode: 0o644, uid: 1000, gid: 1000, mtime: 1_700_000_000 };

function field(block: Buffer, offset: number, length: number): string {
  return block.subarray(offset, offset + length).toString("binary").replace(/\0.*$/, "").trim();
}

test("the header carries name, mode, uid/gid and size as octal numbers", () => {
  const header = tarHeader({ ...Base, content: Buffer.from("abc") });
  assert.equal(field(header, 0, 100), "save.sav");
  assert.equal(field(header, 100, 8), "0000644");
  assert.equal(field(header, 108, 8), "0001750"); // 1000 octal
  assert.equal(field(header, 116, 8), "0001750");
  assert.equal(field(header, 124, 12), "00000000003");
  assert.equal(header.subarray(156, 157).toString(), "0");
  assert.equal(header.subarray(257, 263).toString("binary"), "ustar\0");
});

// The daemon silently rejects an archive with a wrong checksum — so it is
// recomputed here the way the format defines it: over the block in which the
// checksum field consists of eight spaces.
test("the checksum matches the format's definition", () => {
  const header = tarHeader({ ...Base, content: Buffer.from("abc") });
  const loaded = Number.parseInt(field(header, 148, 8), 8);

  const recomputed = Buffer.from(header);
  recomputed.write("        ", 148, 8, "binary");
  let total = 0;
  for (const byte of recomputed) total += byte;

  assert.equal(loaded, total);
});

test("a directory carries typeflag 5 and size 0", () => {
  const header = tarHeader({ ...Base, name: "SaveData", kind: "directory", mode: 0o755 });
  assert.equal(header.subarray(156, 157).toString(), "5");
  assert.equal(field(header, 124, 12), "00000000000");
});

// ⚠️ Only the permission bits belong in the mode field. If 0o100644 were in
// there (i.e. with file type), the file might be visible to the service in the
// container with entirely different permissions than intended.
test("the mode contains no type bits", () => {
  const header = tarHeader({ ...Base, mode: 0o100644 });
  assert.equal(field(header, 100, 8), "0000644");
});

test("a name that is too long is rejected instead of truncated", () => {
  assert.throws(() => tarHeader({ ...Base, name: "a".repeat(101) }), TarNameTooLong);
  // Byte length, not character count: umlauts count twice.
  assert.throws(() => tarHeader({ ...Base, name: "ä".repeat(51) }), TarNameTooLong);
});

test("an empty name is rejected", () => {
  assert.throws(() => tarHeader({ ...Base, name: "" }), TarNameTooLong);
});

test("the archive ends in two zero blocks and is block-aligned", () => {
  const archive = tarWithOneEntry({ ...Base, content: Buffer.from("abc") });
  assert.equal(archive.length % TAR_BLOCK, 0);
  // Header + one content block + two end blocks.
  assert.equal(archive.length, TAR_BLOCK * 4);
  assert.equal(archive.subarray(TAR_BLOCK, TAR_BLOCK + 3).toString(), "abc");
  assert.ok(archive.subarray(TAR_BLOCK * 2).every((byte) => byte === 0));
});

test("content of exactly one block size gets no padding", () => {
  const archive = tarWithOneEntry({ ...Base, content: Buffer.alloc(TAR_BLOCK, 0x41) });
  assert.equal(archive.length, TAR_BLOCK * 4);
});

// --- The finding from the S19 security review ------------------------------
//
// ⚠️ The actual test of this file. The name field was written with latin1,
// which truncates every code unit to its low-order byte: U+012F ("į") became
// 0x2F, i.e. `/`. A name that `checkName` had waved through as path-free
// arrived at the daemon as a PATH — `subįĮenv` became `sub/.env`. Every
// preliminary check (symlink, already-exists, owner inheritance) thus ran
// against a location that was never written.
//
// The test does not check the encoding but the GUARANTEE: what goes into the
// name field contains no path separator. It therefore holds even if someone
// touches the encoding again.
// Helper: the bytes that are actually in the name field.
function nameBytes(header: Buffer): Buffer {
  const field = header.subarray(0, 100);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? 100 : end);
}

// ⚠️ THE test of this file. `U+012F` ("į") contains no `/` as a string, and
// none as UTF-8 either (C4 AF) — but under latin1 it became the single byte
// 0x2F, i.e. exactly one `/`. The name `subįĮenv` became `sub/.env` in the
// archive: a name that had passed the check and arrived at the daemon as a
// PATH.
//
// So what is checked is not the encoding but the GUARANTEE — the name field
// contains no path separator. The test therefore holds even if someone
// touches the encoding again.
test("a name that would become a path under latin1 stays path-free", () => {
  for (const name of ["subįĮenv", "Įenv", "ĮĮįevil", "aĀb"]) {
    const bytes = nameBytes(tarHeader({ ...Base, name }));
    assert.ok(!bytes.includes(0x2f), `${JSON.stringify(name)} contains a /`);
    assert.ok(!bytes.includes(0x5c), `${JSON.stringify(name)} contains a \\`);
    // And the name arrives unaltered instead of being silently truncated.
    assert.equal(bytes.toString("utf8"), name, JSON.stringify(name));
  }
});

// Belt and braces: `checkName` already catches a real slash, but the guarantee
// also belongs at the place where the name turns into a path — otherwise it
// depends on every future caller checking beforehand.
test("a real slash in the name is rejected in the tar header", () => {
  for (const name of ["sub/.env", "a\\b", "a\u0000b"]) {
    assert.throws(() => tarHeader({ ...Base, name }), TarNameInvalid, JSON.stringify(name));
  }
});

// Side finding with the same cause: an umlaut ended up on disk as invalid
// UTF-8 (latin1 turned "ä" into the single byte 0xE4).
test("an umlaut in the file name stays valid UTF-8", () => {
  const header = tarHeader({ ...Base, name: "Bär.txt", content: Buffer.from("x") });
  const end = header.subarray(0, 100).indexOf(0);
  assert.equal(header.subarray(0, end).toString("utf8"), "Bär.txt");
});
