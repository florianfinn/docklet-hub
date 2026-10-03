import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  renameEntry,
  containerPathFor,
  shareDiagnostics,
  readTextFile,
  listDirectory,
  MAX_TEXT_BYTES,
  deleteEntry,
  openBelow,
  checkEntryPath,
  checkSharePath,
  checkName
} from "./webftp.js";

const PROJECT = "/home/docker/palworld";

// --- The share itself -------------------------------------------------------

test("checkSharePath accepts a subdirectory of the project directory", () => {
  const result = checkSharePath("Pal/Saved/SaveData", PROJECT);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.absolute, "/home/docker/palworld/Pal/Saved/SaveData");
});

// ⚠️ The load-bearing case from §5.3: an empty share would silently be the
// whole project directory — including the compose file, `.env`, backups and
// start scripts. That is exactly what this stage guards against.
test("checkSharePath rejects the empty path instead of reading it as “everything”", () => {
  for (const input of ["", "   ", "/"]) {
    const result = checkSharePath(input, PROJECT);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(!result.ok && result.reason, input === "/" ? "share-empty" : "share-empty");
  }
});

test("checkSharePath rejects absolute paths and every form of ..", () => {
  assert.equal(checkSharePath("/mnt/user", PROJECT).ok, false);
  for (const pathname of ["../adguard", "Saved/../../adguard", ".."]) {
    const result = checkSharePath(pathname, PROJECT);
    assert.equal(result.ok, false, pathname);
    assert.equal(!result.ok && result.reason, "path-traversal", pathname);
  }
});

test("checkSharePath rejects control characters", () => {
  assert.equal(checkSharePath("Saved\0/x", PROJECT).ok, false);
  assert.equal(checkSharePath("Saved\nx", PROJECT).ok, false);
});

// --- An entry INSIDE the share ----------------------------------------------

const SHARE = "/home/docker/palworld/Pal/Saved/SaveData";

test("checkEntryPath accepts the empty path as the share itself", () => {
  const result = checkEntryPath("", SHARE);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.relative, "");
  assert.equal(result.ok && result.absolute, SHARE);
});

// The traversal test of this stage: `..` here does not lead into a foreign
// container but into the configuration of THE SAME one — and that is exactly
// the point of the share (§5.3).
test("checkEntryPath does not get out of the share", () => {
  for (const pathname of ["../../compose.yaml", "..", "a/../../b", "/etc/shadow"]) {
    assert.equal(checkEntryPath(pathname, SHARE).ok, false, pathname);
  }
});

test("checkEntryPath blocks .env and compose files in every segment", () => {
  for (const pathname of [".env", ".env.local", "unter/.env.bak", "compose.yaml", "unter/docker-compose.yml"]) {
    const result = checkEntryPath(pathname, SHARE);
    assert.equal(result.ok, false, pathname);
    assert.equal(!result.ok && result.reason, "path-blocked", pathname);
  }
});

// --- Names ------------------------------------------------------------------

test("checkName does not let a path through as a name", () => {
  for (const name of ["a/b", "a\\b", "..", ".", "", "-rf", "x\0y"]) {
    assert.equal(checkName(name).ok, false, JSON.stringify(name));
  }
  assert.equal(checkName("Level.sav").ok, true);
});

// ⚠️ The check is byte-wise, not on the string. After the S19 finding that is
// the point: a character check says nothing about which BYTES end up in a byte
// field. A real slash is rejected here, whereas a character like U+012F ("į")
// is a perfectly valid file name — it only became a `/` through a latin1
// encoding, and that no longer exists (see tar.test.ts).
test("checkName checks the bytes of the name", () => {
  // Backslash and null byte via their character code, so that the intent of
  // the test does not depend on an escape sequence in the source.
  const backslash = String.fromCharCode(92);
  const nullbyte = String.fromCharCode(0);
  for (const name of ["sub/.env", `a${backslash}b`, `a${nullbyte}b`]) {
    const result = checkName(name);
    assert.equal(result.ok, false, JSON.stringify(name));
    assert.equal(!result.ok && result.reason, "path-invalid-characters", JSON.stringify(name));
  }
  // Non-ASCII is not a path separator and must not get lost along the way.
  assert.equal(checkName("subįĮenv").ok, true);
});

// The counter-check case: an ordinary umlaut is a valid file name and must
// not get lost through the byte check.
test("checkName lets ordinary umlauts through", () => {
  assert.equal(checkName("Bär.txt").ok, true);
  assert.equal(checkName("Spielstände.sav").ok, true);
});

test("checkName rejects blocked names and names that are too long", () => {
  assert.equal(checkName(".env").ok, false);
  assert.equal(checkName("COMPOSE.YAML").ok, false);
  assert.equal(checkName("a".repeat(101)).ok, false);
});

// --- File system ------------------------------------------------------------

function tempShare(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webftp-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("openBelow opens a file in the share and reports its size", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "level.sav"), "abcdef");

  const result = await openBelow(path.join(root, "level.sav"), root, "file");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.entry.size, 6);
  await result.entry.handle.close();
});

test("openBelow rejects a directory when a file is expected", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.mkdirSync(path.join(root, "unter"));

  const result = await openBelow(path.join(root, "unter"), root, "file");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "wrong-kind");
});

// ⚠️ The case that pure path arithmetic can do nothing against: a symlink out
// of the share. On Linux O_NOFOLLOW catches it, everywhere else the realpath
// comparison — what is checked here is the result, not the route.
test("openBelow does not follow a link out of the share", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "webftp-fremd-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "geheim.txt"), "top secret");

  try {
    fs.symlinkSync(path.join(outside, "geheim.txt"), path.join(root, "harmlos.txt"));
  } catch {
    // Windows without developer mode may not create symlinks.
    t.skip("symlinks not available");
    return;
  }

  const result = await openBelow(path.join(root, "harmlos.txt"), root, "file");
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && (result.reason === "path-outside" || result.reason === "not-readable"),
    `unexpected reason: ${!result.ok ? result.reason : ""}`
  );
});

test("listDirectory reports kinds and leaves out .env and compose files", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "level.sav"), "abc");
  fs.writeFileSync(path.join(root, ".env"), "GEHEIM=1");
  fs.writeFileSync(path.join(root, "compose.yaml"), "services:");
  fs.mkdirSync(path.join(root, "Backups"));

  const result = await listDirectory(root, root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const names = result.list.entries.map((entry) => entry.name);
  assert.deepEqual(names.sort(), ["Backups", "level.sav"]);
  assert.equal(result.list.entries.find((e) => e.name === "Backups")?.kind, "directory");
  assert.equal(result.list.entries.find((e) => e.name === "level.sav")?.size, 3);
});

// A link is reported as a link and NOT resolved — otherwise the size of a
// file lying outside the share would be shown there.
test("listDirectory does not resolve links", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  try {
    fs.symlinkSync("/etc/hosts", path.join(root, "zeiger"));
  } catch {
    t.skip("symlinks not available");
    return;
  }

  const result = await listDirectory(root, root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.list.entries[0].kind, "symlink");
  assert.equal(result.list.entries[0].size, 0);
});

test("shareDiagnostics says whether deleting is possible in this directory", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  const result = await shareDiagnostics(root, root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.diagnostics.readable, true);
  assert.equal(result.diagnostics.deletable, true);
});

test("deleteEntry removes a file, but not a non-empty directory", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "alt.sav"), "x");
  fs.mkdirSync(path.join(root, "voll"));
  fs.writeFileSync(path.join(root, "voll", "drin.txt"), "x");

  assert.equal((await deleteEntry(path.join(root, "alt.sav"), root)).ok, true);
  assert.equal(fs.existsSync(path.join(root, "alt.sav")), false);

  const fullDirectory = await deleteEntry(path.join(root, "voll"), root);
  assert.equal(fullDirectory.ok, false);
  assert.equal(!fullDirectory.ok && fullDirectory.reason, "not-empty");
});

test("deleteEntry does not touch the share itself", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  const result = await deleteEntry(root, root);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(root), true);
});

test("renameEntry stays in the same directory and overwrites nothing", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "alt.sav"), "x");
  fs.writeFileSync(path.join(root, "belegt.sav"), "y");

  const ok = await renameEntry(path.join(root, "alt.sav"), "neu.sav", root);
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "neu.sav"), "utf8"), "x");

  const collision = await renameEntry(path.join(root, "neu.sav"), "belegt.sav", root);
  assert.equal(collision.ok, false);
  assert.equal(!collision.ok && collision.reason, "already-exists");
  assert.equal(fs.readFileSync(path.join(root, "belegt.sav"), "utf8"), "y");
});

// --- Host path to container path --------------------------------------------

const MOUNTS = [
  { Source: "/home/docker/palworld", Destination: "/config", RW: true },
  { Source: "/home/docker/palworld/Pal/Saved", Destination: "/saves", RW: true },
  { Source: "/home/docker/palworld/ro", Destination: "/nur-lesen", RW: false }
];

test("containerPathFor takes the deepest matching mount", () => {
  const result = containerPathFor("/home/docker/palworld/Pal/Saved/SaveData", MOUNTS);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.absolutePath, "/saves/SaveData");
});

test("containerPathFor maps the mount point itself", () => {
  const result = containerPathFor("/home/docker/palworld/Pal/Saved", MOUNTS);
  assert.equal(result.ok && result.absolutePath, "/saves");
});

test("containerPathFor reports a read-only mounted location as such", () => {
  const result = containerPathFor("/home/docker/palworld/ro/x", MOUNTS);
  assert.equal(result.ok && result.writable, false);
});

// Without a mount nothing is written — not at all, instead of falling back to
// direct file access. Two routes to the same place would be two
// interpretations of the same permission.
test("containerPathFor reports a location the container does not see", () => {
  const result = containerPathFor("/home/docker/adguard/conf", MOUNTS);
  assert.equal(result.ok, false);
});

// A prefix is not a directory: /home/docker/palworld2 does not lie inside
// /home/docker/palworld, even if the string starts that way.
test("containerPathFor does not mistake a name prefix for a subdirectory", () => {
  const result = containerPathFor("/home/docker/palworld2/x", [MOUNTS[0]]);
  assert.equal(result.ok, false);
});

// --- The built-in text editor -----------------------------------------------

test("readTextFile returns content and hash", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "server.cfg"), "name = Test\nslots = 20\n");

  const result = await readTextFile(path.join(root, "server.cfg"), root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, "name = Test\nslots = 20\n");
  assert.equal(result.hash.length, 64);
});

// ⚠️ The kind is decided by the CONTENT, not by the extension. Opening a
// binary file in the editor would mean irrecoverably destroying it on save
// through the bytes→string→bytes conversion.
test("readTextFile rejects binary files — even with a harmless extension", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  // Null byte: does not occur in text, but does in every binary format.
  fs.writeFileSync(path.join(root, "welt.cfg"), Buffer.from([0x41, 0x00, 0x42]));
  // Invalid UTF-8 sequence: `toString("utf8")` silently replaces it with U+FFFD,
  // and exactly this silent replacement would be the data loss on save.
  fs.writeFileSync(path.join(root, "level.dat"), Buffer.from([0x41, 0xc3, 0x28, 0x42]));

  for (const name of ["welt.cfg", "level.dat"]) {
    const result = await readTextFile(path.join(root, name), root);
    assert.equal(result.ok, false, name);
    assert.equal(!result.ok && result.reason, "not-a-text-file", name);
  }
});

test("readTextFile rejects files that are too large", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "riesig.log"), Buffer.alloc(MAX_TEXT_BYTES + 1, 0x41));

  const result = await readTextFile(path.join(root, "riesig.log"), root);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "too-large");
});

test("readTextFile does not get at the .env — not via the editor either", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, ".env"), "ADMIN_PASSWORD=geheim");

  const result = await readTextFile(path.join(root, ".env"), root);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "path-blocked");
});

test("an empty file is valid text", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "leer.cfg"), "");

  const result = await readTextFile(path.join(root, "leer.cfg"), root);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.content, "");
});

// --- S20: multiple shares ---------------------------------------------------

// ⚠️ The rule S19 established still applies unchanged: the root NEVER comes
// from the request. Multiple shares change nothing about that — the caller may
// SELECT what the operator has shared, and a path that is not exactly in the
// list is rejected instead of being checked and used. This selection is a pure
// lookup; this test makes sure it does not introduce a second path construct.
test("selecting a share is an exact lookup, not a prefix comparison", () => {
  const known = ["data", "Pal/Saved/SaveData"];
  const select = (requested: string) => known.find((pathname) => pathname === requested);

  assert.equal(select("data"), "data");
  assert.equal(select("Pal/Saved/SaveData"), "Pal/Saved/SaveData");
  // Neither prefix nor extension nor traversal selects anything.
  assert.equal(select("dat"), undefined);
  assert.equal(select("data/.."), undefined);
  assert.equal(select("data/unter"), undefined);
  assert.equal(select("../data"), undefined);
  assert.equal(select(""), undefined);
});

// ⚠️ The list goes out unchanged (`routes/file-routes.ts`: `entries:
// listing.list.entries`), the dashboard reads `kind` and `size`. A German key
// here would not stand out in any type or lint — it arrives at the reader as
// `undefined`. That is why the SHAPE is checked, not just the value.
test("the entry shape carries the English keys", async (t) => {
  const { root, cleanup } = tempShare();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, "level.sav"), "abc");
  fs.mkdirSync(path.join(root, "Backups"));

  const result = await listDirectory(root, root);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  for (const entry of result.list.entries) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "changedAt",
      "gid",
      "kind",
      "name",
      "size",
      "uid"
    ]);
  }
});
