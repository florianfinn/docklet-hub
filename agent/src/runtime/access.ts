import { VisibleFiles } from "../visible-files.js";
import { protectionOf, within } from "../file-sources.js";
import {
  EngineError,
  type RawInspect
} from "../engine.js";
import {
  composeContextOf,
  type ComposeContext
} from "../compose.js";
import { forcedManagement } from "../stacks.js";
import {
  EnvRedactionUnavailableError
} from "../env-file.js";
import {
  containerPathFor,
  checkSharePath
} from "../webftp.js";
import { VisibleFileActions } from "../visible-file-actions.js";
import { FileArchive } from "../file-archive.js";
import {
  requiredComposeContextForFileLogs
} from "../log-compose-context.js";
import { engine, registry } from "./state.js";
import { composeBasePath } from "./containers.js";
import { rawOps } from "./raw-ops.js";
import { gate } from "./gate.js";
import { fileSources, fileSourcePolicy } from "./file-sources.js";
export type EnvPrecheck =
  | {
      ok: true;
      context: ComposeContext;
      containerName: string;
      inspect: RawInspect;
      serviceIds: Map<string, string>;
    }
  | { ok: false; status: number; body: Record<string, unknown>; reason: string };

export async function checkEnvAccess(containerId: string): Promise<EnvPrecheck> {
  if (!registry.isAllowed(containerId)) {
    return { ok: false, status: 404, body: { error: "not-allowlisted" }, reason: "not-allowlisted" };
  }

  let inspect: RawInspect;
  try {
    inspect = await engine.inspect(containerId);
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      return { ok: false, status: 404, body: { error: "container-gone" }, reason: "container-gone" };
    }
    throw error;
  }
  const context = composeContextOf(inspect.Config?.Labels ?? undefined, composeBasePath);
  if (!context) {
    return {
      ok: false,
      status: 409,
      body: { error: "no-compose-directory-in-base-path" },
      reason: "no-compose-directory-in-base-path"
    };
  }
  if (forcedManagement(context.projectDir) === "read-only") {
    return {
      ok: false,
      status: 403,
      body: { error: "self-management-locked", projectDir: context.projectDir },
      reason: `self-management-locked: ${context.projectDir}`
    };
  }

  const protection = await protectionOf(context.projectDir, await fileSourcePolicy());
  if (protection !== "none") return { ok: false, status: 403, body: { error: "source-protected" }, reason: "source-protected" };

  const serviceIds = await rawOps.containerIds({
    projectDir: context.projectDir,
    composeFileName: context.composeFileName
  });
  const notAllowlisted = [...serviceIds.entries()]
    .filter(([, id]) => !registry.isAllowed(id))
    .map(([serviceName]) => serviceName)
    .sort();
  if (notAllowlisted.length > 0) {
    return {
      ok: false,
      status: 403,
      body: { error: "stack-service-not-allowlisted", services: notAllowlisted },
      reason: `stack-service-not-allowlisted: ${notAllowlisted.join(",")}`
    };
  }

  return {
    ok: true,
    context,
    containerName: (inspect.Name ?? "").replace(/^\//, ""),
    inspect,
    serviceIds
  };
}

export type WebftpPrecheck =
  | {
      ok: true;
      inspect: RawInspect;
      containerName: string;
      projectDir: string;
      shareRelative: string;
      shareAbsolute: string;
      writable: boolean;
      uploadable: boolean;
      files: FileArchive | VisibleFiles;
      entryActions: VisibleFileActions;
    }
  | { ok: false; status: number; reason: string };
export async function checkWebftpAccess(
  containerId: string,
  options: {
    mutating: boolean;
    action: string;
    actor: string | null;
    share?: string | null;
    sourceId?: string | null;
  }
): Promise<WebftpPrecheck> {
  if (options.sourceId) {
    const sources = await fileSources(containerId, options.actor);
    if (!sources.ok) return sources;
    const selected = sources.resolved.find((item) => item.source.sourceId === options.sourceId);
    if (!selected?.absolute) return { ok: false, status: 404, reason: "source-unknown" };
    if (!selected.source.readable) return { ok: false, status: 403, reason: selected.source.writeBlocker ?? "not-readable" };
    if (options.mutating && !selected.source.writable) return { ok: false, status: 403, reason: selected.source.writeBlocker ?? "not-writable" };
    const fresh = await gate(containerId, { mutating: options.mutating, action: options.action, actor: options.actor });
    if (!fresh.ok) return fresh;
    if (JSON.stringify(fresh.inspect.Mounts) !== JSON.stringify(sources.inspect.Mounts))
      return { ok: false, status: 409, reason: "file-replaced" };
    const archive = new FileArchive(engine, { containerId, root: selected.source.target, hostRoot: selected.absolute, policy: sources.policy, mounts: fresh.inspect.Mounts ?? [], volumeRoots: sources.volumeRoots, volumeDevices: sources.volumeDevices });
    const visibleRoot = sources.visibleRoots.get(selected.source.sourceId);
    return { ok: true, inspect: fresh.inspect, containerName: (fresh.inspect.Name ?? "").replace(/^\//, ""),
      projectDir: sources.context?.projectDir ?? "", shareRelative: selected.source.sourceId, shareAbsolute: selected.source.target, writable: selected.source.writable, uploadable: selected.source.writable && (!!visibleRoot || !sources.archiveBlocked),
      entryActions: new VisibleFileActions(visibleRoot ?? selected.absolute, composeBasePath, sources.policy, !!visibleRoot && selected.source.writable),
      files: visibleRoot ? new VisibleFiles(archive, visibleRoot, composeBasePath, sources.policy, selected.source.writable) : archive };
  }
  const result = await gate(containerId, {
    mutating: options.mutating,
    action: options.action,
    actor: options.actor
  });
  if (!result.ok) return { ok: false, status: result.status, reason: result.reason };

  const containerName = (result.inspect.Name ?? "").replace(/^\//, "");

  let composeContext: ComposeContext;
  try {
    composeContext = requiredComposeContextForFileLogs(
      registry.get(containerId),
      result.inspect.Config?.Labels ?? undefined,
      composeBasePath
    );
  } catch (error) {
    if (error instanceof EnvRedactionUnavailableError) {
      return { ok: false, status: 409, reason: "compose-registry-anchor-missing-or-different" };
    }
    throw error;
  }

  if (forcedManagement(composeContext.projectDir) === "read-only") {
    return { ok: false, status: 403, reason: "self-management-locked" };
  }
  const known = registry.get(containerId)?.shares ?? [];
  if (known.length === 0) return { ok: false, status: 409, reason: "no-share" };

  const requested = (options.share ?? "").trim();
  const rawShare = requested
    ? known.find((pathname) => pathname === requested)
    : known.length === 1
      ? known[0]
      : undefined;
  if (!rawShare) {
    return requested
      ? { ok: false, status: 404, reason: "share-unknown" }
      : { ok: false, status: 400, reason: "share-missing" };
  }
  const share = checkSharePath(rawShare, composeContext.projectDir);
  if (!share.ok) return { ok: false, status: 409, reason: `invalid-share: ${share.reason}` };

  const sources = await fileSources(containerId, options.actor);
  if (!sources.ok) return sources;
  const selected = sources.resolved.filter((item) => item.absolute && (within(share.absolute, item.absolute) || within(item.absolute, share.absolute)));
  if (selected.some((item) => !item.source.readable || options.mutating && !item.source.writable)) {
    const denied = selected.find((item) => !item.source.readable || options.mutating && !item.source.writable)!;
    return { ok: false, status: 403, reason: denied.source.writeBlocker ?? "source-read-only" };
  }
  if (selected.length !== 1 || !selected[0].absolute) return { ok: false, status: 403, reason: "source-ownership-unknown" };
  const resolved = selected[0];
  const target = containerPathFor(share.absolute, sources.inspect.Mounts ?? []);
  if (!target.ok) return { ok: false, status: 409, reason: "not-mounted" };
  const archive = new FileArchive(engine, { containerId, root: target.absolutePath, hostRoot: share.absolute, policy: sources.policy, mounts: sources.inspect.Mounts ?? [], volumeRoots: sources.volumeRoots, volumeDevices: sources.volumeDevices });
  const visibleSource = sources.visibleRoots.get(resolved.source.sourceId);
  const visibleRoot = visibleSource ? `${visibleSource}${share.absolute.slice(resolved.absolute!.length)}` : undefined;
  return { ok: true, inspect: sources.inspect, containerName, projectDir: composeContext.projectDir,
    shareRelative: share.relative, shareAbsolute: target.absolutePath, writable: resolved.source.writable, uploadable: resolved.source.writable && (!!visibleRoot || !sources.archiveBlocked),
    entryActions: new VisibleFileActions(visibleRoot ?? share.absolute, composeBasePath, sources.policy, !!visibleRoot && resolved.source.writable),
    files: visibleRoot ? new VisibleFiles(archive, visibleRoot, composeBasePath, sources.policy, resolved.source.writable) : archive };
}

export type ShareWriteResult = { ok: true; uid: number } | { ok: false; status: number; reason: string; hash?: string };
export async function writeIntoShare(input: {
  files: FileArchive | VisibleFiles; targetDirectory: string; name: string; content?: Buffer; expectedHash?: string;
}): Promise<ShareWriteResult> {
  const result = await input.files.write(input.targetDirectory, input.name, input.content, input.expectedHash);
  return result.ok ? result : { ...result, status: result.reason === "file-changed-externally" || result.reason === "already-exists" ? 409 : 403 };
}
