
import { type FileAccessError, MAX_ENTRIES, MAX_TEXT_BYTES } from "contract";
import fs from "node:fs";
import path from "node:path";
import { isInsideBase } from "./compose.js";
import { hashOf } from "./compose-store.js";
import { normalizePath } from "./hardening.js";
import { protectionOf, type SourcePolicy } from "./file-sources.js";
import { isBlockedName } from "./file-names.js";
import { definitionBlocked } from "./file-sources.js";
let protectedPolicy: SourcePolicy | null = null;
export function protectFilePaths(policy: SourcePolicy): void { protectedPolicy = policy; }
async function readBlocker(value: string): Promise<"backup-directory-protected" | "source-protected" | "path-blocked" | null> {
  if (!protectedPolicy) return null;
  if (await definitionBlocked(value, protectedPolicy)) return "path-blocked";
  const protection = await protectionOf(value, protectedPolicy);
  return protection === "backup" ? "backup-directory-protected" : protection === "agent" ? "source-protected" : null;
}
export async function fileWriteBlocker(value: string): Promise<FileAccessError | null> {
  if (!protectedPolicy) return null;
  if (await definitionBlocked(value, protectedPolicy)) return "path-blocked";
  const protection = await protectionOf(value, protectedPolicy);
  return protection === "backup" ? "backup-directory-protected" : protection !== "none" ? "source-protected" : null;
}
export function descriptorPath(entry: OpenedEntry): string {
  return process.platform === "linux" ? `/proc/self/fd/${entry.handle.fd}` : entry.real;
}

export { isBlockedName } from "./file-names.js";
export type WebftpPathError =
  | "path-absolute"
  | "path-traversal"
  | "path-invalid-characters"
  | "path-blocked"
  | "path-outside"
  | "path-too-long"
  | "share-empty";
const MAX_NAME_CHARS = 100;

export function checkName(rawName: string): { ok: true; name: string } | { ok: false; reason: WebftpPathError } {
  const name = rawName.trim();
  if (!name || name === "." || name === "..") return { ok: false, reason: "path-traversal" };
  if (name.startsWith("-")) return { ok: false, reason: "path-invalid-characters" };
  if (isBlockedName(name)) return { ok: false, reason: "path-blocked" };
  const bytes = Buffer.from(name, "utf8");
  if (bytes.includes(0x2f) || bytes.includes(0x5c) || bytes.includes(0x00)) {
    return { ok: false, reason: "path-invalid-characters" };
  }
  if (bytes.includes(0x0a) || bytes.includes(0x0d)) return { ok: false, reason: "path-invalid-characters" };
  if (bytes.length > MAX_NAME_CHARS) return { ok: false, reason: "path-too-long" };
  return { ok: true, name };
}

export type ShareValidation =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; reason: WebftpPathError };
export function checkSharePath(relativeRaw: string, projectDir: string): ShareValidation {
  const relative = relativeRaw.trim().replace(/\/+$/, "");
  if (!relative) return { ok: false, reason: "share-empty" };
  if (/[\0\r\n]/.test(relative)) return { ok: false, reason: "path-invalid-characters" };
  if (relative.startsWith("/")) return { ok: false, reason: "path-absolute" };
  if (relative.length > 512) return { ok: false, reason: "path-too-long" };

  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return { ok: false, reason: "path-traversal" };
  }

  const absolute = normalizePath(`${normalizePath(projectDir)}/${relative}`);
  if (!isInsideBase(absolute, projectDir)) return { ok: false, reason: "path-outside" };

  return { ok: true, relative, absolute };
}

export type EntryValidation =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; reason: WebftpPathError };
export function checkEntryPath(relativeRaw: string, shareAbsolute: string): EntryValidation {
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

export type OpenError =
  | WebftpPathError
  | "missing"
  | "wrong-kind"
  | "not-readable"
  | "replaced"
  | "backup-directory-protected"
  | "source-protected";

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
export async function openBelow(
  absolute: string,
  root: string,
  kind: "file" | "directory",
  writable = false
): Promise<OpenResult> {
  const blocker = await readBlocker(absolute);
  if (blocker) return { ok: false, reason: blocker };
  const linux = process.platform === "linux";
  const securityFlags = linux ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0;
  const kindFlag = kind === "directory" && linux ? fs.constants.O_DIRECTORY : 0;

  let handle: fs.promises.FileHandle;
  try {
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { ok: false, reason: "path-outside" };
    let parent = await fs.promises.open(root, (writable && !relative ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | securityFlags | (linux && relative ? fs.constants.O_DIRECTORY : kindFlag));
    try {
      for (const [index, part] of relative.split(path.sep).filter(Boolean).entries()) {
        const final = index === relative.split(path.sep).filter(Boolean).length - 1;
        const next = await fs.promises.open(linux ? `/proc/self/fd/${parent.fd}/${part}` : absolute,
          (writable && final ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | securityFlags | (final ? kindFlag : linux ? fs.constants.O_DIRECTORY : 0));
        await parent.close();
        parent = next;
      }
      handle = parent;
    } catch (error) { await parent.close().catch(() => {}); throw error; }
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
  if (!kindMatches) return reject("wrong-kind");

  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([
      fs.promises.realpath(linux ? `/proc/self/fd/${handle.fd}` : absolute),
      fs.promises.realpath(root)
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return reject("path-outside");
    if (code === "ENOENT" || code === "ENOTDIR") return reject("replaced");
    return reject("not-readable");
  }
  const actualBlocker = await readBlocker(real);
  if (actualBlocker) return reject(actualBlocker);
  if (realRoot !== path.resolve(root) || (real !== realRoot && !isWithin(real, realRoot))) {
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

export type WebftpKind = "file" | "directory" | "symlink" | "other";

export type WebftpEntry = {
  name: string;
  kind: WebftpKind;
  size: number;
  changedAt: number;
  uid: number;
  gid: number;
};
export { MAX_ENTRIES };

export type ListResult = {
  entries: WebftpEntry[];
  truncated: boolean;
};
export async function listDirectory(
  absolute: string,
  root: string
): Promise<{ ok: true; list: ListResult } | { ok: false; reason: OpenError }> {
  const opened = await openBelow(absolute, root, "directory");
  if (!opened.ok) return { ok: false, reason: opened.reason };

  try {
    const names = await fs.promises.readdir(process.platform === "linux" ? `/proc/self/fd/${opened.entry.handle.fd}` : opened.entry.real);
    const visible = names.filter((name) => !isBlockedName(name)).sort((a, b) => a.localeCompare(b, "de"));
    const truncated = visible.length > MAX_ENTRIES;

    const entries: WebftpEntry[] = [];
    for (const name of visible.slice(0, MAX_ENTRIES)) {
      if (await readBlocker(path.join(descriptorPath(opened.entry), name))) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(path.join(descriptorPath(opened.entry), name));
      } catch {
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
export type ShareDiagnostics = {
  readable: boolean;
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
export { MAX_TEXT_BYTES };

export type TextError = OpenError | "too-large" | "not-a-text-file";

export type TextResult =
  | { ok: true; content: string; hash: string; size: number }
  | { ok: false; reason: TextError };
export async function readTextFile(absolute: string, root: string): Promise<TextResult> {
  const opened = await openBelow(absolute, root, "file");
  if (!opened.ok) return { ok: false, reason: opened.reason };
  try {
    if (opened.entry.size > MAX_TEXT_BYTES) return { ok: false, reason: "too-large" };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of opened.entry.handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_TEXT_BYTES) return { ok: false, reason: "too-large" };
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.includes(0)) return { ok: false, reason: "not-a-text-file" };
    const content = buffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buffer)) return { ok: false, reason: "not-a-text-file" };
    return { ok: true, content: content, hash: hashOf(content), size: buffer.length };
  } catch {
    return { ok: false, reason: "not-readable" };
  } finally {
    await opened.entry.handle.close().catch(() => {});
  }
}

export type WriteError = OpenError | "no-write-permission" | "not-empty" | "already-exists";
async function prepare(absolute: string, root: string) {
  if (absolute === root) return { ok: false as const, reason: "path-blocked" as const };
  const protection = await fileWriteBlocker(absolute);
  if (protection) return { ok: false as const, reason: protection };
  const parent = await openBelow(path.dirname(absolute), root, "directory");
  if (!parent.ok) return parent;
  const leaf = path.join(descriptorPath(parent.entry), path.basename(absolute));
  try {
    const stat = await fs.promises.lstat(leaf);
    if (stat.isSymbolicLink()) { await parent.entry.handle.close(); return { ok: false as const, reason: "path-outside" as const }; }
    if (!stat.isFile() && !stat.isDirectory()) { await parent.entry.handle.close(); return { ok: false as const, reason: "wrong-kind" as const }; }
    return { ok: true as const, parent: parent.entry, leaf, stat };
  } catch (error) { await parent.entry.handle.close(); return { ok: false as const, reason: writeErrorFrom(error) }; }
}
function writeErrorFrom(error: unknown): WriteError {
  const code = (error as NodeJS.ErrnoException).code;
  return ["EACCES", "EPERM", "EROFS"].includes(code ?? "") ? "no-write-permission"
    : code === "EEXIST" ? "already-exists" : code === "ENOTEMPTY" ? "not-empty" : code === "ENOENT" ? "missing" : "not-readable";
}
export async function deleteEntry(absolute: string, root: string) {
  const prepared = await prepare(absolute, root);
  if (!prepared.ok) return prepared;
  try {
    const current = await fs.promises.lstat(prepared.leaf);
    if (current.ino !== prepared.stat.ino || current.dev !== prepared.stat.dev) return { ok: false as const, reason: "replaced" as const };
    if (prepared.stat.isFile()) await fs.promises.unlink(prepared.leaf); else await fs.promises.rmdir(prepared.leaf);
    return { ok: true as const, kind: prepared.stat.isFile() ? "file" as const : "directory" as const };
  } catch (error) { return { ok: false as const, reason: writeErrorFrom(error) }; }
  finally { await prepared.parent.handle.close().catch(() => {}); }
}
export async function renameEntry(absolute: string, newName: string, root: string) {
  const name = checkName(newName);
  if (!name.ok) return name;
  const prepared = await prepare(absolute, root);
  if (!prepared.ok) return prepared;
  const target = path.join(descriptorPath(prepared.parent), name.name);
  let reserved: fs.Stats | null = null;
  try {
    if (prepared.stat.isFile()) {
      // link is exclusive; it never replaces a concurrent destination.
      await fs.promises.link(prepared.leaf, target);
      const linked = await fs.promises.lstat(target);
      if (linked.ino !== prepared.stat.ino || linked.dev !== prepared.stat.dev) {
        await fs.promises.unlink(target);
        return { ok: false as const, reason: "replaced" as const };
      }
      await fs.promises.unlink(prepared.leaf);
    } else {
      // Reserve the directory name before renaming; existing targets fail.
      await fs.promises.mkdir(target, { mode: 0o700 });
      reserved = await fs.promises.lstat(target);
      const sourceNow = await fs.promises.lstat(prepared.leaf);
      const targetNow = await fs.promises.lstat(target);
      if (sourceNow.ino !== prepared.stat.ino || sourceNow.dev !== prepared.stat.dev) return { ok: false as const, reason: "replaced" as const };
      if (targetNow.ino !== reserved.ino || targetNow.dev !== reserved.dev) return { ok: false as const, reason: "already-exists" as const };
      await fs.promises.rename(prepared.leaf, target);
      reserved = null;
    }
    return { ok: true as const, newPath: path.join(prepared.parent.real, name.name) };
  } catch (error) { return { ok: false as const, reason: writeErrorFrom(error) }; }
  finally {
    if (reserved) {
      try {
        const current = await fs.promises.lstat(target);
        if (current.ino === reserved.ino && current.dev === reserved.dev) await fs.promises.rmdir(target);
      } catch { /* Only remove our own reservation. */ }
    }
    await prepared.parent.handle.close().catch(() => {});
  }
}


export type MountInfo = { Source?: string; Destination?: string; RW?: boolean };

export type ContainerPath =
  | { ok: true; absolutePath: string; writable: boolean }
  | { ok: false; reason: "not-mounted" };
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
