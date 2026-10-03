// Web FTP in the share directory (S19 — K6, CONTAINER_ETAPPENPLAN_LOCAL §5.3,
// originally stage 8).
//
// The job is "make a container's files accessible to third parties" —
// download a save game, upload a mod. §5.3 deliberately draws the line
// tighter than "access to the mount": the mount of a game server also holds
// configuration, backups and start scripts. What applies is therefore a
// subdirectory EXPLICITLY chosen per container, the `freigabe_pfad`. Without it
// there is no file access — not even for the operator, not even with a grant.
//
// ⚠️ Three roots, three different guarantees — mixing them up is the mistake
// this module is meant to prevent:
//
//   1. The PROJECT DIRECTORY comes from the labels of the running container
//      (composeContextOf) and never from the caller. As in S8.
//   2. The SHARE is a relative path below it. It comes from the agent's own
//      copy of the registry (RegistryEntry.freigabePfad) — not from the
//      request of the respective action. That is the difference to the log
//      files from S8, where the relative part comes with the request: there it
//      is reading, here it is writing as well.
//   3. The ENTRY inside the share comes with the request — it cannot be any
//      other way, that is the whole point of using it. It is checked
//      syntactically, the result is held against the share AND, after opening,
//      once more via the resolved path (realpath), because a symlink defeats any
//      pure path arithmetic.
//
// Traversal is checked against the SHARE, not against the base path and not
// against the project directory (§5.3 verbatim). A `..` here does not lead
// into the neighbouring container but into the configuration of the same
// container — and that is exactly what the share is meant to prevent.

import { MAX_ENTRIES, MAX_TEXT_BYTES } from "contract";
import fs from "node:fs";
import path from "node:path";
import { isInsideBase } from "./compose.js";
import { hashOf } from "./compose-store.js";
import { normalizePath } from "./hardening.js";
import { ENV_FILE_NAME } from "./env-file.js";

// The same block list as for the file logs (log-file.ts) and for the same
// reason: the `.env` is the source the redaction draws its secrets from.
// Making it downloadable via Web FTP would turn the protection against
// itself. Compose files have their own, intern-only path with
// `docker.compose.raw` — via the share they would bypass it.
//
// Usually neither of them is inside the share at all, because the share is a
// real subdirectory. The block is the fallback for the case that a project
// keeps another `.env` further down.
const BLOCKED_FILES = new Set([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml"
]);

export function isBlockedName(name: string): boolean {
  return (
    name === ENV_FILE_NAME ||
    name.startsWith(`${ENV_FILE_NAME}.`) ||
    BLOCKED_FILES.has(name.toLowerCase())
  );
}

export type WebftpPathError =
  | "path-absolute"
  | "path-traversal"
  | "path-invalid-characters"
  | "path-blocked"
  | "path-outside"
  | "path-too-long"
  | "share-empty";

// A single name segment, as accepted when creating, uploading and renaming.
// Deliberately stricter than a path segment would have to be: a leading
// hyphen is an option prefix on the command line, and while the names never
// end up in a shell, sooner or later someone will look at them in one. `/` and
// `\` are always invalid here — a name is not a path.
const MAX_NAME_CHARS = 100;

export function checkName(rawName: string): { ok: true; name: string } | { ok: false; reason: WebftpPathError } {
  const name = rawName.trim();
  if (!name || name === "." || name === "..") return { ok: false, reason: "path-traversal" };
  if (name.startsWith("-")) return { ok: false, reason: "path-invalid-characters" };
  if (isBlockedName(name)) return { ok: false, reason: "path-blocked" };

  // ⚠️ The check runs on the BYTES, not on the string — the finding from the
  // S19 security review. A character like U+012F ("į") contains no `/`, but a
  // latin1 encoding turns it into one: checking a string says nothing about
  // what ends up in a byte field. The tar header checks the same thing once
  // more right before writing (tar.ts); this line exists so that the caller
  // gets an understandable reason instead of an exception from the format
  // layer.
  const bytes = Buffer.from(name, "utf8");
  if (bytes.includes(0x2f) || bytes.includes(0x5c) || bytes.includes(0x00)) {
    return { ok: false, reason: "path-invalid-characters" };
  }
  if (bytes.includes(0x0a) || bytes.includes(0x0d)) return { ok: false, reason: "path-invalid-characters" };
  // Byte length, not character count: the tar header holds 100 BYTES (tar.ts).
  if (bytes.length > MAX_NAME_CHARS) return { ok: false, reason: "path-too-long" };
  return { ok: true, name };
}

export type ShareValidation =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; reason: WebftpPathError };

// The share directory itself, checked against the project directory.
//
// ⚠️ An empty path is an ERROR, not "the whole directory". That is the core of
// §5.3: the share is a deliberate choice. A default that silently shares
// everything would be exactly the coarseness it was introduced against.
export function checkSharePath(relativeRaw: string, projectDir: string): ShareValidation {
  const relative = relativeRaw.trim().replace(/\/+$/, "");
  if (!relative) return { ok: false, reason: "share-empty" };
  if (/[\0\r\n]/.test(relative)) return { ok: false, reason: "path-invalid-characters" };
  if (relative.startsWith("/")) return { ok: false, reason: "path-absolute" };
  if (relative.length > 512) return { ok: false, reason: "path-too-long" };

  const parts = relative.split("/");
  // Rejected rather than normalised, as in log-file.ts: an input that is
  // stored differently from how it was entered is one more source of surprise.
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return { ok: false, reason: "path-traversal" };
  }

  const absolute = normalizePath(`${normalizePath(projectDir)}/${relative}`);
  // Belt and braces, as in locationFor and checkLogPath.
  if (!isInsideBase(absolute, projectDir)) return { ok: false, reason: "path-outside" };

  return { ok: true, relative, absolute };
}

export type EntryValidation =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; reason: WebftpPathError };

// A path INSIDE the share. Empty is allowed here and means the share itself —
// that is the start view of the file list.
export function checkEntryPath(relativeRaw: string, shareAbsolute: string): EntryValidation {
  // ⚠️ A leading slash is NOT stripped. That would be the silent
  // reinterpretation of `/etc/shadow` as `<share>/etc/shadow` — not an escape,
  // but an input that means something other than what it says. Ambiguities of
  // exactly this kind are where path checks fail (the same consideration as in
  // log-file.ts about the backslash translation).
  const relative = relativeRaw.trim().replace(/\/+$/, "");
  if (!relative) return { ok: true, relative: "", absolute: normalizePath(shareAbsolute) };
  if (/[\0\r\n]/.test(relative)) return { ok: false, reason: "path-invalid-characters" };
  if (relative.startsWith("/")) return { ok: false, reason: "path-absolute" };
  if (relative.length > 1024) return { ok: false, reason: "path-too-long" };

  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return { ok: false, reason: "path-traversal" };
  }
  if (parts.some((part) => isBlockedName(part))) return { ok: false, reason: "path-blocked" };

  const absolute = normalizePath(`${normalizePath(shareAbsolute)}/${relative}`);
  if (!isInsideBase(absolute, shareAbsolute)) return { ok: false, reason: "path-outside" };

  return { ok: true, relative, absolute };
}

// --- Opening with the same guarantees as in S8 -------------------------------

export type OpenError =
  | WebftpPathError
  | "missing"
  | "wrong-kind"
  | "not-readable"
  | "replaced";

export type OpenedEntry = {
  absolute: string;
  real: string;
  size: number;
  changedAt: number;
  mode: number;
  uid: number;
  gid: number;
  handle: fs.promises.FileHandle;
};

export type OpenResult =
  | { ok: true; entry: OpenedEntry }
  | { ok: false; reason: OpenError };

// The file system side, identical in its guarantees to `openLogFile`
// (log-file.ts) and for the same three reasons: O_NOFOLLOW against the last
// symlink, `realpath` against symlinks in parent directories, device/inode
// against the TOCTOU window between check and use. Reading happens
// exclusively via the returned descriptor.
//
// The difference to S8: `art` is a parameter. Web FTP also opens directories
// (for listing), and a directory descriptor is the only way to check a
// directory and then list exactly that one.
export async function openBelow(
  absolute: string,
  root: string,
  kind: "file" | "directory"
): Promise<OpenResult> {
  const linux = process.platform === "linux";
  const securityFlags = linux ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0;
  const kindFlag = kind === "directory" && linux ? fs.constants.O_DIRECTORY : 0;

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | securityFlags | kindFlag);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    if (code === "ELOOP") return { ok: false, reason: "path-outside" };
    if (code === "EISDIR" || code === "ENOTDIR") return { ok: false, reason: "wrong-kind" };
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
  const kindMatches = kind === "directory" ? descriptorStat.isDirectory() : descriptorStat.isFile();
  // A FIFO or a device would block on read instead of delivering bytes;
  // `isFile` only lets regular files through.
  if (!kindMatches) return reject("wrong-kind");

  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([
      fs.promises.realpath(absolute),
      fs.promises.realpath(root)
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return reject("path-outside");
    if (code === "ENOENT" || code === "ENOTDIR") return reject("replaced");
    return reject("not-readable");
  }

  // The root MAY be itself here — unlike the log files, where only real
  // descendants qualified. Listing the share is the normal case of this route.
  if (real !== realRoot && !isWithin(real, realRoot)) {
    return reject("path-outside");
  }
  if (isBlockedName(path.basename(real))) return reject("path-blocked");

  let pathStat: fs.Stats;
  try {
    pathStat = await fs.promises.stat(real);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return reject("replaced");
    return reject("not-readable");
  }
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    return reject("replaced");
  }

  return {
    ok: true,
    entry: {
      absolute,
      real,
      size: descriptorStat.size,
      changedAt: Math.floor(descriptorStat.mtimeMs / 1000),
      mode: descriptorStat.mode & 0o7777,
      uid: descriptorStat.uid,
      gid: descriptorStat.gid,
      handle
    }
  };
}

function isWithin(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// --- Listing -----------------------------------------------------------------

export type WebftpKind = "file" | "directory" | "symlink" | "other";

export type WebftpEntry = {
  name: string;
  kind: WebftpKind;
  size: number;
  changedAt: number;
  // The service in the container runs under its own uid. Naming it here is not
  // curiosity but the explanation of why deleting in this directory works or
  // not (see `shareDiagnostics`).
  uid: number;
  gid: number;
};

// The maximum number of entries returned. A directory with 200,000 files
// should knock over neither the agent nor the UI; that the list was cut is
// stated in the response and not concealed.
export { MAX_ENTRIES };

export type ListResult = {
  entries: WebftpEntry[];
  truncated: boolean;
};

// ⚠️ `lstat` instead of `stat` per entry: a symlink is reported as such and NOT
// resolved. Showing it as what it points to would be the statement "there is a
// 4 GB large file here" about something that lies outside the share. It is
// never opened anyway (O_NOFOLLOW).
export async function listDirectory(
  absolute: string,
  root: string
): Promise<{ ok: true; list: ListResult } | { ok: false; reason: OpenError }> {
  const opened = await openBelow(absolute, root, "directory");
  if (!opened.ok) return { ok: false, reason: opened.reason };

  try {
    // Read via the already checked real path, not via the requested one:
    // between the check and readdir the requested path could point to
    // something else.
    const names = await fs.promises.readdir(opened.entry.real);
    const visible = names.filter((name) => !isBlockedName(name)).sort((a, b) => a.localeCompare(b, "de"));
    const truncated = visible.length > MAX_ENTRIES;

    const entries: WebftpEntry[] = [];
    for (const name of visible.slice(0, MAX_ENTRIES)) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(path.join(opened.entry.real, name));
      } catch {
        // Vanished between readdir and lstat — perfectly normal in the
        // directory of a running service. Skip it instead of failing the
        // whole list.
        continue;
      }
      entries.push({
        name,
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other",
        size: stat.isFile() ? stat.size : 0,
        changedAt: Math.floor(stat.mtimeMs / 1000),
        uid: stat.uid,
        gid: stat.gid
      });
    }

    return { ok: true, list: { entries, truncated } };
  } catch {
    return { ok: false, reason: "not-readable" };
  } finally {
    await opened.entry.handle.close().catch(() => {});
  }
}

// --- Diagnostics -------------------------------------------------------------

// What the agent actually CAN do in this directory — not what it is allowed to.
//
// The reason for this information: the agent runs as `node` (uid 1000) without
// CAP_CHOWN. If the share directory belongs to root or to the service user and
// is not group-writable, it can neither delete nor rename anything in it —
// uploading still works, because that goes through the daemon (tar.ts). This
// asymmetry needs explaining, so it is explained: the UI shows it when SETTING
// UP the share, not only when a delete fails.
export type ShareDiagnostics = {
  readable: boolean;
  // Deleting and renaming need write permission on the DIRECTORY, not on the
  // file — that is Unix semantics and the most common source of confusion.
  deletable: boolean;
  uid: number;
  gid: number;
  mode: number;
};

export async function shareDiagnostics(
  absolute: string,
  root: string
): Promise<{ ok: true; diagnostics: ShareDiagnostics } | { ok: false; reason: OpenError }> {
  const opened = await openBelow(absolute, root, "directory");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  try {
    const allowed = async (mode: number): Promise<boolean> => {
      try {
        await fs.promises.access(opened.entry.real, mode);
        return true;
      } catch {
        return false;
      }
    };
    return {
      ok: true,
      diagnostics: {
        readable: await allowed(fs.constants.R_OK | fs.constants.X_OK),
        deletable: await allowed(fs.constants.W_OK | fs.constants.X_OK),
        uid: opened.entry.uid,
        gid: opened.entry.gid,
        mode: opened.entry.mode
      }
    };
  } finally {
    await opened.entry.handle.close().catch(() => {});
  }
}

// --- Reading a text file (the built-in editor) -------------------------------

// The maximum size of a file that may end up in the editor. The editor is
// meant for configuration files and server lists, not for logs: putting a
// 40 MB file into a <textarea> is the same as a crash for the browser. Anyone
// who wants more downloads and uploads again.
export { MAX_TEXT_BYTES };

export type TextError = OpenError | "too-large" | "not-a-text-file";

export type TextResult =
  | { ok: true; content: string; hash: string; size: number }
  | { ok: false; reason: TextError };

// ⚠️ Whether a file is text is decided by its CONTENT, not by its extension. A
// `.cfg` that is really an SQLite image would otherwise be shown as broken
// text — and irrecoverably destroyed on save by the bytes→string→bytes
// conversion. Two criteria:
//
//   * a null byte does not occur in text, but it does in every binary format;
//   * the bytes must be readable as UTF-8 AND writable again without loss. The
//     round-trip comparison is the actual test: `toString("utf8")` silently
//     replaces invalid sequences with U+FFFD, and exactly this silent
//     replacement would be the data loss on save.
export async function readTextFile(absolute: string, root: string): Promise<TextResult> {
  const opened = await openBelow(absolute, root, "file");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  try {
    if (opened.entry.size > MAX_TEXT_BYTES) return { ok: false, reason: "too-large" };
    const buffer = Buffer.alloc(opened.entry.size);
    if (opened.entry.size > 0) {
      await opened.entry.handle.read(buffer, 0, opened.entry.size, 0);
    }
    if (buffer.includes(0)) return { ok: false, reason: "not-a-text-file" };
    const content = buffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buffer)) return { ok: false, reason: "not-a-text-file" };
    return { ok: true, content: content, hash: hashOf(content), size: opened.entry.size };
  } catch {
    return { ok: false, reason: "not-readable" };
  } finally {
    await opened.entry.handle.close().catch(() => {});
  }
}

// --- Removing and renaming ---------------------------------------------------

export type WriteError = OpenError | "no-write-permission" | "not-empty" | "already-exists";

// ⚠️ Deleting and renaming go through the HOST file system, not through the
// engine — the engine simply has no operation for it (`PUT
// /containers/{id}/archive` extracts, there is no counterpart that removes).
// They therefore need write permission on the directory, and where it is
// missing, the diagnostics say so beforehand instead of here afterwards.
//
// There is deliberately no recursion: an `rm -rf` through a web UI is the
// action where a misclick costs the most. A directory is deleted if it is
// empty, otherwise not.
export async function deleteEntry(
  absolute: string,
  root: string
): Promise<{ ok: true; kind: "file" | "directory" } | { ok: false; reason: WriteError }> {
  const asFile = await openBelow(absolute, root, "file");
  const opened = asFile.ok ? asFile : await openBelow(absolute, root, "directory");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const kind = asFile.ok ? "file" : "directory";
  // Deleting the share itself would leave the setting pointing into nothing —
  // rejected before anything happens.
  if (opened.entry.real === (await fs.promises.realpath(root).catch(() => null))) {
    await opened.entry.handle.close().catch(() => {});
    return { ok: false, reason: "path-blocked" };
  }
  await opened.entry.handle.close().catch(() => {});

  try {
    if (kind === "file") await fs.promises.unlink(opened.entry.real);
    else await fs.promises.rmdir(opened.entry.real);
    return { ok: true, kind: kind };
  } catch (error) {
    return { ok: false, reason: writeErrorFrom(error) };
  }
}

export async function renameEntry(
  absolute: string,
  newName: string,
  root: string
): Promise<{ ok: true; newPath: string } | { ok: false; reason: WriteError }> {
  const asFile = await openBelow(absolute, root, "file");
  const opened = asFile.ok ? asFile : await openBelow(absolute, root, "directory");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  await opened.entry.handle.close().catch(() => {});

  // The target is built from the DIRECTORY OF THE CHECKED, REAL path plus a
  // name without separators (checkName). Renaming therefore cannot move — and
  // certainly not out of the share.
  const target = path.join(path.dirname(opened.entry.real), newName);
  if (!isWithin(target, await fs.promises.realpath(root).catch(() => root))) {
    return { ok: false, reason: "path-outside" };
  }

  try {
    // `link`+`unlink` would be atomic-without-overwrite, but does not work for
    // directories. Instead: look first and refuse. A rename that silently
    // replaces someone else's file is the data loss nobody sees coming.
    await fs.promises.lstat(target);
    return { ok: false, reason: "already-exists" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: "not-readable" };
    }
  }

  try {
    await fs.promises.rename(opened.entry.real, target);
    return { ok: true, newPath: target };
  } catch (error) {
    return { ok: false, reason: writeErrorFrom(error) };
  }
}

function writeErrorFrom(error: unknown): WriteError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "no-write-permission";
  if (code === "ENOTEMPTY" || code === "EEXIST") return "not-empty";
  if (code === "ENOENT") return "missing";
  return "not-readable";
}

// --- Host path to container path ---------------------------------------------

export type MountInfo = { Source?: string; Destination?: string; RW?: boolean };

export type ContainerPath =
  | { ok: true; absolutePath: string; writable: boolean }
  | { ok: false; reason: "not-mounted" };

// The last step before `PUT /containers/{id}/archive`: the same location, in
// the container's language.
//
// ⚠️ The security decision was made long before this point — it is made
// entirely in the HOST path space (share, traversal, realpath). This function
// only translates, and it cannot open anything that was closed before: it
// looks for the mount that contains the already checked path. If it finds
// none, nothing is written — a fallback to another route would be a second
// interpretation of the same permission.
//
// The LONGEST matching mount wins: with nested mounts, the deeper one is the
// one actually visible at this location.
export function containerPathFor(hostPath: string, mounts: readonly MountInfo[]): ContainerPath {
  const target = normalizePath(hostPath);
  let match: { source: string; destination: string; rw: boolean } | null = null;

  for (const mount of mounts) {
    if (!mount.Source || !mount.Destination) continue;
    const source = normalizePath(mount.Source);
    const matches = target === source || target.startsWith(`${source.replace(/\/+$/, "")}/`);
    if (!matches) continue;
    if (match && match.source.length >= source.length) continue;
    match = { source, destination: normalizePath(mount.Destination), rw: mount.RW !== false };
  }

  if (!match) return { ok: false, reason: "not-mounted" };

  const rest = target.slice(match.source.replace(/\/+$/, "").length);
  const absolutePath = normalizePath(`${match.destination}${rest}`);
  return { ok: true, absolutePath, writable: match.rw };
}
