import path from "node:path";
import { MAX_ENTRIES, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, type FileAccessError } from "contract";
import { archiveEntries, type ArchiveEntry } from "./archive-reader.js";
import { definitionBlocked, protectionOf, within, type SourcePolicy } from "./file-sources.js";
import { checkEntryPath, checkName } from "./webftp.js";
import { hashOf } from "./compose-store.js";
import { tarWithOneEntry } from "./tar.js";
import type { RawInspect } from "./engine-model.js";

export type ArchiveStat = { name: string; size: number; mode: number; mtime: string; linkTarget: string };
export type ArchiveEngine = {
  statArchive(id: string, target: string): Promise<ArchiveStat | null>;
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
  private async entries(target: string, limit: number): Promise<ArchiveEntry[]> {
    return archiveEntries(await this.engine.getArchive(this.scope.containerId, target, limit));
  }
  async read(target: string, text = false): Promise<{ ok: true; content: Buffer; entry: ArchiveEntry } | ArchiveFailure> {
    try {
      const stat = await this.stat(target);
      if (!stat) throw new AccessError("not-readable");
      if ((stat.mode & 0x8f280000) !== 0) throw new AccessError("wrong-kind");
      const limit = text ? MAX_TEXT_BYTES : MAX_UPLOAD_BYTES;
      if (stat.size > limit) throw new AccessError("too-large");
      const entries = await this.entries(target, limit + 65536);
      const entry = entries[0];
      if (entries.length !== 1 || !entry || entry.kind !== "file" || entry.name !== path.posix.basename(target)) throw new AccessError("file-replaced");
      if (entry.size > limit) throw new AccessError("too-large");
      const after = await this.stat(target);
      if (!after || after.size !== entry.size || (after.mode & 0x8f280000) !== 0) throw new AccessError("file-replaced");
      if (text && (entry.content.includes(0) || !Buffer.from(entry.content.toString("utf8")).equals(entry.content))) throw new AccessError("not-a-text-file");
      return { ok: true, content: entry.content, entry };
    } catch (error) { return failure(error); }
  }
  async text(target: string) {
    const result = await this.read(target, true);
    return result.ok ? { ok: true as const, content: result.content.toString("utf8"), hash: hashOf(result.content.toString("utf8")), size: result.content.length } : result;
  }
  private async directoryBoundary(target: string): Promise<void> {
    await this.checked(target);
    const { policy, hostRoot, root, mounts } = this.scope;
    const mounted = mounts.find((mount) => mount.Source === hostRoot && within(root, mount.Destination ?? ""));
    const host = path.posix.join(this.scope.volumeDevices?.get(mounted?.Name ?? "") ?? hostRoot, path.posix.relative(root, target));
    // Recursive archives must never transport a known protected subtree.
    if ([policy.backupDirectory, ...(policy.backupAliases ?? [])].some((protectedRoot) => within(protectedRoot, host))) throw new AccessError("backup-directory-protected");
    if (policy.agentPaths.some((protectedRoot) => within(protectedRoot, host))) throw new AccessError("source-protected");
    if (mounts.some((mount) => mount.Destination && mount.Destination !== target && within(mount.Destination, target))) throw new AccessError("path-outside");
  }
  async list(target: string) {
    try {
      await this.directoryBoundary(target);
      const stat = await this.stat(target);
      if (!stat || (stat.mode & 0x80000000) === 0) throw new AccessError("wrong-kind");
      const entries = await this.entries(target, 16 * 1024 * 1024);
      const after = await this.stat(target);
      if (!after || (after.mode & 0x80000000) === 0) throw new AccessError("file-replaced");
      const prefix = path.posix.basename(target) + "/";
      const root = entries.find((entry) => entry.name === path.posix.basename(target));
      if (!root || root.kind !== "directory") throw new AccessError("file-replaced");
      const visible = [];
      for (const entry of entries) {
        if (!entry.name.startsWith(prefix)) continue;
        const name = entry.name.slice(prefix.length);
        if (name.includes("/")) continue;
        try { await this.checked(path.posix.join(target, name)); } catch { continue; }
        visible.push({ name, kind: entry.kind, size: entry.kind === "file" ? entry.size : 0, changedAt: entry.changedAt, uid: entry.uid, gid: entry.gid });
      }
      visible.sort((a, b) => a.name.localeCompare(b.name, "de"));
      return { ok: true as const, list: { entries: visible.slice(0, MAX_ENTRIES), truncated: visible.length > MAX_ENTRIES }, root, diagnostics: { readable: true, deletable: false, uid: root.uid, gid: root.gid } };
    } catch (error) { return failure(error); }
  }
  async write(directory: string, name: string, content?: Buffer, expectedHash?: string) {
    try {
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
      await this.engine.putArchive(this.scope.containerId, directory, tarWithOneEntry({ name, kind: content === undefined ? "directory" : "file", content,
        uid: owner.uid, gid: owner.gid, mode: current ? owner.mode : owner.mode & ~0o002, mtime: Math.floor(Date.now() / 1000) }));
      return { ok: true as const, uid: owner.uid };
    } catch (error) { return error instanceof AccessError ? failure(error) : { ok: false as const, reason: "not-writable" as const }; }
  }
}
