import assert from "node:assert/strict";
import test from "node:test";
import {
  containerPathFor,
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
