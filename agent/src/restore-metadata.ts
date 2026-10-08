import fs from "node:fs";
import path from "node:path";
import type { ArchiveEntry } from "./archive-reader.js";
import { verifyDescriptorPath, sameFile, type OpenDescriptor } from "./file-descriptors.js";
import { UpdateFailure } from "./update-budget.js";
import type { ArchiveStream } from "./archive-stream.js";

export class RestorePathFailure extends UpdateFailure {
  constructor(readonly relative: string) { super("restore-extract-failed"); }
}
export class RestoreBindingFailure extends RestorePathFailure {}
export type RestoreMetadataFallback = (entry: ArchiveEntry, relative: string, body?: ArchiveStream, verify?: () => Promise<void>) => Promise<void>;
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
  const leaf = path.join(parent.pinned, path.basename(relative || entry.name));
  let before: fs.Stats | undefined;
  try { before = await fs.promises.lstat(leaf); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (before && (entry.kind === "directory" ? !before.isDirectory() : !before.isFile())) throw new RestoreBindingFailure(relative);
  // Docker replaces regular files, so an existing inode cannot be preserved by this fallback.
  if (before?.isFile()) throw new RestorePathFailure(relative);
  const verify = async () => {
    try {
      await verifyDescriptorPath(parent);
      let current: fs.Stats | undefined;
      try { current = await fs.promises.lstat(leaf); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (before ? !current || !sameFile(before, current) || current.isSymbolicLink() : current !== undefined) throw new Error("leaf-replaced");
    } catch { throw new RestoreBindingFailure(relative); }
  };
  await verify();
  await fallback(entry, relative, body, verify);
  let handle: fs.promises.FileHandle | undefined;
  try {
    await verifyDescriptorPath(parent);
    // Linux O_PATH pins metadata even when restored ownership denies reading.
    handle = await fs.promises.open(leaf, 0x200000 | fs.constants.O_NOFOLLOW);
    const after = await handle.stat();
    if (before && !sameFile(before, after) || !sameFile(after, await fs.promises.lstat(leaf))
      || (entry.kind === "directory" ? !after.isDirectory() : !after.isFile())) throw new RestoreBindingFailure(relative);
    if (!metadataMatches(after, entry)) throw new RestorePathFailure(relative);
  } catch (error) {
    if (error instanceof RestorePathFailure) throw error;
    throw new RestoreBindingFailure(relative);
  } finally { await handle?.close(); }
}
