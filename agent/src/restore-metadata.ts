import fs from "node:fs";
import path from "node:path";
import type { ArchiveEntry } from "./archive-reader.js";
import { verifyDescriptor, sameFile, type OpenDescriptor } from "./file-descriptors.js";
import { UpdateFailure } from "./update-budget.js";
import type { ArchiveStream } from "./archive-stream.js";

export class RestorePathFailure extends UpdateFailure {
  constructor(readonly relative: string) { super("restore-extract-failed"); }
}
export type RestoreMetadataFallback = (entry: ArchiveEntry, relative: string, body?: ArchiveStream) => Promise<void>;
export const permissionFailure = (error: unknown) => ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
export function metadataMatches(stat: fs.Stats, entry: ArchiveEntry) {
  return stat.uid === entry.uid && stat.gid === entry.gid && (stat.mode & 0o7777) === (entry.mode & 0o7777);
}
export async function applyRestoreMetadata(handle: fs.promises.FileHandle, entry: ArchiveEntry) {
  const stat = await handle.stat();
  if (stat.uid !== entry.uid || stat.gid !== entry.gid) await handle.chown(entry.uid, entry.gid);
  // chown can clear set-ID bits, so chmod must come last.
  await handle.chmod(entry.mode & 0o7777);
  if (!metadataMatches(await handle.stat(), entry)) throw new Error("restore-metadata-mismatch");
}
export async function putRestoreMetadata(parent: OpenDescriptor, entry: ArchiveEntry, relative: string,
  fallback?: RestoreMetadataFallback, body?: ArchiveStream) {
  if (!fallback) throw new RestorePathFailure(relative);
  await verifyDescriptor(parent);
  const leaf = path.join(parent.pinned, path.basename(relative || entry.name));
  let before: fs.Stats | undefined;
  try { before = await fs.promises.lstat(leaf); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (before && (entry.kind === "directory" ? !before.isDirectory() : !before.isFile())) throw new RestorePathFailure(relative);
  await fallback(entry, relative, body);
  await verifyDescriptor(parent);
  const after = await fs.promises.lstat(leaf);
  if (!metadataMatches(after, entry) || (entry.kind === "directory" ? !after.isDirectory() || before && !sameFile(before, after) : !after.isFile())) {
    throw new RestorePathFailure(relative);
  }
}
