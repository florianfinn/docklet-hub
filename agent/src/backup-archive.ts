import path from "node:path";
import fs from "node:fs";
import { archiveEvents, type ArchiveStream } from "./archive-stream.js";
import type { ArchiveEntry } from "./archive-reader.js";
import { tarHeader } from "./tar.js";
import { UpdateFailure } from "./update-budget.js";
import { hostBoundary, openDescriptor, verifyDescriptor } from "./file-descriptors.js";
import type { SourcePolicy } from "./file-sources.js";
import { hasPathControls } from "./webftp.js";
import { randomUUID } from "node:crypto";

function octal(value: number, length: number) {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length >= length) throw new UpdateFailure("restore-path-unsafe");
  return digits.padStart(length - 1, "0") + "\0";
}
export function backupTarHeader(entry: ArchiveEntry): Buffer {
  const header = tarHeader({ name: "entry", kind: entry.kind === "directory" ? "directory" : "file", mode: entry.mode,
    uid: entry.uid, gid: entry.gid, mtime: entry.changedAt });
  const parts = entry.name.split("/"); let name = parts.pop()!; let prefix = parts.join("/");
  while (Buffer.byteLength(prefix) > 155 && parts.length) { name = parts.pop()! + "/" + name; prefix = parts.join("/"); }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new UpdateFailure("restore-path-unsafe");
  header.fill(0, 0, 100); header.write(name, 0, 100);
  header.fill(0, 345, 500); header.write(prefix, 345, 155);
  header.write(octal(entry.size, 12), 124, 12);
  if (entry.kind === "symlink" || entry.tarType === "1") {

    header.write(entry.kind === "symlink" ? "2" : "1", 156);
    header.fill(0, 157, 257); header.write(entry.linkTarget, 157, 100);
  }
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
  if ((entry.kind === "symlink" || entry.tarType === "1") && Buffer.byteLength(entry.linkTarget) > 100) {
    const content = Buffer.from(entry.linkTarget + "\0");
    const extension = backupTarHeader({ ...entry, name: "././@LongLink", kind: "file", tarType: "K", size: content.length, linkTarget: "" });
    extension.write("K", 156); extension.fill(32, 148, 156);
    extension.write(extension.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    return Buffer.concat([extension, content, Buffer.alloc((512 - content.length % 512) % 512), header]);
  }
  return header;
}
export type SkippedEntry = { path: string; reason: string };
export function safeLinkTarget(relative: string, target: string): boolean {
  if (!target || path.posix.isAbsolute(target) || (target.includes("\\") || hasPathControls(target))) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  return resolved !== ".." && !resolved.startsWith("../");
}
// Bodies remain streamed; deferred link headers never carry file contents.
export async function* safeBackupArchive(input: ArchiveStream, root: string,
  allowed: (relative: string) => Promise<boolean>, signal?: AbortSignal, check = () => {},
  skipped: SkippedEntry[] = [], restoring = false, omitLinks = false): AsyncGenerator<Buffer> {
  let previous: ArchiveEntry | null = null; let include = false; let found = false;
  const basename = path.posix.basename(root);
  const links: { entry: ArchiveEntry; relative: string }[] = [];
  const names = new Set<string>(); const regular = new Set<string>();
  const finish = () => previous && include ? Buffer.alloc((512 - previous.size % 512) % 512) : Buffer.alloc(0);
  try {
    for await (const event of archiveEvents(input)) {
      signal?.throwIfAborted(); check();
      if ("entry" in event) {
        yield finish();
        const entry = event.entry;
        if (entry.name !== basename && !entry.name.startsWith(basename + "/")) throw new UpdateFailure("restore-path-unsafe");
        const relative = entry.name === basename ? "" : entry.name.slice(basename.length + 1);
        if (names.has(relative)) throw new UpdateFailure("restore-path-unsafe");
        names.add(relative); previous = entry; include = false;
        if (!await allowed(relative)) continue;
        if (entry.kind === "symlink" || entry.tarType === "1") {
          if (entry.size !== 0) throw new UpdateFailure("restore-path-unsafe");
          if (entry.kind === "symlink" && (!relative || !safeLinkTarget(relative, entry.linkTarget))) {
            if (restoring) throw new UpdateFailure("restore-path-unsafe");
            skipped.push({ path: relative, reason: path.posix.isAbsolute(entry.linkTarget) ? "absolute-link-target" : "link-target-outside" });
          } else links.push({ entry, relative });
          continue;
        }
        if (!["file", "directory"].includes(entry.kind)) {
          if (restoring) throw new UpdateFailure("restore-path-unsafe");
          skipped.push({ path: relative, reason: "special-file" }); continue;
        }
        if (entry.kind === "directory" && entry.size !== 0) throw new UpdateFailure("restore-path-unsafe");
        if (entry.kind === "file") regular.add(entry.name);
        include = true; yield backupTarHeader(entry); found = true;
      } else if (include) yield event.data;
    }
    yield finish();
    for (const { entry, relative } of links) {
      if ([...names].some((name) => name.startsWith(relative + "/"))) throw new UpdateFailure("restore-path-unsafe");
      if (entry.tarType === "1" && !regular.has(entry.linkTarget)) {
        if (restoring) throw new UpdateFailure("restore-path-unsafe");
        skipped.push({ path: relative, reason: "hardlink-outside-archive" }); continue;
      }
      if (omitLinks) { skipped.push({ path: relative, reason: "archive-put-link-unsupported" }); continue; }
      yield backupTarHeader(entry); found = true;
    }
    if (!found) throw new UpdateFailure("backup-copy-failed");
    yield Buffer.alloc(1024);
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    throw new UpdateFailure("restore-path-unsafe");
  }
}
export async function archiveSize(input: ArchiveStream): Promise<number> {
  let bytes = 1024;
  for await (const event of archiveEvents(input, false)) if ("entry" in event) {
    bytes += 512 + Math.ceil(event.entry.size / 512) * 512;
    if (!Number.isSafeInteger(bytes)) throw new UpdateFailure("backup-size-unavailable");
  }
  return bytes;
}
export async function extractVisible(input: ArchiveStream, root: string, base: string, policy: SourcePolicy, mountTarget: string, signal?: AbortSignal) {
  const basename = path.posix.basename(mountTarget);
  const links: { entry: ArchiveEntry; relative: string }[] = [];
  const names = new Set<string>();
  let file: fs.promises.FileHandle | null = null;
  let parent: Awaited<ReturnType<typeof openDescriptor>> | null = null;
  let temporary = ""; let destination = ""; let metadata: ArchiveEntry | null = null;
  const close = async () => {
    try {
      if (file && metadata) {
        await file.chmod(metadata.mode & 0o777);
        const current = await file.stat();
        if (current.uid !== metadata.uid || current.gid !== metadata.gid) await file.chown(metadata.uid, metadata.gid);
        await file.sync(); await file.close(); file = null;
        await verifyDescriptor(parent!);
        await fs.promises.rename(temporary, destination); temporary = "";
      }
    } finally { await file?.close(); file = null; await parent?.handle.close(); parent = null; }
  };
  try {
    for await (const event of archiveEvents(input)) {
      signal?.throwIfAborted();
      if ("data" in event) {
        if (!file) throw new UpdateFailure("restore-extract-failed");
        let offset = 0;
        while (offset < event.data.length) offset += (await file.write(event.data, offset, event.data.length - offset)).bytesWritten;
        continue;
      }
      await close();
      const entry = event.entry;
      if (entry.name !== basename && !entry.name.startsWith(basename + "/") || !["file", "directory", "symlink"].includes(entry.kind) && entry.tarType !== "1") throw new UpdateFailure("restore-path-unsafe");
      const relative = entry.name === basename ? "" : entry.name.slice(basename.length + 1);
      names.add(relative);
      if (entry.kind === "symlink" || entry.tarType === "1") {
        if (entry.size || !relative || entry.kind === "symlink" && !safeLinkTarget(relative, entry.linkTarget)) throw new UpdateFailure("restore-path-unsafe");
        links.push({ entry, relative }); continue;
      }
      if (entry.kind === "directory") {
        if (!relative) continue;
        parent = await openDescriptor(root, base, (path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative)), policy, "directory", true);
        try { await fs.promises.mkdir(path.join(parent.pinned, path.posix.basename(relative)), { mode: entry.mode & 0o777 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await parent.handle.close(); parent = null;
        const created = await openDescriptor(root, base, relative, policy, "directory", true); await created.handle.close();
      } else {
        const fileRoot = relative === "" ? path.dirname(root) : root;
        const fileRelative = relative || path.basename(root);
        await hostBoundary(fileRoot, base, fileRelative, policy, true);
        const checked = await openDescriptor(fileRoot, base, (path.dirname(fileRelative) === "." ? "" : path.dirname(fileRelative)), policy, "directory", true);
        parent = checked;
        destination = path.join(parent.pinned, path.basename(fileRelative));
        try {
          const existing = await fs.promises.lstat(destination);
          if (!existing.isFile()) throw new UpdateFailure("restore-path-unsafe");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        temporary = path.join(parent.pinned, `.restore-${randomUUID()}`);
        file = await fs.promises.open(temporary, "wx", 0o600); metadata = entry;
      }
    }
    await close();
    for (const { entry, relative } of links.sort((a, b) => Number(b.entry.tarType === "1") - Number(a.entry.tarType === "1"))) {
      signal?.throwIfAborted();
      if ([...names].some((name) => name.startsWith(relative + "/"))) throw new UpdateFailure("restore-path-unsafe");
      await hostBoundary(root, base, relative, policy, true);
      const directory = path.posix.dirname(relative);
      const descriptor = await openDescriptor(root, base, directory === "." ? "" : directory, policy, "directory", true);
      const temporaryLink = path.join(descriptor.pinned, `.restore-${randomUUID()}`);
      try {
        const dest = path.join(descriptor.pinned, path.posix.basename(relative));
        try {
          const stat = await fs.promises.lstat(dest);
          if (!stat.isFile() && !stat.isSymbolicLink()) throw new UpdateFailure("restore-path-unsafe");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (entry.tarType === "1") {
          if (!entry.linkTarget.startsWith(basename + "/")) throw new UpdateFailure("restore-path-unsafe");
          const source = await openDescriptor(root, base, entry.linkTarget.slice(basename.length + 1), policy, "file");
          try { await fs.promises.copyFile(source.pinned, temporaryLink, fs.constants.COPYFILE_EXCL); }
          finally { await source.handle.close(); }
        } else {
          await fs.promises.symlink(entry.linkTarget, temporaryLink);
          const stat = await fs.promises.lstat(temporaryLink);
          if (stat.uid !== entry.uid || stat.gid !== entry.gid) await fs.promises.lchown(temporaryLink, entry.uid, entry.gid);
        }
        await verifyDescriptor(descriptor);
        await fs.promises.rename(temporaryLink, dest);
      } finally { await fs.promises.rm(temporaryLink, { force: true }); await descriptor.handle.close(); }
    }
  } finally { await file?.close(); if (temporary) await fs.promises.rm(temporary, { force: true }); await parent?.handle.close(); }
}
