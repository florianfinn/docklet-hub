import fs from "node:fs/promises";
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
import { writePinned } from "../file-write.js";
import {
  requiredComposeContextForFileLogs
} from "../log-compose-context.js";
import { engine, registry } from "./state.js";
import { composeBasePath } from "./containers.js";
import { rawOps } from "./raw-ops.js";
import { gate } from "./gate.js";
import { fileSources, fileSourcePolicy } from "./file-sources.js";
import { protectFilePaths } from "../webftp.js";
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
  protectFilePaths(await fileSourcePolicy());
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
    return { ok: true, inspect: fresh.inspect, containerName: (fresh.inspect.Name ?? "").replace(/^\//, ""),
      projectDir: sources.context?.projectDir ?? "", shareRelative: selected.source.sourceId, shareAbsolute: selected.absolute, writable: selected.source.writable };
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
  if (options.mutating && selected.length === 0) return { ok: false, status: 403, reason: "source-ownership-unknown" };
  return {
    ok: true,
    inspect: sources.inspect,
    containerName,
    projectDir: composeContext.projectDir,
    shareRelative: share.relative,
    shareAbsolute: share.absolute,
    writable: selected.length > 0 && selected.every((item) => item.source.writable)
  };
}

export type ShareWriteResult = { ok: true; uid: number } | { ok: false; status: number; reason: string; hash?: string };
export async function writeIntoShare(input: {
  containerId: string;
  inspect: RawInspect;
  targetDirectory: string;
  shareAbsolute: string;
  name: string;
  content?: Buffer;
  expectedHash?: string;
}): Promise<ShareWriteResult> {
  const mounts = await Promise.all((input.inspect.Mounts ?? []).map(async (mount) => {
    if (!mount.Source) return mount;
    try { return { ...mount, Source: await fs.realpath(mount.Source) }; } catch { return mount; }
  }));
  const target = containerPathFor(input.shareAbsolute === `${input.targetDirectory}/${input.name}` ? input.shareAbsolute : input.targetDirectory, mounts);
  if (!target.ok) return { ok: false, status: 409, reason: "not-mounted" };
  if (!target.writable) return { ok: false, status: 403, reason: "source-read-only" };
  const result = await writePinned({ directory: input.targetDirectory, root: input.shareAbsolute,
    name: input.name, ...(input.content ? { content: input.content } : {}), ...(input.expectedHash ? { expectedHash: input.expectedHash } : {}) });
  return result.ok ? result : { ...result, status: result.reason === "file-changed-externally" || result.reason === "already-exists" ? 409 : 403 };
}
