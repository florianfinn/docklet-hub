import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readLastLines,
  lastLinesFrom,
  openLogFile,
  checkLogPath,
  tailLogFile,
  PATH_ERROR_REASONS,
  OPEN_ERROR_REASONS,
  LOG_FILE_FAILURE_REASONS
} from "./log-file.js";

const PROJECT = "/home/docker/palworld";

// --- Path check (the core of this stage, §20.2 / R2) ------------------------

test("checkLogPath accepts a relative path below the project directory", () => {
  const result = checkLogPath("Pal/Saved/Logs/Palworld.log", PROJECT);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.absolute, "/home/docker/palworld/Pal/Saved/Logs/Palworld.log");
});

test("checkLogPath rejects absolute paths", () => {
  const result = checkLogPath("/etc/shadow", PROJECT);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "path-absolute");
});

test("checkLogPath rejects every form of ..", () => {
  for (const pathname of ["../nachbar/geheim.log", "logs/../../nachbar/geheim.log", ".."]) {
    const result = checkLogPath(pathname, PROJECT);
    assert.equal(result.ok, false, pathname);
    assert.equal(!result.ok && result.reason, "path-traversal", pathname);
  }
});

// The case from §20.2 that makes this stage a stage of its own at all: the
// root is the directory of THIS container, not the global base path.
test("checkLogPath does not get into the directory of a neighbouring container", () => {
  const result = checkLogPath("../adguard/logs/query.log", PROJECT);
  assert.equal(result.ok, false);
});

test("checkLogPath rejects null bytes and line breaks", () => {
  assert.equal(checkLogPath("logs/a\0b.log", PROJECT).ok, false);
  assert.equal(checkLogPath("logs/a\nb.log", PROJECT).ok, false);
});

// R2 (§27.4): the `.env` is the source the redaction draws its secrets
// from — allowing it as a log source turns the protection against itself.
// The copies next to it (`.env.local`, `.env.bak`) contain the same values
// and therefore have to be included.
test("checkLogPath rejects the .env including copies and the compose file", () => {
  for (const pathname of [
    ".env",
    "unterordner/.env",
    ".env.local",
    ".env.bak",
    "compose.yaml",
    "docker-compose.yml"
  ]) {
    const result = checkLogPath(pathname, PROJECT);
    assert.equal(result.ok, false, pathname);
    assert.equal(!result.ok && result.reason, "path-blocked", pathname);
  }
});

// Counter-check: a name that just happens to start with "env" is not a `.env`.
test("checkLogPath does not accidentally block harmless names", () => {
  assert.equal(checkLogPath("environment.log", PROJECT).ok, true);
  assert.equal(checkLogPath("logs/.environment", PROJECT).ok, true);
});

test("checkLogPath rejects empty segments instead of silently smoothing them", () => {
  assert.equal(checkLogPath("logs//latest.log", PROJECT).ok, false);
  assert.equal(checkLogPath("./latest.log", PROJECT).ok, false);
});

// --- Reading backwards ------------------------------------------------------

test("lastLinesFrom returns the last n lines without the empty trailing piece", () => {
  const { lines, partial } = lastLinesFrom("a\nb\nc\n", 2, true);
  assert.deepEqual(lines, ["b", "c"]);
  assert.equal(partial, false);
});

test("lastLinesFrom reports a possibly cut-off first line", () => {
  // Not read from the start of the file and fewer lines than requested: the
  // first one may begin mid-sentence.
  const { lines, partial } = lastLinesFrom("lb ist nur die Haelfte\nganz\n", 5, false);
  assert.deepEqual(lines, ["lb ist nur die Haelfte", "ganz"]);
  assert.equal(partial, true);
});

// --- File system ------------------------------------------------------------

function tempProject(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "logdatei-"));
}

test("openLogFile rejects a symlink that leads out of the project", async (t) => {
  const root = tempProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "palworld");
  fs.mkdirSync(project);
  const outside = path.join(root, "geheim.txt");
  fs.writeFileSync(outside, "streng geheim\n");

  const link = path.join(project, "latest.log");
  try {
    fs.symlinkSync(outside, link);
  } catch {
    // Windows without developer mode may not create symlinks — then the
    // case cannot be checked here, but it can on the target host (Linux).
    t.skip("symlinks not allowed");
    return;
  }

  const pathname = checkLogPath("latest.log", project);
  assert.equal(pathname.ok, true);
  const result = await openLogFile(pathname.ok ? pathname.absolute : "", project);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "path-outside");
});

test("openLogFile rejects a directory", async (t) => {
  const root = tempProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "logs"));

  const result = await openLogFile(
    path.join(root, "logs").replace(/\\/g, "/"),
    root.replace(/\\/g, "/")
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "not-a-file");
});

test("openLogFile reports a missing file as a reason of its own", async (t) => {
  const root = tempProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await openLogFile(
    `${root.replace(/\\/g, "/")}/gibtsnicht.log`,
    root.replace(/\\/g, "/")
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "file-missing");
});

test("openLogFile returns the validated descriptor, pinned against path swapping", async (t) => {
  const root = fs.realpathSync(tempProject()).replace(/\\/g, "/");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = `${root}/latest.log`;
  fs.writeFileSync(file, "geprueft\n");

  const result = await openLogFile(file, root);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  try {
    fs.renameSync(file, `${file}.alt`);
    fs.writeFileSync(file, "ausgetauscht\n");
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await result.file.handle.read(buffer, 0, buffer.length, 0);
    assert.equal(buffer.subarray(0, bytesRead).toString("utf8"), "geprueft\n");
  } finally {
    await result.file.handle.close();
  }
});

test("openLogFile detects a mismatch between path and descriptor identity", async (t) => {
  const root = fs.realpathSync(tempProject()).replace(/\\/g, "/");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = `${root}/latest.log`;
  fs.writeFileSync(file, "sicher\n");

  const originalStat = fs.promises.stat;
  fs.promises.stat = (async (...args: Parameters<typeof fs.promises.stat>) => {
    const stat = await originalStat(...args);
    // Windows reports inode values above Number.MAX_SAFE_INTEGER. `+ 1` can
    // round back to the identical IEEE-754 value and made this security test
    // nondeterministically ineffective; use a representable distance.
    Object.defineProperty(stat, "ino", { value: Number(stat.ino) + 1_000_000 });
    return stat;
  }) as typeof fs.promises.stat;

  try {
    const result = await openLogFile(file, root);
    assert.deepEqual(result, { ok: false, reason: "file-replaced" });
  } finally {
    fs.promises.stat = originalStat;
  }
});

test("readLastLines fetches the tail of a file across several blocks", async (t) => {
  const root = tempProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "large.log");
  const lines = Array.from({ length: 5000 }, (_, index) => `line ${index}`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);

  const handle = await fs.promises.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const result = await readLastLines(handle, size, 3);
    assert.deepEqual(result.lines, ["line 4997", "line 4998", "line 4999"]);
    assert.equal(result.position, size);
    assert.equal(result.partial, false);
  } finally {
    await handle.close();
  }
});

test("tailLogFile delivers the tail and then what is appended", async (t) => {
  const root = fs.realpathSync(tempProject()).replace(/\\/g, "/");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = `${root}/latest.log`;
  fs.writeFileSync(file, "alt 1\nalt 2\n");

  const seen: string[] = [];
  const controller = new AbortController();
  const run = tailLogFile(
    file,
    root,
    { tail: 5, intervalMs: 10 },
    (line) => seen.push(line.text),
    controller.signal
  );

  await waitUntil(() => seen.length >= 2);
  fs.appendFileSync(file, "neu 1\n");
  await waitUntil(() => seen.length >= 3);

  controller.abort();
  await run;
  assert.deepEqual(seen.slice(0, 3), ["alt 1", "alt 2", "neu 1"]);
});

// The reason why the inode is looked at at all: after a rotation, a window
// that only depends on the size would never have shown anything again.
test("tailLogFile starts from the beginning again after a rotation", async (t) => {
  const root = fs.realpathSync(tempProject()).replace(/\\/g, "/");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = `${root}/latest.log`;
  fs.writeFileSync(file, "vorher\n");

  const seen: string[] = [];
  const controller = new AbortController();
  const run = tailLogFile(
    file,
    root,
    { tail: 5, intervalMs: 10 },
    (line) => seen.push(line.text),
    controller.signal
  );

  await waitUntil(() => seen.length >= 1);
  fs.renameSync(file, `${root}/latest.log.1`);
  fs.writeFileSync(file, "nachher\n");
  await waitUntil(() => seen.includes("nachher"));

  controller.abort();
  await run;
  assert.deepEqual(seen, ["vorher", "nachher"]);
});

test("tailLogFile does not follow a symlink outside on rotation", async (t) => {
  const root = fs.realpathSync(tempProject()).replace(/\\/g, "/");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = `${root}/palworld`;
  fs.mkdirSync(project);
  const outside = `${root}/weggetragen.log`;
  const sampleTarget = `${root}/probe-ziel.log`;
  fs.writeFileSync(sampleTarget, "probe\n");

  // Check the capability before following starts; that way a skip leaves no
  // open background run behind (Windows without developer mode).
  const sample = `${project}/probe-link`;
  try {
    fs.symlinkSync(sampleTarget, sample);
    fs.unlinkSync(sample);
  } catch {
    t.skip("symlinks not allowed");
    return;
  }

  const file = `${project}/latest.log`;
  fs.writeFileSync(file, "sicher\n");
  const seen: string[] = [];
  const controller = new AbortController();
  const run = tailLogFile(
    file,
    project,
    { tail: 5, intervalMs: 10 },
    (line) => seen.push(line.text),
    controller.signal
  );

  await waitUntil(() => seen.includes("sicher"));
  const rejection = assert.rejects(run, new RegExp("path-outside"));
  // The same already open file is moved out of the project and put back under
  // the old name via a symlink. Device/inode thereby stay IDENTICAL; only the
  // repeated realpath containment check detects the change. The appended
  // secret must never travel despite the pinned FD.
  fs.renameSync(file, outside);
  fs.symlinkSync(outside, file);
  fs.appendFileSync(outside, "streng geheim\n");
  await rejection;

  assert.equal(seen.includes("streng geheim"), false);
});

test("tailLogFile aborts on a missing file with a reason of its own", async (t) => {
  const root = fs.realpathSync(tempProject()).replace(/\\/g, "/");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  await assert.rejects(
    () =>
      tailLogFile(
        `${root}/gibtsnicht.log`,
        root,
        { tail: 5, intervalMs: 10 },
        () => {},
        controller.signal
      ),
    /file-missing/
  );
});

// --- The failure reason set of log-file (issue #82) --------------------------
//
// These tests do NOT copy out the twelve values — that would only check what
// is in the type anyway, and would silently drift apart at the next new
// PathError value (exactly the state issue #82 is meant to eliminate). Instead
// they check the CONSTRUCTION: that OPEN_ERROR_REASONS contains every
// PATH_ERROR_REASONS value and that LOG_FILE_FAILURE_REASONS contains every
// OPEN_ERROR_REASONS value, each via a subset check instead of a second
// enumeration. A new value in PATH_ERROR_REASONS or OPEN_ERROR_REASONS changes
// one of the three lengths (6 / 10 / 12) and turns one of these tests red by
// exactly THAT — without any concrete value appearing twice here.

test("PATH_ERROR_REASONS has six unique values", () => {
  assert.equal(new Set(PATH_ERROR_REASONS).size, PATH_ERROR_REASONS.length, "duplicate in PATH_ERROR_REASONS");
  assert.equal(PATH_ERROR_REASONS.length, 6);
});

test("OPEN_ERROR_REASONS contains PATH_ERROR_REASONS completely, plus exactly four more", () => {
  const pathReasons: readonly string[] = PATH_ERROR_REASONS;
  const openReasons: readonly string[] = OPEN_ERROR_REASONS;
  for (const reason of pathReasons) {
    assert.ok(openReasons.includes(reason), `PathError value "${reason}" missing from OPEN_ERROR_REASONS`);
  }
  assert.equal(new Set(OPEN_ERROR_REASONS).size, OPEN_ERROR_REASONS.length, "duplicate in OPEN_ERROR_REASONS");
  // Not hard-wired as "= 10" but relative to PATH_ERROR_REASONS: if
  // PATH_ERROR_REASONS grows without OPEN_ERROR_REASONS following via spread,
  // this comparison falls apart and the test turns red.
  assert.equal(OPEN_ERROR_REASONS.length, PATH_ERROR_REASONS.length + 4);
});

test("LOG_FILE_FAILURE_REASONS matches OpenError plus 'log-file-failed'", () => {
  const openReasons: readonly string[] = OPEN_ERROR_REASONS;
  const fileReasons: readonly string[] = LOG_FILE_FAILURE_REASONS;
  for (const reason of openReasons) {
    assert.ok(fileReasons.includes(reason), `OpenError value "${reason}" missing from LOG_FILE_FAILURE_REASONS`);
  }
  const extra = fileReasons.filter((reason) => !openReasons.includes(reason));
  assert.deepEqual([...extra].sort(), ["log-file-failed"]);
  assert.equal(new Set(LOG_FILE_FAILURE_REASONS).size, LOG_FILE_FAILURE_REASONS.length, "duplicate in LOG_FILE_FAILURE_REASONS");
  // The eleven: 6 PathError + 4 further OpenError values + 1 reason of the
  // handler's own ("log-file-failed"). The mark drops from 12 to 11
  // because the WAY OF COUNTING changed, not because a case broke: since #80
  // "abgebrochen" is no longer a failure reason but no failure line at all.
  assert.equal(LOG_FILE_FAILURE_REASONS.length, 11);
});

test("no failure reason is called 'abgebrochen' — the abort has dropped out of the set (#80)", () => {
  const fileReasons: readonly string[] = LOG_FILE_FAILURE_REASONS;
  assert.equal(fileReasons.includes("abgebrochen"), false);
});

async function waitUntil(condition: () => boolean, maxMs = 3000): Promise<void> {
  const end = Date.now() + maxMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
