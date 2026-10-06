// Additional log files per container (S8 — K1e,
// CONTAINER_ETAPPENPLAN_LOCAL.md §20.2).
//
// The problem is real and common: game servers do not write to stdout but to
// their own files (`Saved/Logs/Palworld.log`, `logs/latest.log`).
// `docker logs` then shows the start banner and nothing else. With third-party
// images this cannot be fixed — the clean remedy (a symlink to `/dev/stdout`)
// requires an image change, and rewriting an adopted Compose file is
// explicitly not the way (stage 5d).
//
// So reading happens directly from the HOST file system. That is not the
// stopgap but the better way: it needs no container access and therefore also
// works for a STOPPED container — exactly when one wants to know why it is
// down.
//
// ⚠️ The crux of this stage is the path question. Unlike the Compose file
// (compose.ts/locationFor, "the path is not accepted but derived"), here a
// piece of path DOES come from outside — it is an operator setting per
// container. The guarantee is therefore a different one, but not a weaker one:
//
//   * The ROOT still comes exclusively from the container's labels
//     (composeContextOf) — the caller cannot name it.
//   * The relative part is checked syntactically (no `..`, not absolute, no
//     null byte) AND the result is then held against the root once more —
//     belt and braces, as in locationFor.
//   * And because a symlink defeats any pure path arithmetic, the RESOLVED
//     path (realpath) is additionally checked against the same root. Without
//     that, an `ln -s /etc/shadow logs/latest.log` in the project directory
//     would suffice.
//
// And: the root is the directory of THIS container, not the global base path
// (§20.2, R2 in §27.4). Otherwise "add log file" would be the way to read from
// the neighbouring container.

import {
  LOG_FILE_FAILURE_REASONS,
  LOG_OPEN_FAILURE_REASONS,
  LOG_PATH_FAILURE_REASONS,
  type LogFileFailureReason
} from "contract";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isInsideBase } from "./compose.js";
import { normalizePath } from "./hardening.js";
import { ENV_FILE_NAME } from "./env-file.js";

// File names that live below the project directory but are never read as a
// "log file" — they are not logs, and one of them (`.env`) is of all things the
// source the redaction draws its secrets from. Allowing them as a log source
// would turn the protection against itself: `redactKnownSecrets` masks only
// values of 8 characters or more, the key names and everything shorter would
// stand in plain text in the log window.
const BLOCKED_COMPOSE_FILES = new Set([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml"
]);

// ⚠️ Prefix instead of equality for `.env`: Compose itself only reads `.env`,
// but in practice `.env.local`, `.env.bak` and `.env.example` regularly sit
// next to it. A block that only knows the exact name lets through exactly the
// copies that contain the same values.
//
// This is a backstop, not a boundary: the boundary is the self-management lock
// and `checkLogPath` against the container's own project directory, including
// the realpath check in `openLogFile`.
function isBlockedName(name: string): boolean {
  return (
    name === ENV_FILE_NAME ||
    name.startsWith(`${ENV_FILE_NAME}.`) ||
    BLOCKED_COMPOSE_FILES.has(name)
  );
}

export type PathValidation =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; reason: PathError };

// As an array instead of a pure type union: a type is gone at runtime, but a
// reconciliation script (issue #82) can import and count `PATH_ERROR_REASONS`.
// `PathError` is DERIVED from the array (`typeof …[number]`), not the other way
// round — otherwise array and type would drift apart at some point.
// Since #272 the list lives in the shared contract (`LOG_PATH_FAILURE_REASONS`).
export const PATH_ERROR_REASONS = LOG_PATH_FAILURE_REASONS;

export type PathError = (typeof PATH_ERROR_REASONS)[number];

// Pure: no file system access, so that the same rule can be tested without a
// host. The file system side (exists, is a file, is not a symlink to the
// outside) sits in `openLogFile`.
export function checkLogPath(relativeRaw: string, projectDir: string): PathValidation {
  const relative = relativeRaw.trim();
  if (!relative) return { ok: false, reason: "path-empty" };
  // Null byte and line breaks: neither would ever appear in a configuration
  // line on purpose, and both are the start of a bypass.
  if (/[\0\r\n]/.test(relative)) return { ok: false, reason: "path-invalid-characters" };
  // Backslashes are NOT translated to "/": the agent runs on Linux, where "\"
  // is a valid character IN a file name. A silent translation would be a
  // second interpretation of the same string — and two interpretations are
  // where traversal checks fail.
  if (relative.startsWith("/")) return { ok: false, reason: "path-absolute" };

  const parts = relative.split("/");
  // Empty segments (`a//b`) and `.` would be harmless, but they mean that the
  // stored path is not the checked one. Rejected instead of normalised: an
  // input that is stored differently than it was entered is one more reason
  // for surprise.
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return { ok: false, reason: "path-traversal" };
  }
  if (isBlockedName(parts[parts.length - 1])) {
    return { ok: false, reason: "path-blocked" };
  }

  const absolute = normalizePath(`${normalizePath(projectDir)}/${relative}`);
  // Belt and braces, just as in locationFor: the pattern above does not allow
  // "/" at the start or "..", but the guarantee that counts here should not
  // depend on the completeness of a character check.
  if (!isInsideBase(absolute, projectDir)) return { ok: false, reason: "path-outside" };

  return { ok: true, relative, absolute };
}

// Just like PATH_ERROR_REASONS above: the array attaches itself to
// PATH_ERROR_REASONS via spread — a new PathError value thus comes along
// automatically instead of being enumerated here a second time (and
// potentially differently).
export const OPEN_ERROR_REASONS = LOG_OPEN_FAILURE_REASONS;

export type OpenError = (typeof OPEN_ERROR_REASONS)[number];

export type OpenedLogFile = {
  absolute: string;
  real: string;
  size: number;
  device: number;
  inode: number;
  // The validated descriptor travels with the result. Opening again by path
  // between check and read would be exactly the TOCTOU window this function is
  // meant to close.
  handle: FileHandle;
};

export type OpenResult =
  | { ok: true; file: OpenedLogFile }
  | { ok: false; reason: OpenError };

// The file system side of the check. Three things that pure path arithmetic
// cannot do:
//
//  1. **Symlink.** On Linux, O_NOFOLLOW prevents the last symlink; a
//     subsequent `realpath` also checks symlinks in parent directories
//     against the project directory.
//  2. **File type.** A FIFO or a device under /dev would block on reading
//     instead of returning lines. O_NONBLOCK plus `fstat` on the already open
//     descriptor lets only regular files through.
//  3. **TOCTOU.** `fstat` of the descriptor and `stat` of the resolved path
//     must denote the same file (device/inode). After that, reading happens
//     exclusively through exactly this descriptor.
export async function openLogFile(
  absolute: string,
  projectDir: string
): Promise<OpenResult> {
  const securityFlags =
    process.platform === "linux" ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0;

  let handle: FileHandle;
  try {
    handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | securityFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "file-missing" };
    if (code === "ELOOP") return { ok: false, reason: "path-outside" };
    if (code === "EISDIR") return { ok: false, reason: "not-a-file" };
    return { ok: false, reason: "not-readable" };
  }

  const reject = async (reason: OpenError): Promise<OpenResult> => {
    await handle.close().catch(() => {});
    return { ok: false, reason };
  };

  let descriptorStat: fs.Stats;
  try {
    descriptorStat = await handle.stat();
  } catch {
    return reject("not-readable");
  }
  if (!descriptorStat.isFile()) return reject("not-a-file");

  let real: string;
  let realBase: string;
  try {
    [real, realBase] = await Promise.all([
      fs.promises.realpath(absolute),
      fs.promises.realpath(projectDir)
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return reject("path-outside");
    if (code === "ENOENT" || code === "ENOTDIR") return reject("file-replaced");
    return reject("not-readable");
  }

  // ⚠️ Deliberately `path` here instead of `isInsideBase`: two REAL paths
  // returned by the operating system are compared, not values from a
  // configuration. `realpath` returns them in the system's notation — the
  // posix arithmetic of `isInsideBase` would remain a second interpretation
  // of them. The project directory is resolved as well, otherwise the check
  // would fail as soon as any parent directory is itself a symlink.
  if (!isWithin(real, realBase)) return reject("path-outside");
  // The resolved name counts just the same: a symlink `app.log` pointing to the
  // `.env` of the same directory would otherwise slip through.
  if (isBlockedName(path.basename(real))) return reject("path-blocked");

  let pathStat: fs.Stats;
  try {
    pathStat = await fs.promises.stat(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return reject("file-replaced");
    return reject("not-readable");
  }
  if (
    !pathStat.isFile() ||
    pathStat.dev !== descriptorStat.dev ||
    pathStat.ino !== descriptorStat.ino
  ) {
    return reject("file-replaced");
  }

  return {
    ok: true,
    file: {
      absolute,
      real,
      size: descriptorStat.size,
      device: descriptorStat.dev,
      inode: descriptorStat.ino,
      handle
    }
  };
}

// Truly below, not equal — the same statement as `isInsideBase`, just on the
// system's path notions instead of pure posix character arithmetic.
function isWithin(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// --- Reading backwards -----------------------------------------------------

// How far back reading goes at most to find `tail` lines. A log file can be
// gigabytes in size; reading therefore happens from the END in blocks and with
// a hard cap — not the file, but its tail.
export const MAX_BACKWARD_BYTES = 512 * 1024;
const BLOCK_BYTES = 64 * 1024;

// The last `count` lines of a piece of text. `partial` says whether the first
// returned line is possibly incomplete — that is the case when the cap kicked
// in and the start of the line lies beyond it. Without this flag, half a
// sentence would stand in the log window looking like a real line.
export function lastLinesFrom(text: string, count: number, fromFileStart: boolean): {
  lines: string[];
  partial: boolean;
} {
  const lines = text.split("\n");
  // A trailing line break produces an empty last element — that is not a
  // line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const capped = lines.length > count;
  const selection = capped ? lines.slice(lines.length - count) : lines;
  return { lines: selection, partial: !fromFileStart && !capped && selection.length > 0 };
}

// Reads the last `tail` lines and at the same time returns the position from
// which following continues — that is always the END OF THE FILE, not the end
// of what was read: whatever was added between stat and read is fetched by the
// first poll.
export async function readLastLines(
  handle: fs.promises.FileHandle,
  size: number,
  tail: number
): Promise<{ lines: string[]; partial: boolean; position: number }> {
  if (size <= 0 || tail <= 0) return { lines: [], partial: false, position: Math.max(0, size) };

  let loaded = Buffer.alloc(0);
  let end = size;
  let fromFileStart = false;

  while (end > 0 && loaded.length < MAX_BACKWARD_BYTES) {
    const length = Math.min(BLOCK_BYTES, end, MAX_BACKWARD_BYTES - loaded.length);
    const start = end - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    loaded = Buffer.concat([buffer.subarray(0, bytesRead), loaded]);
    end = start;
    if (end === 0) fromFileStart = true;
    // Enough line breaks gathered? Then the rest of the file is of no interest.
    // `tail + 1`, because the first break from the back only marks the end of
    // the last line.
    if (countBreaks(loaded) >= tail + 1) break;
  }

  const { lines, partial } = lastLinesFrom(loaded.toString("utf8"), tail, fromFileStart);
  return { lines, partial, position: size };
}

function countBreaks(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}

// --- Following --------------------------------------------------------------

export type LogFileLine = { text: string; partial?: boolean };

export type FollowOptions = {
  tail: number;
  // How often to look. `fs.watch` would be event-driven, but is notoriously
  // unreliable on bind mounts and across file system boundaries (and on some
  // setups reports nothing at all). A poll every second is fast enough for a
  // log window and has no silent outages.
  intervalMs?: number;
};

// How much is delivered per poll at most. A container that writes 50 MB in one
// second must not drive the agent out of memory — the rest comes in the next
// round.
const MAX_REFILL_BYTES = 1024 * 1024;
// Otherwise a line without a line break grows unbounded in the buffer.
const MAX_LINE_CHARS = 64 * 1024;

// ⚠️ Since #80 `reason` is exactly OpenError and no longer `OpenError |
// "abgebrochen"`. The abort sat in this union without ever being thrown:
// `tailLogFile` RETURNS normally on an abort (see the two
// `if (signal.aborted) return`). The value was assigned solely by the handler
// in src/routes/container-routes.ts — and that one now sends no error line at
// all on an abort.
export class TailEnded extends Error {
  constructor(readonly reason: OpenError) {
    super(`log file follow ended: ${reason}`);
    this.name = "TailEnded";
  }
}

// The complete failure reason set of the `log-file` stream (issue #82):
// the ten OPEN_ERROR_REASONS (the six PATH_ERROR_REASONS included) from
// `TailEnded.reason` and "log-file-failed" — the only reason that does
// not come from `TailEnded` but is assigned by the handler in
// src/routes/container-routes.ts when the error is not a recognised TailEnded
// instance. Eleven values, in ONE place: until now this set stood together
// nowhere, a consumer had to gather it from three places (log-file.ts twice,
// the route handler once).
//
// ⚠️ "abgebrochen" was the twelfth value here until #80 and has been dropped,
// not renamed: an abort means "the caller closed the connection", and that is
// exactly the path on which the error line would have to arrive. The handler
// in src/routes/container-routes.ts no longer sends one on an abort — the same
// decision as for logs-stream and pull-stream.
//
// Deliberately NOT shared with LOGS_STREAM_FAILURE_REASONS or
// PULL_STREAM_FAILURE_REASONS (stream-failure-reasons.ts): the three streams
// have different reason sets, and a common base type would be a claim that is
// already wrong today.
export { LOG_FILE_FAILURE_REASONS };
export type { LogFileFailureReason };

// Reads the tail of the file and then attaches to its growth until `signal`
// aborts.
//
// Rotation: many services move `app.log` away and create a new one (new inode)
// or truncate it to 0. Both are detected — by a size that is SMALLER than the
// last read position, or by a changed inode — and lead to a restart at
// position 0. Without that, one would have a dead window after the first
// rotation that never shows anything again.
export async function tailLogFile(
  absolute: string,
  projectDir: string,
  options: FollowOptions,
  onLine: (line: LogFileLine) => void,
  signal: AbortSignal
): Promise<void> {
  const intervalMs = options.intervalMs ?? 1000;

  const opened = await openLogFile(absolute, projectDir);
  if (!opened.ok) throw new TailEnded(opened.reason);

  let handle = opened.file.handle;
  let real = opened.file.real;
  let device = opened.file.device;
  let inode = opened.file.inode;
  let position: number;
  let rest = "";

  try {
    const initial = await readLastLines(handle, opened.file.size, options.tail);
    position = initial.position;
    initial.lines.forEach((text, index) =>
      onLine(index === 0 && initial.partial ? { text, partial: true } : { text })
    );

    for (;;) {
      await sleep(intervalMs, signal);
      if (signal.aborted) return;

      // Via the PATH instead of the open handle: only that way does it show
      // that a different file now sits under the same name.
      let stat: fs.Stats;
      let currentReal: string;
      try {
        [stat, currentReal] = await Promise.all([
          fs.promises.stat(absolute),
          fs.promises.realpath(absolute)
        ]);
      } catch (error) {
        // Gone — with a rotation that renames first and then creates anew, that
        // is a state of milliseconds. The next round finds it again; if it
        // disappears for good, the window simply stays quiet.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new TailEnded("path-outside");
        }
        throw new TailEnded("not-readable");
      }

      if (
        currentReal !== real ||
        stat.dev !== device ||
        stat.ino !== inode ||
        stat.size < position
      ) {
        // ⚠️ On reopening, the FULL check is repeated, not just `open`. After a
        // rotation a DIFFERENT file sits under the same name — and whether that
        // one is a symlink to the outside was not answered by the earlier
        // check. A guarantee that only holds at connection setup is none for
        // a continuous stream.
        const reopened = await openLogFile(absolute, projectDir);
        if (!reopened.ok) {
          if (reopened.reason === "file-missing") continue;
          throw new TailEnded(reopened.reason);
        }
        const oldHandle = handle;
        handle = reopened.file.handle;
        real = reopened.file.real;
        device = reopened.file.device;
        inode = reopened.file.inode;
        position = 0;
        // The partial line remainder belongs to the old file.
        rest = "";
        await oldHandle.close().catch(() => {});
        stat = await handle.stat();
      }

      while (position < stat.size) {
        if (signal.aborted) return;
        const length = Math.min(MAX_REFILL_BYTES, stat.size - position);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;

        // No streaming decoder: a refill almost never ends in the middle of a
        // UTF-8 sequence, and the alternative (a TextDecoder across the whole
        // follow) keeps state across rotations that then has to be reset. A
        // replaced character at a block boundary is the smaller price.
        rest += buffer.subarray(0, bytesRead).toString("utf8");
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        for (const text of parts) onLine({ text });
        if (rest.length > MAX_LINE_CHARS) {
          onLine({ text: rest.slice(0, MAX_LINE_CHARS) });
          rest = "";
        }
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

// An abortable wait. Without unsubscribing at the end, a long follow
// accumulates one listener per round on the same signal.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
