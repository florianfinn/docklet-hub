import { archiveRoot, rootMetadataMatches, withoutArchiveRoot } from "../restore-root-archive.js";
import { DataJournal } from "../data-journal.js";
import fs from "node:fs";
import path from "node:path";
import { BACKUP_DIRECTORY_DEFAULT, BACKUP_DIRECTORY_ENV, BACKUP_COPY_TIMEOUT_MS, UPDATE_STOP_TIMEOUT_MS,
  UPDATE_CREATE_TIMEOUT_MS, UPDATE_READBACK_TIMEOUT_MS, type BackupOptions, type FileSourceSelection,
  type StopIntentTarget } from "contract";
import { BackupStore } from "../backup-store.js";
import { archiveSize, safeBackupArchive, extractVisible, backupTarHeader, type SkippedEntry } from "../backup-archive.js";
import { RestorePathFailure, RestoreBindingFailure } from "../restore-metadata.js";
import { protectedWritableMount } from "../file-sources.js";
import { appendRecoveryIncident } from "../update-recovery.js";
import { FileArchive } from "../file-archive.js";
import { fileSources } from "./file-sources.js";
import { config, engine, stopIntents, selfHealingState, dockerEvents } from "./state.js";
import { composeBasePath } from "./containers.js";
import { UpdateBudget, UpdateFailure } from "../update-budget.js";
import type { RawInspect } from "../engine.js";
import { runtimeStateOf } from "../runtime-actions.js";

export const dataJournal = new DataJournal(path.join(path.dirname(config.registryFile), "data-pending.json"));
export const backupStore = new BackupStore(process.env[BACKUP_DIRECTORY_ENV]?.trim()
  || path.join(path.dirname(config.registryFile), BACKUP_DIRECTORY_DEFAULT));
export async function backupSources(id: string, actor: string | null, budget: UpdateBudget, estimate: boolean | readonly string[] = false) {
  const result = await budget.run(() => fileSources(id, actor));
  if (!result.ok) throw new UpdateFailure("source-protected");
  if (estimate) for (const item of result.resolved) {
    if (!item.source.backupEligible || Array.isArray(estimate) && !estimate.includes(item.source.sourceId)) continue;
    try { item.source.estimatedBytes = await budget.run(async ({ signal }) => archiveSize(await engine.openArchiveStream(id, item.source.target, signal))); }
    catch { item.source.estimatedBytes = null; }
  }
  return result;
}
export function archiveAccess(sources: Awaited<ReturnType<typeof backupSources>>, sourceId: string) {
  const item = sources.resolved.find((entry) => entry.source.sourceId === sourceId);
  if (!item?.absolute) throw new UpdateFailure("source-unknown");
  const files = new FileArchive(engine, { containerId: sources.inspect.Id, root: item.source.target, hostRoot: item.absolute,
    policy: sources.policy, mounts: sources.inspect.Mounts ?? [], volumeRoots: sources.volumeRoots, volumeDevices: sources.volumeDevices });
  return { item, files };
}
export async function stopForData(raw: RawInspect, budget: UpdateBudget) {
  if (raw.State?.Paused) await budget.run((options) => engine.pause(raw.Id, false, options), UPDATE_STOP_TIMEOUT_MS);
  if (raw.State?.Running || raw.State?.Restarting) await budget.run((options) => engine.stop(raw.Id, raw.Config?.StopTimeout, options), UPDATE_STOP_TIMEOUT_MS);
  const stopped = await budget.run((options) => engine.inspect(raw.Id, options), UPDATE_READBACK_TIMEOUT_MS);
  if (stopped.State?.Running || stopped.State?.Restarting || stopped.State?.Paused) throw new UpdateFailure("stop-failed");
}
export async function resumeAfterData(raw: RawInspect, budget: UpdateBudget) {
  let current = await budget.run((options) => engine.inspect(raw.Id, options), UPDATE_READBACK_TIMEOUT_MS);
  if (raw.State?.Running || raw.State?.Restarting || raw.State?.Paused) {
    if (!current.State?.Running && !current.State?.Restarting) await budget.run((options) => engine.start(raw.Id, options), UPDATE_CREATE_TIMEOUT_MS);
    if (raw.State?.Paused && !current.State?.Paused) await budget.run((options) => engine.pause(raw.Id, true, options), UPDATE_CREATE_TIMEOUT_MS);
  }
  current = await budget.run((options) => engine.inspect(raw.Id, options), UPDATE_READBACK_TIMEOUT_MS);
  const state = runtimeStateOf(current);
  if (raw.State?.Paused ? state.status !== "paused" : raw.State?.Running || raw.State?.Restarting
    ? !["running", "restarting"].includes(state.status) : ["running", "restarting", "paused"].includes(state.status)) throw new UpdateFailure("resume-failed");
  return current;
}
export async function copyBackup(raw: RawInspect, target: StopIntentTarget, options: BackupOptions,
  actor: string | null, budget: UpdateBudget, cancelled: () => boolean, preloaded?: Awaited<ReturnType<typeof backupSources>>) {
  const sources = preloaded ?? await backupSources(raw.Id, actor, budget, options.mounts.map((mount) => mount.sourceId));
  for (const selection of options.mounts) {
    const { item } = archiveAccess(sources, selection.sourceId);
    if (!item.source.backupEligible) throw new UpdateFailure("source-protected");
    if (item.source.estimatedBytes === null) throw new UpdateFailure("backup-size-unavailable");
    selection.estimatedBytes = item.source.estimatedBytes;
  }
  return budget.run(async ({ signal }) => backupStore.create(target, options, async (sourceId) => {
    if (cancelled()) throw new UpdateFailure("backup-copy-failed");
    const { item, files } = archiveAccess(sources, sourceId);
    files.scope.mounts = files.scope.mounts.map((mount) => ({ ...mount, RW: true }));
    const stream = await engine.openArchiveStream(raw.Id, item.source.target, signal);
    const skipped: SkippedEntry[] = [];
    return { target: item.source.target, skipped, stream: safeBackupArchive(stream, item.source.target, async (relative) => {
      if (cancelled()) throw new UpdateFailure("backup-copy-failed");
      return (await files.boundary(path.posix.join(item.source.target, relative), true)).ok;
    }, signal, () => { if (cancelled()) throw new UpdateFailure("backup-copy-failed"); }, skipped) };
  }, signal), BACKUP_COPY_TIMEOUT_MS);
}
export async function restoreArchives(sources: Awaited<ReturnType<typeof backupSources>>, target: StopIntentTarget,
  backupId: string, mounts: FileSourceSelection[], budget: UpdateBudget, validateOnly = false) {
  for (const mount of mounts) {
    const { item, files } = archiveAccess(sources, mount.sourceId);
    if (!item.source.restoreEligible) throw new UpdateFailure(item.source.writeBlocker === "source-shared" ? "source-shared" : "source-protected");
    const archive = await backupStore.archive(target, backupId, mount.sourceId);
    if (archive.archive.mountTarget !== item.source.target) throw new UpdateFailure("backup-mount-mismatch");
    // restoreBoundary asks Docker, whose per-container archive lock stalls while a PUT is open.
    const allowed = async (relative: string, remote = !sources.visibleRoots.has(mount.sourceId)) => {
      const absolute = path.posix.join(item.source.target, relative);
      if (!(await files.boundary(absolute, true)).ok) throw new UpdateFailure("restore-path-unsafe");
      if (remote) await files.restoreBoundary(absolute);
      return true;
    };
    await budget.run(async ({ signal }) => {
      try {
        const skipped: SkippedEntry[] = [];
        const visible = sources.visibleRoots.get(mount.sourceId);
        // Each pass reads the archive through its own descriptor; finishing a pass closes it.
        const open = async function* (check: (relative: string) => Promise<boolean>, omitLinks: boolean) {
          const handle = await fs.promises.open(archive.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { yield* safeBackupArchive(handle.createReadStream({ autoClose: false, signal }), item.source.target, check, signal, () => {}, skipped, true, omitLinks); }
          finally { await handle.close(); }
        };
        const stream = open(allowed, false);
        if (validateOnly) { for await (const chunk of stream) { void chunk; } }
        else {
          if (visible) await extractVisible(stream, visible, composeBasePath, sources.policy, item.source.target, signal, async (entry, _relative, body, verify) => {
            if (sources.archiveBlocked) throw new RestorePathFailure(entry.name);
            const basename = path.posix.basename(item.source.target);
            const relative = entry.name === basename ? "" : entry.name.slice(basename.length + 1);
            const absolute = path.posix.join(item.source.target, relative);
            await allowed(relative);
            await files.restoreBoundary(absolute);
            const fresh = await engine.inspect(sources.inspect.Id, { signal });
            if (await protectedWritableMount(fresh.Mounts ?? [], sources.policy, sources.volumeRoots, sources.volumeDevices)) throw new RestorePathFailure(entry.name);
            const put = async function* () {
              yield backupTarHeader({ ...entry, name: path.posix.basename(absolute) });
              if (body) for await (const chunk of body) yield chunk;
              yield Buffer.alloc((512 - entry.size % 512) % 512); yield Buffer.alloc(1024);
            };
            await verify?.();
            await engine.putArchiveStream(sources.inspect.Id, path.posix.dirname(absolute), put(), signal);
          });
          else {
            if (sources.archiveBlocked) throw new UpdateFailure("source-protected");
            const current = await archiveRoot(await engine.openArchiveStream(sources.inspect.Id, item.source.target, signal), item.source.target);
            const savedRoot = await archiveRoot(fs.createReadStream(archive.file, { signal }), item.source.target);
            if (!rootMetadataMatches(current, savedRoot)) throw new RestorePathFailure(item.source.target);
            const fresh = await engine.inspect(sources.inspect.Id, { signal });
            if (await protectedWritableMount(fresh.Mounts ?? [], sources.policy, sources.volumeRoots, sources.volumeDevices)) throw new RestorePathFailure(item.source.target);
            await files.restoreBoundary(item.source.target);
            // Every Docker-side path check runs before the PUT; the streamed pass only repeats the local ones.
            for await (const chunk of stream) { void chunk; }
            await engine.putArchiveStream(sources.inspect.Id, item.source.target,
              withoutArchiveRoot(open((relative) => allowed(relative, false), true), item.source.target, current), signal);
            const after = await archiveRoot(await engine.openArchiveStream(sources.inspect.Id, item.source.target, signal), item.source.target);
            if (!rootMetadataMatches(savedRoot, after)) throw new RestorePathFailure(item.source.target);
            await backupStore.recordRestoreSkipped(target, backupId, mount.sourceId, skipped);
          }
        }
      } catch (error) {
        if (error instanceof RestoreBindingFailure) {
          appendRecoveryIncident(selfHealingState, target, sources.inspect.Id, "restore-path-binding-changed");
          dockerEvents.notifyLifecycleChange(sources.inspect.Id);
        }
        if (error instanceof RestorePathFailure) await backupStore.recordRestoreFailure(target, backupId, mount.sourceId, error.relative);
        throw error;
      }
    }, BACKUP_COPY_TIMEOUT_MS);
  }
}
export const dataIntent = (raw: RawInspect) => stopIntents.beginUpdate([raw]);
