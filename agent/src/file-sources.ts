import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileAccessError, FileSource, MountSource } from "contract";
import { isBlockedName } from "./file-names.js";
import type { RawInspect, RawVolume } from "./engine-model.js";

export type SourcePolicy = { socketPath: string; agentPaths: readonly string[]; backupDirectory: string; backupAliases?: readonly string[]; blockedFiles?: readonly string[] };
export type ResolvedFileSource = { source: FileSource; absolute: string | null };
const systemPaths = ["/etc", "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64"];
export function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function canonical(value: string): Promise<string> {
  try { return await fs.realpath(value); }
  catch {
    const parent = path.dirname(value);
    return parent === value ? value : path.join(await canonical(parent), path.basename(value));
  }
}
export async function definitionBlocked(value: string, policy: SourcePolicy): Promise<boolean> {
  if (isBlockedName(path.basename(value))) return true;
  const real = await canonical(value);
  return (await Promise.all((policy.blockedFiles ?? []).map(canonical))).includes(real);
}
export async function protectionOf(value: string, policy: SourcePolicy): Promise<FileSource["protection"]> {
  const candidates = [path.resolve(value), await canonical(value)];
  const backup = await Promise.all([policy.backupDirectory, ...(policy.backupAliases ?? [])].flatMap((root) => [Promise.resolve(path.resolve(root)), canonical(root)]));
  if (candidates.some((candidate) => backup.some((root) => within(candidate, root)))) return "backup";
  const agents = await Promise.all(policy.agentPaths.flatMap((root) => [Promise.resolve(path.resolve(root)), canonical(root)]));
  if (candidates.some((candidate) => agents.some((root) => within(candidate, root)))) return "agent";
  const socket = await canonical(policy.socketPath);
  if (candidates.some((candidate) => candidate === "/" || candidate === socket || candidate === policy.socketPath || systemPaths.some((root) => within(candidate, root)))) return "system";
  return "none";
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
    let absolute = mount.Source ? await canonical(mount.Source) : null;
    const device = volume?.Options?.device;
    const paths = [mount.Source, absolute, device?.startsWith("/") ? device : undefined].filter((value): value is string => !!value);
    const protections = await Promise.all(paths.map((value) => protectionOf(value, input.policy)));
    let protection: FileSource["protection"] = protections.includes("backup") ? "backup" : protections.includes("agent") ? "agent"
      : protections.includes("system") ? "system" : (!absolute || (mount.Type === "volume" && !volume)) ? "unknown" : "none";
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
            const sourcePaths = [absolute, device?.startsWith("/") ? await canonical(device) : undefined].filter((value): value is string => !!value);
            for (const usedPath of usedPaths) {
              const real = await canonical(usedPath);
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
        const clipped = await canonical(shares[0]);
        if (within(clipped, absolute)) {
          absolute = clipped; approved = true;
          const clippedProtection = await protectionOf(absolute, input.policy);
          if (clippedProtection !== "none") protection = clippedProtection;
        }
      }
    }
    const blocked = absolute ? await definitionBlocked(absolute, input.policy) : false;
    let readable = false;
    if (absolute && protection !== "backup" && protection !== "agent" && approved && !blocked) {
      try { const stat = await fs.stat(absolute); await fs.access(absolute, fs.constants.R_OK); readable = stat.isFile() || stat.isDirectory(); } catch { /* Unreadable sources remain visible. */ }
    }
    const readOnly = mount.RW === false || definition?.readOnly === true;
    const writeBlocker: FileAccessError | null = blocked ? "path-blocked" : protection === "backup" ? "backup-directory-protected"
      : protection !== "none" ? "source-protected" : ownership === "shared" ? "source-shared"
        : ownership === "unknown" ? "source-ownership-unknown" : !approved ? "source-read-only"
          : input.writeBlocker ? input.writeBlocker : input.readOnly ? "agent-read-only" : readOnly ? "source-read-only" : !readable ? "not-readable" : null;
    let permitted = true;
    if (absolute) { try { await fs.access(absolute, fs.constants.W_OK); } catch { permitted = false; } }
    const effectiveBlocker = writeBlocker ?? (permitted ? null : "not-writable");
    const writable = effectiveBlocker === null;
    let estimatedBytes: number | null = null;
    if (readable && absolute) {
      try { const stat = await fs.stat(absolute); if (stat.isFile()) estimatedBytes = stat.size; } catch { /* No estimate. */ }
    }
    result.push({ absolute, source: {
      service, kind, source: mount.Type === "volume" ? mount.Name ?? null : kind === "project" && absolute ? path.relative(input.projectDir, absolute) || "." : mount.Source ?? null,
      target: kind === "project" && absolute && mount.Source ? path.posix.join(mount.Destination, path.relative(await canonical(mount.Source), absolute)) : mount.Destination, readOnly, shared: ownership === "shared", protection, ownership, readable, writable,
      writeBlocker: effectiveBlocker, estimatedBytes, backupEligible: protection === "none" && readable,
      restoreEligible: writable,
      sourceId: createHash("sha256").update(JSON.stringify([input.containerId, mount.Type, mount.Source, mount.Name, mount.Destination, absolute])).digest("hex")
    } });
  }
  const expanded: ResolvedFileSource[] = [];
  for (const entry of result) {
    if (entry.source.kind !== "project" || !entry.absolute || entry.source.readable) { expanded.push(entry); continue; }
    const roots = input.shares.map((share) => path.join(input.projectDir, share)).filter((share) => within(share, entry.absolute!));
    if (roots.length < 2) { expanded.push(entry); continue; }
    for (const root of roots) {
      const absolute = await canonical(root);
      const protection = within(absolute, entry.absolute) ? await protectionOf(absolute, input.policy) : "unknown";
      let readable = false;
      try { await fs.access(absolute, fs.constants.R_OK); readable = protection !== "backup" && protection !== "agent" && protection !== "unknown"; } catch { /* Missing shares stay visible. */ }
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
