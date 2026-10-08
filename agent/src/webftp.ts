import { MAX_ENTRIES, MAX_TEXT_BYTES } from "contract";
import { isInsideBase } from "./compose.js";
import { normalizePath } from "./hardening.js";
import { isBlockedName } from "./file-names.js";
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
export function hasPathControls(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function checkName(rawName: string): { ok: true; name: string } | { ok: false; reason: WebftpPathError } {
  const name = rawName.trim();
  if (!name || name === "." || name === "..") return { ok: false, reason: "path-traversal" };
  if (name.startsWith("-")) return { ok: false, reason: "path-invalid-characters" };
  if (isBlockedName(name)) return { ok: false, reason: "path-blocked" };
  const bytes = Buffer.from(name, "utf8");
  if (bytes.includes(0x2f) || bytes.includes(0x5c) || bytes.includes(0x00)) {
    return { ok: false, reason: "path-invalid-characters" };
  }
  if (hasPathControls(name)) return { ok: false, reason: "path-invalid-characters" };
  if (bytes.length > MAX_NAME_CHARS) return { ok: false, reason: "path-too-long" };
  return { ok: true, name };
}

export type ShareValidation =
  | { ok: true; relative: string; absolute: string }
  | { ok: false; reason: WebftpPathError };
export function checkSharePath(relativeRaw: string, projectDir: string): ShareValidation {
  const relative = relativeRaw.trim().replace(/\/+$/, "");
  if (!relative) return { ok: false, reason: "share-empty" };
  if (hasPathControls(relative) || relative.includes("\\")) return { ok: false, reason: "path-invalid-characters" };
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
  const relative = relativeRaw;
  if (!relative) return { ok: true, relative: "", absolute: normalizePath(shareAbsolute) };
  if (hasPathControls(relative) || relative.includes("\\")) return { ok: false, reason: "path-invalid-characters" };
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

export { MAX_TEXT_BYTES };
