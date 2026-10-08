import fs from "node:fs";
import path from "node:path";
import { MAX_ENTRIES, MAX_TEXT_BYTES } from "contract";
import { hashOf } from "./compose-store.js";
import { DescriptorError, descriptorFailure, hostBoundary, openDescriptor, verifyDescriptor } from "./file-descriptors.js";
import { checkName } from "./webftp.js";
import { FileArchive } from "./file-archive.js";
import type { SourcePolicy } from "./file-sources.js";

export class VisibleFiles {
  readonly scope;
  constructor(private readonly archive: FileArchive, readonly hostRoot: string, private readonly base: string,
    private readonly policy: SourcePolicy, private readonly writable: boolean) { this.scope = archive.scope; }
  async boundary(target: string, writing = false) { return this.archive.boundary(target, writing); }
  private async open(target: string, kind: "file" | "directory", writing = false) {
    const boundary = await this.boundary(target, writing);
    if (!boundary.ok) throw new DescriptorError(boundary.reason);
    if (writing && !this.writable) throw new DescriptorError("not-writable");
    return openDescriptor(this.hostRoot, this.base, path.posix.relative(this.scope.root, target), this.policy, kind, writing);
  }
  async download(target: string) {
    try {
      const file = await this.open(target, "file");
      const stream = file.stat.size ? file.handle.createReadStream({ autoClose: false, start: 0, end: file.stat.size - 1 }) : null;
      const cancel = async () => { stream?.destroy(); await file.handle.close(); };
      async function* bytes() {
        try {
          if (stream) for await (const chunk of stream) yield Buffer.from(chunk);
          await verifyDescriptor(file);
        } finally { await cancel(); }
      }
      return { ok: true as const, size: file.stat.size, stream: bytes(), cancel };
    } catch (error) { return descriptorFailure(error); }
  }
  async text(target: string) {
    const result = await this.download(target);
    if (!result.ok) return result;
    try {
      if (result.size > MAX_TEXT_BYTES) { await result.cancel(); throw new DescriptorError("too-large"); }
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.stream) {
        size += chunk.length;
        if (size > MAX_TEXT_BYTES) throw new DescriptorError("too-large");
        parts.push(chunk);
      }
      const bytes = Buffer.concat(parts);
      const content = bytes.toString("utf8");
      if (bytes.includes(0) || !Buffer.from(content).equals(bytes)) throw new DescriptorError("not-a-text-file");
      return { ok: true as const, content, hash: hashOf(content), size };
    } catch (error) { return descriptorFailure(error); }
  }
  async list(target: string) {
    let directory: Awaited<ReturnType<VisibleFiles["open"]>> | undefined;
    try {
      directory = await this.open(target, "directory");
      const entries = [];
      let truncated = false;
      const names = await fs.promises.opendir(directory.pinned);
      try {
        for await (const entry of names) {
          const boundary = await this.boundary(path.posix.join(target, entry.name));
          if (!boundary.ok) continue;
          try {
            await hostBoundary(this.hostRoot, this.base, path.posix.relative(this.scope.root, path.posix.join(target, entry.name)), this.policy);
            const stat = await fs.promises.lstat(path.join(directory.pinned, entry.name));
            entries.push({ name: entry.name, kind: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
              size: stat.isFile() ? stat.size : 0, uid: stat.uid, gid: stat.gid, changedAt: Math.floor(stat.mtimeMs / 1000) });
            if (entries.length === MAX_ENTRIES) { truncated = true; break; }
          } catch { /* Unreadable children do not grant access. */ }
        }
      } finally { await names.close().catch(() => {}); }
      await verifyDescriptor(directory);
      entries.sort((a, b) => a.name.localeCompare(b.name, "de"));
      let deletable = false;
      try { await fs.promises.access(directory.pinned, fs.constants.W_OK | fs.constants.X_OK); deletable = this.writable; } catch { /* Effective directory permissions apply. */ }
      return { ok: true as const, list: { entries, truncated }, diagnostics: { readable: true, deletable, uid: directory.stat.uid, gid: directory.stat.gid } };
    } catch (error) { return descriptorFailure(error); }
    finally { await directory?.handle.close(); }
  }
  async write(directory: string, name: string, content?: Buffer, expectedHash?: string) {
    const valid = checkName(name);
    if (!valid.ok) return { ok: false as const, reason: "path-blocked" as const };
    const target = path.posix.join(directory, valid.name);
    if (!expectedHash) {
      // New entries retain the original webftp daemon-based ownership inheritance.
      let parent: Awaited<ReturnType<VisibleFiles["open"]>> | undefined;
      try {
        parent = await this.open(directory, "directory", true);
        const boundary = await this.boundary(target, true);
        if (!boundary.ok) return boundary;
        await hostBoundary(this.hostRoot, this.base, path.posix.relative(this.scope.root, target), this.policy, true);
        try { await fs.promises.lstat(path.join(parent.pinned, valid.name)); return { ok: false as const, reason: "already-exists" as const }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await verifyDescriptor(parent);
        return await this.archive.create(directory, valid.name, parent.stat, content);
      } catch (error) { return descriptorFailure(error, true); }
      finally { await parent?.handle.close(); }
    }
    let file: Awaited<ReturnType<VisibleFiles["open"]>> | undefined;
    try {
      if (!content) throw new DescriptorError("wrong-kind");
      if (content.length > MAX_TEXT_BYTES) throw new DescriptorError("too-large");
      if (content.includes(0) || !Buffer.from(content.toString("utf8")).equals(content)) throw new DescriptorError("not-a-text-file");
      file = await this.open(target, "file", true);
      const chunks = [];
      let size = 0;
      const buffer = Buffer.alloc(65536);
      for (;;) {
        const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > MAX_TEXT_BYTES) throw new DescriptorError("too-large");
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const bytes = Buffer.concat(chunks);
      const actual = bytes.toString("utf8");
      if (bytes.includes(0) || !Buffer.from(actual).equals(bytes)) throw new DescriptorError("not-a-text-file");
      const hash = hashOf(actual);
      if (hash !== expectedHash) return { ok: false as const, reason: "file-changed-externally" as const, hash };
      await verifyDescriptor(file);
      await file.handle.truncate(0);
      let offset = 0;
      while (offset < content.length) {
        const { bytesWritten } = await file.handle.write(content, offset, content.length - offset, offset);
        if (!bytesWritten) throw new DescriptorError("not-writable");
        offset += bytesWritten;
      }
      await file.handle.sync();
      return { ok: true as const, uid: file.stat.uid };
    } catch (error) { return descriptorFailure(error, true); }
    finally { await file?.handle.close(); }
  }
}
