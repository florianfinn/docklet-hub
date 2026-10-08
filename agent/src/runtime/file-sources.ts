import { canonicalPolicy, visibleRootOf } from "../file-descriptors.js";
import path from "node:path";
import { FileArchive } from "../file-archive.js";
import { BACKUP_DIRECTORY_DEFAULT, BACKUP_DIRECTORY_ENV } from "contract";
import { withMountAliases, resolveFileSources, protectedWritableMount, protectionOf, within, type SourcePolicy } from "../file-sources.js";
import { mountSourcesOf } from "../mount-sources.js";
import { verifiedComposeContextForLogs } from "../log-compose-context.js";
import { forcedManagement } from "../stacks.js";
import { ownContainerId, config, engine, registry } from "./state.js";
import { composeBasePath } from "./containers.js";
import { rawOps } from "./raw-ops.js";
import { gate } from "./gate.js";

export async function fileSourcePolicy(): Promise<SourcePolicy> {
  const stateDirectory = path.dirname(config.registryFile);
  const backupDirectory = process.env[BACKUP_DIRECTORY_ENV]?.trim() || path.join(stateDirectory, BACKUP_DIRECTORY_DEFAULT);
  const dockerRootDir = (await engine.info()).DockerRootDir;
  if (!dockerRootDir?.startsWith("/")) throw new Error("source-protection-unavailable");
  const policy: SourcePolicy = {
    dockerRootDir, socketPath: config.socketPath, backupDirectory,
    agentPaths: [...config.selfPaths, stateDirectory, path.dirname(config.auditFile), path.dirname(config.monitorFile)],
    blockedFiles: registry.knownIds().flatMap((id) => { const compose = registry.get(id)?.compose; return compose ? [path.join(compose.projectDir, compose.composeFileName)] : []; })
  };
  const own = ownContainerId();
  if (!own) return canonicalPolicy(policy);
  const mounts = (await engine.inspect(own)).Mounts ?? [];
  const volumes = new Map();
  for (const mount of mounts) if (mount.Type === "volume" && mount.Name) {
    const volume = await engine.inspectVolume(mount.Name);
    if (!volume) throw new Error("source-protection-unavailable");
    volumes.set(mount.Name, volume);
  }
  return canonicalPolicy(withMountAliases(policy, mounts, volumes));
}

export async function fileSources(containerId: string, actor: string | null) {
  const gated = await gate(containerId, { mutating: false, action: "webftp-read", actor });
  if (!gated.ok) return gated;
  const entry = registry.get(containerId);
  const context = verifiedComposeContextForLogs(entry, gated.inspect.Config?.Labels ?? undefined, composeBasePath);
  if (forcedManagement(context?.projectDir ?? "") === "read-only") return { ok: false as const, status: 403, reason: "self-management-locked" };
  const policy = await fileSourcePolicy();
  let definitions: ReturnType<typeof mountSourcesOf> = [];
  try { if (context) definitions = mountSourcesOf(await rawOps.config(context.projectDir, context.composeFileName, context.project), [context.serviceName], context.projectDir); }
  catch { /* A failed definition lookup never grants writing. */ }
  if (!context && !gated.inspect.Config?.Labels?.["com.docker.compose.project"]) definitions = (gated.inspect.Mounts ?? [])
    .filter((mount) => mount.Destination && ["bind", "volume"].includes(mount.Type ?? ""))
    .map((mount) => ({ service: "", kind: mount.Type === "volume" ? "volume" : "external",
      source: mount.Type === "volume" ? mount.Name ?? null : mount.Source ?? null, target: mount.Destination!,
      readOnly: mount.RW === false, shared: false }));
  let containers = null;
  try { containers = await Promise.all((await engine.listContainerIds()).map((id) => engine.inspect(id))); }
  catch { /* Unknown users keep sources read-only. */ }
  const volumes = new Map();
  for (const mount of [gated.inspect, ...(containers ?? [])].flatMap((container) => container.Mounts ?? [])) {
    if (mount.Type !== "volume" || !mount.Name) continue;
    try { const volume = await engine.inspectVolume(mount.Name); if (volume) volumes.set(mount.Name, volume); }
    catch { /* Unknown volume drivers never grant writing. */ }
  }
  const resolved = await resolveFileSources({
    containerId, inspect: gated.inspect, definitions, projectDir: context?.projectDir ?? "",
    shares: entry?.shares ?? [], containers, volumes, policy,
    readOnly: config.readOnly, writeBlocker: entry?.observeOnly ? "source-read-only" : null
  });
  const volumeRoots = [...volumes.values()].filter((volume) => volume.Driver === "local" && !volume.Options?.device && volume.Mountpoint).map((volume) => volume.Mountpoint as string);
  const volumeDevices = new Map([...volumes.values()].filter((volume) => volume.Options?.device?.startsWith("/")).map((volume) => [volume.Name as string, volume.Options!.device]));
  const archiveBlocked = await protectedWritableMount(gated.inspect.Mounts ?? [], policy, volumeRoots, volumeDevices);
  const visibleRoots = new Map<string, string>();
  for (const item of resolved) {
    if (!item.source.readable || !item.absolute) continue;
    const visibleRoot = await visibleRootOf(item.absolute, composeBasePath);
    if (visibleRoot) {
      visibleRoots.set(item.source.sourceId, visibleRoot);
      const protection = await protectionOf(visibleRoot, policy);
      if (protection !== "none") Object.assign(item.source, { protection, writable: false, backupEligible: false, restoreEligible: false,
        readable: item.source.readable && !["backup", "agent", "unknown"].includes(protection), writeBlocker: protection === "backup" ? "backup-directory-protected" : "source-protected" });
      for (const other of containers ?? []) {
        if (other.Id === containerId) continue;
        for (const mount of other.Mounts ?? []) {
          if (!mount.Source) continue;
          const used = await visibleRootOf(mount.Source, composeBasePath);
          if (used && (within(visibleRoot, used) || within(used, visibleRoot))) Object.assign(item.source,
            { ownership: "shared", shared: true, writable: false, restoreEligible: false, writeBlocker: item.source.writeBlocker ?? "source-shared" });
        }
      }
      if (!item.source.readable) continue;
    }
    const files = new FileArchive(engine, { containerId, root: item.source.target, hostRoot: item.absolute, policy, mounts: gated.inspect.Mounts ?? [], volumeRoots, volumeDevices });
    try {
      const stat = await files.stat(item.source.target);
      if (!stat) throw new Error("not-readable");
      const singleFile = (stat.mode & 0x8f280000) === 0;
      if (singleFile) item.source.estimatedBytes = stat.size;
      if (!visibleRoot && item.source.writable && (archiveBlocked || singleFile)) Object.assign(item.source,
        { writable: false, restoreEligible: false, writeBlocker: archiveBlocked ? "source-protected" : "source-read-only" });
    } catch {
      Object.assign(item.source, { readable: false, writable: false, backupEligible: false, restoreEligible: false, writeBlocker: "not-readable" });
    }
  }
  return { ok: true as const, resolved, inspect: gated.inspect, context, policy, volumeRoots, volumeDevices, visibleRoots, archiveBlocked };
}
