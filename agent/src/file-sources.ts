import path from "node:path";
import { createHash } from "node:crypto";
import type { FileAccessError, FileSource, MountSource } from "contract";
import { stopIntentTarget } from "./stop-intent.js";
import { isBlockedName } from "./file-names.js";
import type { RawInspect, RawVolume } from "./engine-model.js";

export type SourcePolicy = { socketPath: string; socketAliases?: readonly string[]; dockerRootDir?: string; dockerRootAliases?: readonly string[]; agentPaths: readonly string[]; backupDirectory: string; backupAliases?: readonly string[]; blockedFiles?: readonly string[] };
export type ResolvedFileSource = { source: FileSource; absolute: string | null };
const systemPaths = ["/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64"];
export function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function definitionBlocked(value: string, policy: SourcePolicy): Promise<boolean> {
  if (!policy) return true;
  return isBlockedName(path.basename(value)) || (policy.blockedFiles ?? []).some((file) => path.resolve(file) === path.resolve(value));
}
export async function protectionOf(value: string, policy: SourcePolicy, allocatedVolume = false): Promise<FileSource["protection"]> {
  if (!policy) return "unknown";
  const candidate = path.resolve(value);
  if ([policy.backupDirectory, ...(policy.backupAliases ?? [])].some((root) => within(candidate, root))) return "backup";
  if (policy.agentPaths.some((root) => within(candidate, root))) return "agent";
  const roots = [...systemPaths, "/root", policy.socketPath, ...(policy.socketAliases ?? []), ...(allocatedVolume ? [] : [policy.dockerRootDir ?? "/var/lib/docker", ...(policy.dockerRootAliases ?? [])])];
  if (roots.some((root) => within(candidate, root) || within(root, candidate))) return "system";
  if ([policy.backupDirectory, ...(policy.backupAliases ?? []), ...policy.agentPaths].some((root) => within(root, candidate))) return "system";
  return "none";
}
export function withMountAliases(policy: SourcePolicy, mounts: NonNullable<RawInspect["Mounts"]>, volumes: ReadonlyMap<string, RawVolume>): SourcePolicy {
  const result = { ...policy, agentPaths: [...policy.agentPaths], backupAliases: [...(policy.backupAliases ?? [])], socketAliases: [...(policy.socketAliases ?? [])], dockerRootAliases: [...(policy.dockerRootAliases ?? [])] };
  for (const mount of mounts) {
    if (!mount.Source || !mount.Destination) continue;
    const device = volumes.get(mount.Name ?? "")?.Options?.device;
    const sources = [mount.Source, ...(device?.startsWith("/") ? [device] : [])];
    for (const source of sources) {
      for (const [root, aliases] of [[policy.backupDirectory, result.backupAliases], [policy.socketPath, result.socketAliases], [policy.dockerRootDir, result.dockerRootAliases]] as const) {
        if (root && within(root, mount.Destination)) aliases.push(path.join(source, path.relative(mount.Destination, root)));
        if (root && within(root, source)) aliases.push(path.join(mount.Destination, path.relative(source, root)));
      }
      for (const root of policy.agentPaths) if (within(root, mount.Destination)) result.agentPaths.push(path.join(source, path.relative(mount.Destination, root)));
    }
  }
  return result;
}

export async function resolveFileSources(input: {
  containerId: string; inspect: RawInspect; definitions: readonly MountSource[];
  projectDir: string; shares: readonly string[]; containers: readonly RawInspect[] | null;
  volumes: ReadonlyMap<string, RawVolume>; policy: SourcePolicy; readOnly: boolean; writeBlocker?: FileAccessError | null;
}): Promise<ResolvedFileSource[]> {
  const service = input.inspect.Config?.Labels?.["com.docker.compose.service"] ?? "";
  const result: ResolvedFileSource[] = [];
  for (const mount of input.inspect.Mounts ?? []) {
    if (!mount.Destination || !["bind", "volume"].includes(mount.Type ?? "")) continue;
    const definition = input.definitions.find((source) => source.service === service && source.target === mount.Destination);
    const volume = mount.Type === "volume" && mount.Name ? input.volumes.get(mount.Name) : undefined;
    let absolute = mount.Source ? path.resolve(mount.Source) : null;
    const device = volume?.Options?.device;
    const allocatedVolume = mount.Type === "volume" && volume?.Driver === "local" && volume.Mountpoint === mount.Source && !!mount.Name;
    const paths = [mount.Source, device?.startsWith("/") ? device : undefined].filter((value): value is string => !!value);
    const protections = await Promise.all(paths.map((value) => protectionOf(value, input.policy, allocatedVolume && value === mount.Source)));
    let protection: FileSource["protection"] = protections.includes("backup") ? "backup" : protections.includes("agent") ? "agent"
      : protections.includes("system") ? "system" : (!absolute || !input.policy || (mount.Type === "volume" && (!volume || (volume.Driver !== "local" && !device?.startsWith("/"))))) ? "unknown" : "none";
    let ownership: FileSource["ownership"] = input.containers && definition ? "exclusive" : "unknown";
    if (definition && ((mount.Type === "bind" && definition.source !== mount.Source) || (mount.Type === "volume" && definition.source !== mount.Name))) ownership = "unknown";
    if (definition?.shared) ownership = "shared";
    if (absolute && input.containers) {
      for (const other of input.containers) {
        if (other.Id === input.containerId) continue;
        for (const used of other.Mounts ?? []) {
          if (used.Source) {
            const usedVolume = used.Name ? input.volumes.get(used.Name) : undefined;
            const usedPaths = [used.Source, usedVolume?.Options?.device?.startsWith("/") ? usedVolume.Options.device : undefined].filter((value): value is string => !!value);
            const sourcePaths = [absolute, device?.startsWith("/") ? path.resolve(device) : undefined].filter((value): value is string => !!value);
            for (const usedPath of usedPaths) {
              const real = path.resolve(usedPath);
              if (sourcePaths.some((source) => within(real, source) || within(source, real)) || (mount.Name && mount.Name === used.Name)) ownership = "shared";
            }
          }
        }
      }
    }
    const kind = mount.Type === "volume" ? "volume" : input.projectDir && within(mount.Source ?? "", input.projectDir) ? "project" : "external";
    let approved = kind !== "project" || input.shares.some((share) => within(absolute ?? "", path.join(input.projectDir, share)));
    if (!approved && absolute && kind === "project") {
      const shares = input.shares.map((share) => path.join(input.projectDir, share)).filter((share) => within(share, absolute!));
      if (shares.length === 1) {
        const clipped = path.resolve(shares[0]);
        if (within(clipped, absolute)) {
          absolute = clipped; approved = true;
          const clippedProtection = await protectionOf(absolute, input.policy);
          if (clippedProtection !== "none") protection = clippedProtection;
        }
      }
    }
    const blocked = absolute ? await definitionBlocked(absolute, input.policy) : false;
    const readable = !!absolute && !["backup", "agent", "unknown"].includes(protection) && approved && !blocked;
    const readOnly = mount.RW === false || definition?.readOnly === true;
    const writeBlocker: FileAccessError | null = blocked ? "path-blocked" : protection === "backup" ? "backup-directory-protected"
      : protection !== "none" ? "source-protected" : ownership === "shared" ? "source-shared"
        : ownership === "unknown" ? "source-ownership-unknown" : !approved ? "source-read-only"
          : input.writeBlocker ? input.writeBlocker : input.readOnly ? "agent-read-only" : readOnly ? "source-read-only" : !readable ? "not-readable" : null;
    const writable = writeBlocker === null;
    const estimatedBytes = null;
    result.push({ absolute, source: {
      service, kind, source: mount.Type === "volume" ? mount.Name ?? null : kind === "project" && absolute ? path.relative(input.projectDir, absolute) || "." : mount.Source ?? null,
      target: kind === "project" && absolute && mount.Source ? path.posix.join(mount.Destination, path.relative(path.resolve(mount.Source), absolute)) : mount.Destination, readOnly, shared: ownership === "shared", protection, ownership, readable, writable,
      writeBlocker: writeBlocker, estimatedBytes, backupEligible: protection === "none" && readable,
      restoreEligible: writable,
      sourceId: createHash("sha256").update(JSON.stringify([stopIntentTarget(input.inspect), mount.Type, mount.Type === "volume" ? mount.Name : mount.Source, mount.Destination, absolute])).digest("hex")
    } });
  }
  const expanded: ResolvedFileSource[] = [];
  for (const entry of result) {
    if (entry.source.kind !== "project" || !entry.absolute || entry.source.readable) { expanded.push(entry); continue; }
    const roots = input.shares.map((share) => path.join(input.projectDir, share)).filter((share) => within(share, entry.absolute!));
    if (roots.length < 2) { expanded.push(entry); continue; }
    for (const root of roots) {
      const absolute = path.resolve(root);
      const protection = within(absolute, entry.absolute) ? await protectionOf(absolute, input.policy) : "unknown";
      const readable = !["backup", "agent", "unknown"].includes(protection);
      const writeBlocker: FileAccessError | null = protection === "backup" ? "backup-directory-protected" : protection !== "none" ? "source-protected"
        : entry.source.ownership === "shared" ? "source-shared" : entry.source.ownership === "unknown" ? "source-ownership-unknown"
          : input.writeBlocker ? input.writeBlocker : input.readOnly ? "agent-read-only" : entry.source.readOnly ? "source-read-only" : !readable ? "not-readable" : null;
      expanded.push({ absolute, source: { ...entry.source, source: path.relative(input.projectDir, absolute), target: path.posix.join(entry.source.target, path.relative(entry.absolute, absolute)), protection, readable, writable: writeBlocker === null, writeBlocker,
        sourceId: createHash("sha256").update(entry.source.sourceId + absolute).digest("hex"),
        backupEligible: protection === "none" && readable, restoreEligible: writeBlocker === null } });
    }
  }
  return expanded;
}
export async function protectedWritableMount(mounts: NonNullable<RawInspect["Mounts"]>, policy: SourcePolicy,
  volumeRoots: readonly string[] = [], volumeDevices: ReadonlyMap<string, string> = new Map()): Promise<boolean> {
  for (const mount of mounts) {
    if (mount.RW === false) continue;
    if (!mount.Source) return true;
    const host = volumeDevices.get(mount.Name ?? "") ?? mount.Source;
    if (await definitionBlocked(host, policy) || await protectionOf(host, policy,
      mount.Type === "volume" && volumeRoots.includes(mount.Source)) !== "none") return true;
  }
  return false;
}
