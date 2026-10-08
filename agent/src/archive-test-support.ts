import path from "node:path";
import { tarWithOneEntry, type TarEntry } from "./tar.js";
import { archiveEntries } from "./archive-reader.js";
import { type ArchiveEngine, type ArchiveStat, FileArchive } from "./file-archive.js";
import type { SourcePolicy } from "./file-sources.js";
export const archivePolicy: SourcePolicy = { socketPath: "/run/docker.sock", agentPaths: ["/agent-state"], backupDirectory: "/backup", dockerRootDir: "/var/lib/docker" };
export function archiveOf(entries: (TarEntry & { path?: string; linkTarget?: string })[]): Buffer {
  return Buffer.concat([...entries.map((entry) => {
    const tar = tarWithOneEntry({ ...entry, name: "entry" });
    tar.fill(0, 0, 100);
    tar.write(entry.path ?? entry.name, 0, 100, "utf8");
    if (entry.linkTarget) { tar.write("2", 156); tar.write(entry.linkTarget, 157, 100); }
    tar.fill(32, 148, 156);
    const sum = tar.subarray(0, 512).reduce((total, value) => total + value, 0);
    tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    return tar.subarray(0, tar.length - 1024);
  }), Buffer.alloc(1024)]);
}
export class MemoryArchive implements ArchiveEngine {
  entries = new Map<string, TarEntry & { linkTarget?: string }>();
  calls: { method: string; target: string; id: string }[] = [];
  lastWrite: Buffer | null = null;
  constructor() { this.directory("/data"); }
  directory(target: string, uid = 2100, gid = 2200, mode = 0o775) {
    for (const part of target.split("/").filter(Boolean).map((_, index, parts) => "/" + parts.slice(0, index + 1).join("/")))
      if (!this.entries.has(part)) this.entries.set(part, { name: path.posix.basename(part), kind: "directory", uid, gid, mode, mtime: 123 });
  }
  file(target: string, content: Buffer | string, uid = 3100, gid = 3200, mode = 0o640) {
    this.directory(path.posix.dirname(target));
    this.entries.set(target, { name: path.posix.basename(target), kind: "file", content: Buffer.from(content), uid, gid, mode, mtime: 123 });
  }
  async statArchive(id: string, target: string): Promise<ArchiveStat | null> {
    this.calls.push({ method: "HEAD", target, id });
    const entry = this.entries.get(target);
    return entry ? { name: entry.name, size: entry.content?.length ?? 0, mode: entry.linkTarget ? 0x08000000 : entry.kind === "directory" ? 0x80000000 : entry.mode, mtime: "2026-01-01T00:00:00Z", linkTarget: entry.linkTarget ?? "" } : null;
  }
  async getArchive(id: string, target: string, limit: number) {
    this.calls.push({ method: "GET", target, id });
    const entries = [...this.entries].filter(([name]) => name === target || name.startsWith(target + "/"));
    const tar = archiveOf(entries.map(([name, entry]) => ({ ...entry, path: path.posix.relative(path.posix.dirname(target), name) })));
    if (tar.length > limit) throw new Error("archive-limit");
    return tar;
  }
  async putArchive(id: string, target: string, archive: Buffer) {
    this.calls.push({ method: "PUT", target, id });
    this.lastWrite = archive;
    for (const entry of archiveEntries(archive)) this.entries.set(path.posix.join(target, entry.name), { ...entry, kind: entry.kind === "directory" ? "directory" : "file", mtime: entry.changedAt });
  }
}
export function archiveFixture(hostRoot = "/invisible/external") {
  const engine = new MemoryArchive();
  const scope = { containerId: "target", root: "/data", hostRoot, policy: archivePolicy, mounts: [{ Type: "bind", Source: hostRoot, Destination: "/data", RW: true }] };
  return { engine, scope, files: new FileArchive(engine, scope) };
}
