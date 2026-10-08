import { fileSourcePolicy } from "../runtime/file-sources.js";
import { protectionOf, definitionBlocked } from "../file-sources.js";
import { projectLockKey } from "../project-lock.js";
import {
  fileActionRequestSchema,
  fileTextWriteRequestSchema,
  fileUploadQuerySchema,
  MAX_UPLOAD_BYTES,
  shareQuerySchema
} from "contract";
import { queryObject } from "../request-keys.js";
import {
  normalizePath
} from "../hardening.js";
import {
  isInsideBase,
  type ComposeContext
} from "../compose.js";
import { forcedManagement } from "../stacks.js";
import {
  hashOf
} from "../compose-store.js";
import {
  EnvRedactionUnavailableError
} from "../env-file.js";
import {
  checkEntryPath,
  checkName
} from "../webftp.js";
import {
  requiredComposeContextForFileLogs
} from "../log-compose-context.js";
import { KeyedMutexBusyError } from "../concurrency.js";
import { stackLocks, registry, audit, engine } from "../runtime/state.js";
import { composeBasePath } from "../runtime/containers.js";
import { checkWebftpAccess, writeIntoShare } from "../runtime/access.js";
import {
  send as sendHttp,
  readJsonBody,
  parseRequest,
  rejectRequest,
  BodyTooLarge,
  readRawBody,
  ContainerRouteContext
} from "../runtime/http.js";
import { gate } from "../runtime/gate.js";
function send(response: ContainerRouteContext["response"], status: number, body: Record<string, unknown>): void {
  const aliases: Record<string, string> = { replaced: "file-replaced", "no-write-permission": "not-writable", missing: "not-readable", "not-empty": "already-exists" };
  const error = typeof body.error === "string" ? body.error.split(":")[0] : undefined;
  sendHttp(response, status, error === undefined ? body : { ...body, error: aliases[error] ?? error });
}
function validPath(ctx: ContainerRouteContext, value: string, action: string, name?: string): boolean {
  const entry = checkEntryPath(value, "/selected-source");
  const checked = entry.ok && name !== undefined ? checkName(name) : entry;
  if (checked.ok) return true;
  audit.write({ action, containerId: ctx.containerId, containerName: null, actor: ctx.actor, outcome: "denied", reason: checked.reason });
  send(ctx.response, 400, { error: checked.reason });
  return false;
}
export async function handleShareCandidates(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId } = ctx;
  const result = await gate(containerId, {
    mutating: false,
    action: "share-candidates",
    actor
  });
  if (!result.ok) {
    send(response, result.status, { error: result.reason });
    return;
  }

  let composeContext: ComposeContext;
  try {
    composeContext = requiredComposeContextForFileLogs(
      registry.get(containerId),
      result.inspect.Config?.Labels ?? undefined,
      composeBasePath
    );
  } catch (error) {
    if (error instanceof EnvRedactionUnavailableError) {
      send(response, 409, { error: "compose-registry-anchor-missing-or-different" });
      return;
    }
    throw error;
  }
  if (forcedManagement(composeContext.projectDir) === "read-only") {
    send(response, 403, { error: "self-management-locked" });
    return;
  }

  const root = normalizePath(composeContext.projectDir);
  const policy = await fileSourcePolicy();
  const candidates: Array<{ relative: string; destination: string; writable: boolean }> = [];
  for (const mount of result.inspect.Mounts ?? []) {
    if (mount.Type !== "bind" || !mount.Source || !mount.Destination) continue;
    const source = normalizePath(mount.Source);
    if (!isInsideBase(source, root)) continue;
    const protection = await protectionOf(source, policy);
    if (["backup", "agent", "unknown"].includes(protection) || await definitionBlocked(source, policy)) continue;
    let isDirectory: boolean;
    try {
      const stat = await engine.statArchive(containerId, mount.Destination);
      isDirectory = !!stat && (stat.mode & 0x80000000) !== 0 && !stat.linkTarget;
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    candidates.push({
      relative: source.slice(root.length + 1),
      destination: normalizePath(mount.Destination),
      writable: mount.RW !== false && protection === "none"
    });
  }
  candidates.sort((a, b) => a.relative.localeCompare(b.relative, "de"));

  send(response, 200, { candidates });
  return;
}
export async function handleFileList(ctx: ContainerRouteContext): Promise<void> {
  const { response, url, actor, containerId } = ctx;
  const query = parseRequest(shareQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "webftp-list", containerId, containerName: null }, query.rejection);
    return;
  }
  if (!validPath(ctx, query.value.path, "webftp-list")) return;
  const before = await checkWebftpAccess(containerId, {
    mutating: false,
    action: "webftp-read",
    actor,
    share: query.value.share,
    sourceId: query.value.sourceId
  });
  if (!before.ok) {
    audit.write({
      action: "webftp-list",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: before.reason
    });
    send(response, before.status, { error: before.reason });
    return;
  }

  const checked = checkEntryPath(
    query.value.path,
    before.shareAbsolute
  );
  if (!checked.ok) {
    audit.write({
      action: "webftp-list",
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: checked.reason
    });
    send(response, 400, { error: checked.reason });
    return;
  }

  const listing = await before.files.list(checked.absolute);
  if (!listing.ok) {
    audit.write({
      action: "webftp-list",
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: listing.reason
    });
    send(response, listing.reason === "not-readable" ? 404 : 400, { error: listing.reason });
    return;
  }


  audit.write({
    action: "webftp-list",
    containerId,
    containerName: before.containerName,
    actor,
    outcome: "allowed",
    reason: checked.relative || "."
  });
  send(response, 200, {
    share: before.shareRelative,
    path: checked.relative,
    entries: listing.list.entries,
    truncated: listing.list.truncated,
    diagnostics: { ...listing.diagnostics, uploadable: before.writable }
  });
  return;
}
async function handleFileUnlocked(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  const writing = request.method === "PUT";
  const auditAction = writing ? "webftp-upload" : "webftp-download";
  const query = parseRequest(fileUploadQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: auditAction, containerId, containerName: null }, query.rejection);
    return;
  }
  if (!validPath(ctx, query.value.path, auditAction, writing ? query.value.name : undefined)) return;
  const before = await checkWebftpAccess(containerId, {
    mutating: writing,
    action: writing ? "webftp-write" : "webftp-read",
    actor,
    share: query.value.share,
    sourceId: query.value.sourceId
  });
  if (!before.ok) {
    audit.write({
      action: auditAction,
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: before.reason
    });
    send(response, before.status, { error: before.reason });
    return;
  }

  const reject = (status: number, reason: string) => {
    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: reason
    });
    send(response, status, { error: reason });
  };

  if (!writing) {
    const checked = checkEntryPath(
      query.value.path,
      before.shareAbsolute
    );
    if (!checked.ok) return void reject(400, checked.reason);

    const loaded = await before.files.read(checked.absolute);
    if (!loaded.ok) return void reject(400, loaded.reason);
    audit.write({ action: auditAction, containerId, containerName: before.containerName, actor, outcome: "allowed", reason: checked.relative });
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(loaded.content.length), "cache-control": "no-store" });
    response.end(loaded.content);
    return;
  }

  const validatedDestination = checkEntryPath(
    query.value.path,
    before.shareAbsolute
  );
  if (!validatedDestination.ok) return void reject(400, validatedDestination.reason);
  const validatedName = checkName(query.value.name);
  if (!validatedName.ok) return void reject(400, validatedName.reason);

  let content: Buffer;
  try {
    content = await readRawBody(request, MAX_UPLOAD_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLarge) return void reject(413, "file-too-large");
    throw error;
  }

  const result = await writeIntoShare({
    files: before.files,
    targetDirectory: validatedDestination.absolute,
    name: validatedName.name,
    content: content
  });
  if (!result.ok) return void reject(result.status, result.reason);

  audit.write({
    action: auditAction,
    containerId,
    containerName: before.containerName,
    actor,
    outcome: "allowed",
    reason: `${[validatedDestination.relative, validatedName.name].filter(Boolean).join("/")} (${content.length} B, uid=${result.uid})`
  });
  send(response, 200, { ok: true, name: validatedName.name, size: content.length });
  return;
}
async function handleFileTextUnlocked(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  const writing = request.method === "PUT";
  const auditAction = writing ? "webftp-text-write" : "webftp-text-read";
  const query = parseRequest(shareQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: auditAction, containerId, containerName: null }, query.rejection);
    return;
  }
  if (!validPath(ctx, query.value.path, auditAction)) return;
  const before = await checkWebftpAccess(containerId, {
    mutating: writing,
    action: writing ? "webftp-write" : "webftp-read",
    actor,
    share: query.value.share,
    sourceId: query.value.sourceId
  });
  if (!before.ok) {
    audit.write({
      action: auditAction,
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: before.reason
    });
    send(response, before.status, { error: before.reason });
    return;
  }

  const reject = (status: number, reason: string) => {
    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: reason
    });
    send(response, status, { error: reason });
  };

  const checked = checkEntryPath(
    query.value.path,
    before.shareAbsolute
  );
  if (!checked.ok) return void reject(400, checked.reason);

  const loaded = await before.files.text(checked.absolute);

  if (!writing) {
    if (!loaded.ok) return void reject(loaded.reason === "not-readable" ? 404 : 400, loaded.reason);
    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "allowed",
      reason: `${checked.relative} (${loaded.size} B)`
    });
    send(response, 200, { path: checked.relative, content: loaded.content, hash: loaded.hash });
    return;
  }
  const write = parseRequest(fileTextWriteRequestSchema, await readJsonBody(request));
  if (!write.ok) {
    rejectRequest(
      ctx,
      { action: auditAction, containerId, containerName: before.containerName },
      write.rejection,
      write.rejection.error === "too-large" ? 413 : 400
    );
    return;
  }
  const { content: newContent, expectedHash: expected } = write.value;
  if (newContent.includes("\0") || Buffer.from(newContent).toString("utf8") !== newContent) return void reject(400, "not-a-text-file");
  if (!loaded.ok) return void reject(loaded.reason === "not-readable" ? 404 : 400, loaded.reason);
  if (loaded.hash !== expected) {
    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: `file-changed-externally: ${checked.relative}`
    });
    send(response, 409, { error: "file-changed-externally", hash: loaded.hash });
    return;
  }
  const parts = (checked.relative || before.shareAbsolute.split("/").pop() || "").split("/");
  const validatedName = checkName(parts.pop() ?? "");
  if (!validatedName.ok) return void reject(400, validatedName.reason);
  const parentPath = checked.relative ? checkEntryPath(parts.join("/"), before.shareAbsolute) : { ok: true as const, absolute: before.shareAbsolute.slice(0, before.shareAbsolute.lastIndexOf("/")) };
  if (!parentPath.ok) return void reject(400, parentPath.reason);
  const result = await writeIntoShare({
    files: before.files,
    targetDirectory: parentPath.absolute,
    name: validatedName.name,
    content: Buffer.from(newContent, "utf8"),
    expectedHash: expected
  });
  if (!result.ok) {
    if (result.hash) { send(response, 409, { error: result.reason, hash: result.hash }); return; }
    return void reject(result.status, result.reason);
  }

  audit.write({
    action: auditAction,
    containerId,
    containerName: before.containerName,
    actor,
    outcome: "allowed",
    reason: `${checked.relative} (${Buffer.byteLength(newContent, "utf8")} B)`
  });
  send(response, 200, { ok: true, hash: hashOf(newContent) });
  return;
}
async function handleFileActionUnlocked(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  const query = parseRequest(shareQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "webftp-unknown", containerId, containerName: null }, query.rejection);
    return;
  }
  const parsedBody = parseRequest(fileActionRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "webftp-unknown", containerId, containerName: null }, parsedBody.rejection);
    return;
  }
  const body = parsedBody.value;
  const fileAction = body.action;
  const auditAction = `webftp-${fileAction}`;
  if (!validPath(ctx, body.path, auditAction, body.action === "delete" ? undefined : body.name)) return;
  const before = await checkWebftpAccess(containerId, {
    mutating: true,
    action: "webftp-write",
    actor,
    share: query.value.share,
    sourceId: query.value.sourceId
  });
  if (!before.ok) {
    audit.write({
      action: auditAction,
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: before.reason
    });
    send(response, before.status, { error: before.reason });
    return;
  }

  const reject = (status: number, reason: string) => {
    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: reason
    });
    send(response, status, { error: reason });
  };
  const confirm = (reason: string) => {
    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "allowed",
      reason: reason
    });
  };
  const checked = checkEntryPath(body.path, before.shareAbsolute);
  if (!checked.ok) return void reject(400, checked.reason);

  if (body.action === "create-folder") {
    const validatedName = checkName(body.name);
    if (!validatedName.ok) return void reject(400, validatedName.reason);
    const result = await writeIntoShare({
      files: before.files,
      targetDirectory: checked.absolute,
        name: validatedName.name
    });
    if (!result.ok) return void reject(result.status, result.reason);
    confirm(`${[checked.relative, validatedName.name].filter(Boolean).join("/")} (uid=${result.uid})`);
    send(response, 200, { ok: true, name: validatedName.name });
    return;
  }

  if (body.action === "rename") {
    const name = checkName(body.name);
    if (!name.ok) return void reject(400, name.reason);
  }
  // Archive API has no rename/delete; arbitrary images have no trusted tools.
  reject(403, "not-writable");
}

async function withFileLock(ctx: ContainerRouteContext, operation: () => Promise<void>): Promise<void> {
  if (ctx.request.method === "GET") return operation();
  const anchor = registry.get(ctx.containerId)?.compose;
  const labelProject = anchor?.projectName ? null : (await engine.inspect(ctx.containerId)).Config?.Labels?.["com.docker.compose.project"];
  const key = projectLockKey({ registryProject: anchor?.projectName, labelProject, containerId: ctx.containerId });
  try { await stackLocks.runExclusive(key, operation); }
  catch (error) {
    if (!(error instanceof KeyedMutexBusyError)) throw error;
    send(ctx.response, 409, { error: "busy" });
  }
}
export async function handleFile(ctx: ContainerRouteContext): Promise<void> {
  return withFileLock(ctx, () => handleFileUnlocked(ctx));
}
export async function handleFileText(ctx: ContainerRouteContext): Promise<void> {
  return withFileLock(ctx, () => handleFileTextUnlocked(ctx));
}
export async function handleFileAction(ctx: ContainerRouteContext): Promise<void> {
  return withFileLock(ctx, () => handleFileActionUnlocked(ctx));
}
