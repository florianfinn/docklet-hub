import path from "node:path";
import { BACKUP_DIRECTORY_DEFAULT, BACKUP_DIRECTORY_ENV } from "contract";
import { within, resolveFileSources, type SourcePolicy } from "../file-sources.js";
import { mountSourcesOf } from "../mount-sources.js";
import { verifiedComposeContextForLogs } from "../log-compose-context.js";
import { forcedManagement } from "../stacks.js";
import { ownContainerId, config, engine, registry } from "./state.js";
import { composeBasePath } from "./containers.js";
import { rawOps } from "./raw-ops.js";
import { gate } from "./gate.js";
import { protectFilePaths } from "../webftp.js";

export async function fileSourcePolicy(): Promise<SourcePolicy> {
  const stateDirectory = path.dirname(config.registryFile);
  const backupDirectory = process.env[BACKUP_DIRECTORY_ENV]?.trim() || path.join(stateDirectory, BACKUP_DIRECTORY_DEFAULT);
  const backupAliases: string[] = [];
  const agentPaths = [...config.selfPaths, stateDirectory, path.dirname(config.auditFile), path.dirname(config.monitorFile)];
  const own = ownContainerId();
  if (own) {
    try {
      for (const mount of (await engine.inspect(own)).Mounts ?? []) {
        if (mount.Source && mount.Destination && within(backupDirectory, mount.Destination))
          backupAliases.push(path.join(mount.Source, path.relative(mount.Destination, backupDirectory)));
        if (mount.Source && mount.Destination) for (const protectedPath of [...agentPaths]) {
          if (within(protectedPath, mount.Destination)) agentPaths.push(path.join(mount.Source, path.relative(mount.Destination, protectedPath)));
        }
      }
    } catch { throw new Error("source-protection-unavailable"); }
  }
  return {
    backupAliases,
    blockedFiles: registry.knownIds().flatMap((id) => { const compose = registry.get(id)?.compose; return compose ? [path.join(compose.projectDir, compose.composeFileName)] : []; }),
    socketPath: config.socketPath,
    agentPaths,
    backupDirectory
  };
}
export async function fileSources(containerId: string, actor: string | null) {
  const gated = await gate(containerId, { mutating: false, action: "webftp-read", actor });
  if (!gated.ok) return gated;
  const entry = registry.get(containerId);
  const context = verifiedComposeContextForLogs(entry, gated.inspect.Config?.Labels ?? undefined, composeBasePath);
  if (forcedManagement(context?.projectDir ?? "") === "read-only") return { ok: false as const, status: 403, reason: "self-management-locked" };
  const policy = await fileSourcePolicy();
  protectFilePaths(policy);
  let definitions: ReturnType<typeof mountSourcesOf> = [];
  try { if (context) definitions = mountSourcesOf(await rawOps.config(context.projectDir, context.composeFileName, context.project), [context.serviceName], context.projectDir); }
  catch { /* A failed definition lookup never grants writing. */ }
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
  return { ok: true as const, resolved, inspect: gated.inspect, context };
}
