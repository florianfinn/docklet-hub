import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BACKUP_DIRECTORY_MODE, BACKUP_ARCHIVE_MODE, BACKUP_RETENTION_COUNT, BACKUP_FREE_RESERVE_BYTES,
  backupEntrySchema, type BackupEntry, type BackupOptions, type StopIntentTarget } from "contract";
import type { ArchiveStream } from "./archive-stream.js";
import { UpdateFailure } from "./update-budget.js";

const key = (target: StopIntentTarget) => createHash("sha256").update(JSON.stringify(target)).digest("hex");
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
export class BackupStore {
  constructor(readonly directory: string, private readonly free = async (directory: string) => {
    const stat = await fs.promises.statfs(directory, { bigint: true }); return stat.bavail * stat.bsize;
  }) {}
  private async root(target: StopIntentTarget) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
    await fs.promises.chmod(this.directory, BACKUP_DIRECTORY_MODE);
    const root = path.join(this.directory, key(target));
    await fs.promises.mkdir(root, { recursive: true, mode: BACKUP_DIRECTORY_MODE });
    await fs.promises.chmod(root, BACKUP_DIRECTORY_MODE);
    return root;
  }
  async list(target: StopIntentTarget): Promise<BackupEntry[]> {
    const root = await this.root(target); const entries: BackupEntry[] = [];
    for (const id of await fs.promises.readdir(root)) {
      if (!validId(id)) continue;
      try {
        if (!(await fs.promises.lstat(path.join(root, id))).isDirectory()
          || !(await fs.promises.lstat(path.join(root, id, "metadata.json"))).isFile()) continue;
        const entry = backupEntrySchema.parse(JSON.parse(await fs.promises.readFile(path.join(root, id, "metadata.json"), "utf8")));
        if (entry.backupId !== id || key(entry.target) !== key(target)) continue;
        for (const archive of entry.archives) {
          if (!validId(archive.archiveId)) throw new Error("invalid-archive");
          const stat = await fs.promises.lstat(path.join(root, id, `${archive.archiveId}.tar`));
          if (!stat.isFile() || stat.size !== archive.bytes) throw new Error("incomplete-archive");
        }
        entries.push(entry);
      } catch { /* Incomplete runs never enter retention or restore selection. */ }
    }
    return entries.sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, BACKUP_RETENTION_COUNT);
  }
  async archive(target: StopIntentTarget, backupId: string, sourceId: string) {
    const entry = (await this.list(target)).find((item) => item.backupId === backupId);
    if (!entry) throw new UpdateFailure("backup-unknown");
    const archive = entry.archives.find((item) => item.sourceId === sourceId);
    if (!archive) throw new UpdateFailure("backup-mount-mismatch");
    return { entry, archive, file: path.join(await this.root(target), backupId, `${archive.archiveId}.tar`) };
  }
  async checkSpace(target: StopIntentTarget, options: BackupOptions) {
    const root = await this.root(target);
    if (options.mounts.some((mount) => mount.estimatedBytes === null)) throw new UpdateFailure("backup-size-unavailable");
    const bytes = options.mounts.reduce((sum, mount) => sum + BigInt(mount.estimatedBytes!), 0n);
    if (await this.free(root) < bytes + BigInt(BACKUP_FREE_RESERVE_BYTES)) throw new UpdateFailure("backup-space-insufficient");
  }
  async create(target: StopIntentTarget, options: BackupOptions, copy: (sourceId: string) => Promise<{ target: string; stream: ArchiveStream }>, signal?: AbortSignal): Promise<BackupEntry> {
    const root = await this.root(target);
    await this.checkSpace(target, options);
    const backupId = randomUUID(); const temporary = path.join(root, `${backupId}.tmp`); const destination = path.join(root, backupId);
    await fs.promises.mkdir(temporary, { mode: BACKUP_DIRECTORY_MODE });
    const archives: BackupEntry["archives"] = []; let committed = false;
    try {
      for (const mount of options.mounts) {
        signal?.throwIfAborted();
        const archiveId = randomUUID(); const loaded = await copy(mount.sourceId);
        const file = await fs.promises.open(path.join(temporary, `${archiveId}.tar`), "wx", BACKUP_ARCHIVE_MODE);
        let written = 0;
        try {
          for await (const chunk of loaded.stream) {
            signal?.throwIfAborted();
            if (await this.free(root) < BigInt(chunk.length) + BigInt(BACKUP_FREE_RESERVE_BYTES)) throw new UpdateFailure("backup-space-insufficient");
            let offset = 0;
            while (offset < chunk.length) { const result = await file.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
            written += chunk.length;
          }
          await file.sync();
        } finally { await file.close(); }
        archives.push({ sourceId: mount.sourceId, mountTarget: loaded.target, archiveId, bytes: written });
      }
      signal?.throwIfAborted();
      await fs.promises.rename(temporary, destination);
      const entry: BackupEntry = { backupId, target, mode: options.mode, completedAt: new Date().toISOString(), archives };
      const metadata = path.join(destination, "metadata.tmp");
      await fs.promises.writeFile(metadata, JSON.stringify(backupEntrySchema.parse(entry)), { mode: BACKUP_ARCHIVE_MODE, flag: "wx" });
      await fs.promises.rename(metadata, path.join(destination, "metadata.json"));
      committed = true;
      const keep = new Set((await this.list(target)).map((item) => item.backupId));
      for (const id of await fs.promises.readdir(root)) if (validId(id) && !keep.has(id)) await fs.promises.rm(path.join(root, id), { recursive: true, force: true });
      return entry;
    } catch (error) {
      await fs.promises.rm(temporary, { recursive: true, force: true });
      if (!committed) await fs.promises.rm(destination, { recursive: true, force: true });
      if (error instanceof UpdateFailure) throw error;
      throw new UpdateFailure(signal?.aborted ? "backup-deadline-exceeded" : "backup-copy-failed");
    }
  }
}
