import { archiveEvents, type ArchiveStream } from "./archive-stream.js";
import path from "node:path";
import { MAX_ENTRIES, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, type FileAccessError } from "contract";
import { type ArchiveEntry } from "./archive-reader.js";
import { definitionBlocked, protectionOf, protectedWritableMount, within, type SourcePolicy } from "./file-sources.js";
import { checkEntryPath, checkName } from "./webftp.js";
import { hashOf } from "./compose-store.js";
import { tarWithOneEntry } from "./tar.js";
import type { RawInspect } from "./engine-model.js";

export type ArchiveStat = { name: string; size: number; mode: number; mtime: string; linkTarget: string };
export type ArchiveEngine = {
  statArchive(id: string, target: string): Promise<ArchiveStat | null>;
  openArchiveStream(id: string, target: string, signal?: AbortSignal): Promise<ArchiveStream>;
  getArchive(id: string, target: string, limit: number): Promise<Buffer>;
  putArchive(id: string, target: string, archive: Buffer): Promise<void>;
};
export type ArchiveScope = { containerId: string; root: string; hostRoot: string; policy: SourcePolicy; volumeRoots?: readonly string[]; volumeDevices?: ReadonlyMap<string, string>; mounts: NonNullable<RawInspect["Mounts"]> };
class AccessError extends Error { constructor(readonly reason: FileAccessError) { super(reason); } }
export type ArchiveFailure = { ok: false; reason: FileAccessError; hash?: string };
function failure(error: unknown): ArchiveFailure {
  return { ok: false, reason: error instanceof AccessError ? error.reason : "not-readable" };
}
export class FileArchive {
  constructor(private readonly engine: ArchiveEngine, readonly scope: ArchiveScope) {}
  private async checked(target: string, writing = false): Promise<void> {
    const { root, hostRoot, policy, mounts } = this.scope;
    if (!policy) throw new AccessError("source-protected");
    if (!within(target, root)) throw new AccessError("path-outside");
    const relative = path.posix.relative(root, target);
    const valid = checkEntryPath(relative, root);
    if (!valid.ok) throw new AccessError(valid.reason === "path-too-long" || valid.reason === "share-empty" ? "path-invalid-characters" : valid.reason);
    const selectedMount = mounts.find((mount) => mount.Source === hostRoot && within(root, mount.Destination ?? ""));
    const hostPaths = [{ host: path.posix.join(this.scope.volumeDevices?.get(selectedMount?.Name ?? "") ?? hostRoot, relative), allocated: selectedMount?.Type === "volume" && !!this.scope.volumeRoots?.includes(hostRoot) }];
    for (const mount of mounts) if (mount.Source && mount.Destination && within(target, mount.Destination)) {
      if (mount.Destination !== root && within(mount.Destination, root)) throw new AccessError("path-outside");
      hostPaths.push({ host: path.posix.join(this.scope.volumeDevices?.get(mount.Name ?? "") ?? mount.Source, path.posix.relative(mount.Destination, target)), allocated: mount.Type === "volume" && !!this.scope.volumeRoots?.includes(mount.Source) });
      if (writing && mount.RW === false) throw new AccessError("source-read-only");
    }
    for (const { host, allocated } of hostPaths) {
      if (await definitionBlocked(host, policy)) throw new AccessError("path-blocked");
      const protection = await protectionOf(host, policy, allocated);
      if (protection === "backup") throw new AccessError("backup-directory-protected");
      if (protection === "agent" || protection === "unknown" || (writing && protection !== "none")) throw new AccessError("source-protected");
    }
  }
  async boundary(target: string, writing = false): Promise<{ ok: true } | ArchiveFailure> {
    try { await this.checked(target, writing); return { ok: true }; } catch (error) { return failure(error); }
  }
  async stat(target: string, writing = false): Promise<ArchiveStat | null> {
    await this.checked(target, writing);
    // HEAD uses lstat; checking every component prevents known link escapes.
    const parts = target.split("/").filter(Boolean);
    let stat: ArchiveStat | null = null;
    for (let index = 0; index < parts.length; index++) {
      stat = await this.engine.statArchive(this.scope.containerId, "/" + parts.slice(0, index + 1).join("/"));
      if (!stat) {
        if (index === parts.length - 1) return null;
        throw new AccessError("not-readable");
      }
      if (stat.linkTarget || (stat.mode & 0x08000000) !== 0) throw new AccessError("path-outside");
      if (index < parts.length - 1 && (stat.mode & 0x80000000) === 0) throw new AccessError("wrong-kind");
    }
    return stat;
  }
  async download(target: string) {
    try {
      const stat = await this.stat(target);
      if (!stat) return { ok: false as const, reason: "not-readable" as const, missing: true };
      if ((stat.mode & 0x8f280000) !== 0) throw new AccessError("wrong-kind");
      const events = archiveEvents(await this.engine.openArchiveStream(this.scope.containerId, target));
      const first = await events.next();
      if (first.done || !("entry" in first.value) || first.value.entry.kind !== "file" || first.value.entry.name !== path.posix.basename(target) || first.value.entry.size !== stat.size) {
        await events.return(undefined);
        throw new AccessError("file-replaced");
      }
      const entry = first.value.entry;
      const verify = () => this.stat(target);
      async function* bytes() {
        try {
          for await (const event of events) {
            if ("entry" in event) throw new AccessError("file-replaced");
            yield event.data;
          }
          const after = await verify();
          if (!after || after.size !== entry.size || (after.mode & 0x8f280000) !== 0) throw new AccessError("file-replaced");
        } finally { await events.return(undefined); }
      }
      return { ok: true as const, size: entry.size, entry, stream: bytes(), cancel: () => events.return(undefined) };
    } catch (error) { return failure(error); }
  }
  async read(target: string, text = false): Promise<{ ok: true; content: Buffer; entry: ArchiveEntry } | ArchiveFailure> {
    const loaded = await this.download(target);
    if (!loaded.ok) return loaded;
    try {
      const parts: Buffer[] = [];
      let size = 0;
      if (loaded.size > (text ? MAX_TEXT_BYTES : MAX_UPLOAD_BYTES)) {
        await loaded.cancel();
        throw new AccessError("too-large");
      }
      for await (const data of loaded.stream) {
        size += data.length;
        if (size > (text ? MAX_TEXT_BYTES : MAX_UPLOAD_BYTES)) throw new AccessError("too-large");
        parts.push(data);
      }
      const content = Buffer.concat(parts);
      if (text && (content.includes(0) || !Buffer.from(content.toString("utf8")).equals(content))) throw new AccessError("not-a-text-file");
      return { ok: true, content, entry: loaded.entry };
    } catch (error) { return failure(error); }
  }
  async text(target: string) {
    const result = await this.read(target, true);
    return result.ok ? { ok: true as const, content: result.content.toString("utf8"), hash: hashOf(result.content.toString("utf8")), size: result.content.length } : result;
  }
  async list(target: string, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const visible = [];
    let root: ArchiveEntry | undefined;
    let truncated = false;
    try {
      const stat = await this.stat(target);
      if (!stat || (stat.mode & 0x80000000) === 0) throw new AccessError("wrong-kind");
      const prefix = path.posix.basename(target) + "/";
      let headers = 0;
      try {
        const stream = await this.engine.openArchiveStream(this.scope.containerId, target, controller.signal);
        for await (const event of archiveEvents(stream, false)) {
          if (!("entry" in event)) continue;
          const entry = event.entry;
          if (++headers > MAX_ENTRIES * 10) { truncated = true; break; }
          if (entry.name === path.posix.basename(target)) {
            if (entry.kind !== "directory" || root) throw new AccessError("file-replaced");
            root = entry;
            continue;
          }
          if (!entry.name.startsWith(prefix)) throw new AccessError("path-outside");
          const name = entry.name.slice(prefix.length);
          if (name.includes("/")) continue;
          try { await this.checked(path.posix.join(target, name)); } catch { continue; }
          visible.push({ name, kind: entry.kind, size: entry.kind === "file" ? entry.size : 0, changedAt: entry.changedAt, uid: entry.uid, gid: entry.gid });
          if (visible.length === MAX_ENTRIES) { truncated = true; break; }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        truncated = true;
      }
      if (!root) throw new AccessError("not-readable");
      const after = await this.stat(target);
      if (!after || (after.mode & 0x80000000) === 0) throw new AccessError("file-replaced");
      visible.sort((a, b) => a.name.localeCompare(b.name, "de"));
      return { ok: true as const, list: { entries: visible, truncated }, root, diagnostics: { readable: true, deletable: false, uid: root.uid, gid: root.gid } };
    } catch (error) { return failure(error); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async create(directory: string, name: string, owner: { uid: number; gid: number; mode: number }, content?: Buffer) {
    try {
      await this.checked(path.posix.join(directory, name), true);
      if (content && content.length > MAX_UPLOAD_BYTES) throw new AccessError("too-large");
      await this.engine.putArchive(this.scope.containerId, directory, tarWithOneEntry({ name, kind: content === undefined ? "directory" : "file", content,
        uid: owner.uid, gid: owner.gid, mode: owner.mode & (content === undefined ? 0o777 : 0o666) & ~0o002, mtime: Math.floor(Date.now() / 1000) }));
      return { ok: true as const, uid: owner.uid };
    } catch (error) { return error instanceof AccessError ? failure(error) : { ok: false as const, reason: "not-writable" as const }; }
  }
  async write(directory: string, name: string, content?: Buffer, expectedHash?: string) {
    try {
      if (await protectedWritableMount(this.scope.mounts, this.scope.policy, this.scope.volumeRoots, this.scope.volumeDevices)) throw new AccessError("source-protected");
      const rootStat = await this.stat(this.scope.root);
      if (rootStat && (rootStat.mode & 0x80000000) === 0) throw new AccessError("source-read-only");
      const valid = checkName(name);
      if (!valid.ok) throw new AccessError("path-blocked");
      const target = path.posix.join(directory, name);
      const current = await this.stat(target, true);
      let owner: ArchiveEntry;
      if (current) {
        if (!expectedHash) throw new AccessError("already-exists");
        const loaded = await this.read(target, true);
        if (!loaded.ok) return loaded;
        const hash = hashOf(loaded.content.toString("utf8"));
        if (hash !== expectedHash) return { ok: false as const, reason: "file-changed-externally" as const, hash };
        owner = loaded.entry;
      } else {
        if (expectedHash) throw new AccessError("file-replaced");
        const parent = await this.list(directory);
        if (!parent.ok) return parent;
        owner = parent.root;
      }
      if (expectedHash && content && (content.includes(0) || !Buffer.from(content.toString("utf8")).equals(content))) throw new AccessError("not-a-text-file");
      if (content && content.length > (expectedHash ? MAX_TEXT_BYTES : MAX_UPLOAD_BYTES)) throw new AccessError("too-large");
      const latest = await this.stat(target, true);
      if (!current && latest) throw new AccessError("already-exists");
      if (current && !latest) throw new AccessError("file-replaced");
      if (!current) return await this.create(directory, name, owner, content);
      await this.engine.putArchive(this.scope.containerId, directory, tarWithOneEntry({ name, kind: "file", content,
        uid: owner.uid, gid: owner.gid, mode: owner.mode, mtime: Math.floor(Date.now() / 1000) }));
      return { ok: true as const, uid: owner.uid };
    } catch (error) { return error instanceof AccessError ? failure(error) : { ok: false as const, reason: "not-writable" as const }; }
  }
}
