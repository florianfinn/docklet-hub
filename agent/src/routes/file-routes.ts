import fs from "node:fs";
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
  renameEntry,
  containerPathFor,
  shareDiagnostics,
  readTextFile,
  listDirectory,
  deleteEntry,
  openBelow,
  checkEntryPath,
  checkName
} from "../webftp.js";
import {
  requiredComposeContextForFileLogs
} from "../log-compose-context.js";
import { registry, audit } from "../runtime/state.js";
import { composeBasePath } from "../runtime/containers.js";
import { checkWebftpAccess, writeIntoShare } from "../runtime/access.js";
import {
  send,
  readJsonBody,
  parseRequest,
  rejectRequest,
  BodyTooLarge,
  readRawBody,
  ContainerRouteContext
} from "../runtime/http.js";
import { gate } from "../runtime/gate.js";

// --- Share candidates: the mounts of this container (S20) ---------------
//
// The UI offers a container's bind mounts as shares that can be switched on
// individually, instead of making the operator type a path that is already in
// their Compose file anyway.
//
// ⚠️ This is an OFFER, not a share. This route only returns what would be
// eligible; enabling happens exclusively via the registry (and thus via a
// deliberate click, §5.3).
//
// Three filters, and each has a reason:
//   * ONLY bind mounts. A named volume cannot be listed (the engine has no
//     `ls`), so it would be an offer that leads nowhere.
//   * ONLY inside the project directory of THIS container. A mount can point
//     anywhere — `/var/run/docker.sock`, `/etc/localtime`, a neighbour's
//     directory. The root stays the same as for every other file route.
//   * ONLY directories. A file mount (nginx.conf) is not a directory one
//     could browse.
//
// The response reveals the structure of the project directory.
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
  const candidates: Array<{ relative: string; destination: string; writable: boolean }> = [];
  for (const mount of result.inspect.Mounts ?? []) {
    if (mount.Type !== "bind" || !mount.Source || !mount.Destination) continue;
    const source = normalizePath(mount.Source);
    if (!isInsideBase(source, root)) continue;
    let isDirectory: boolean;
    try {
      isDirectory = (await fs.promises.stat(source)).isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;
    candidates.push({
      // Only the RELATIVE path goes out — the absolute one reveals the
      // structure of the host (§16.3).
      relative: source.slice(root.length + 1),
      destination: normalizePath(mount.Destination),
      writable: mount.RW !== false
    });
  }
  candidates.sort((a, b) => a.relative.localeCompare(b.relative, "de"));

  send(response, 200, { candidates });
  return;
}

// --- Web-FTP in the share directory (S19 — K6, §5.3) --------------------
//
// Four routes, one pre-check (checkWebftpAccess) and two different paths into
// the file system. The second point is the one that needs explaining, so here
// it is once in full:
//
//   * READING goes via the HOST file system. That is the same path as for the
//     file logs (S8) with the same guarantees (O_NOFOLLOW, realpath against
//     the share, device/inode against TOCTOU) — and it also works for a
//     STOPPED container, which for a game server is half the point.
//
//   * WRITING goes via the DAEMON (put-archive) as soon as something is
//     CREATED — an uploaded file, a new folder. The reason is ownership: the
//     agent runs as `node` without CAP_CHOWN and could not hand a file over to
//     the service that is supposed to read it. The daemon runs as root and
//     sets uid/gid from the tar header — read off the TARGET DIRECTORY. In
//     detail in tar.ts.
//
//   * REMOVING and RENAMING go via the host file system again, because the
//     engine simply has no operation for them. That needs write permission on
//     the directory; where it is missing, the diagnostics in the listing say so
//     BEFOREHAND, instead of a delete failing afterwards.
//
// Listing the share (or a subdirectory in it).
export async function handleFileList(ctx: ContainerRouteContext): Promise<void> {
  const { response, url, actor, containerId } = ctx;
  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard sends
  // `share` and `path`; queryObject still accepts the legacy names. Without
  // them the access check would find no share, and every path would be the
  // root of the share. Goes away once a dashboard of this version or later
  // runs everywhere.
  const query = parseRequest(shareQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "webftp-list", containerId, containerName: null }, query.rejection);
    return;
  }
  const before = await checkWebftpAccess(containerId, {
    mutating: false,
    action: "webftp-read",
    actor,
    share: query.value.share
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

  const listing = await listDirectory(checked.absolute, before.shareAbsolute);
  if (!listing.ok) {
    audit.write({
      action: "webftp-list",
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "denied",
      reason: listing.reason
    });
    send(response, listing.reason === "missing" ? 404 : 400, { error: listing.reason });
    return;
  }

  const diagnostics = await shareDiagnostics(checked.absolute, before.shareAbsolute);
  // Can this directory be written to at all? The answer depends not on
  // permissions but on whether the container sees it — put-archive writes
  // into ITS file system, not the host's.
  const target = containerPathFor(checked.absolute, before.inspect.Mounts ?? []);

  audit.write({
    action: "webftp-list",
    containerId,
    containerName: before.containerName,
    actor,
    outcome: "allowed",
    reason: checked.relative || "."
  });

  // ⚠️ Only the RELATIVE path goes out. The absolute one reveals the
  // structure of the host, and this route is also open externally via grant —
  // the same line as for the log sources (§16.3).
  send(response, 200, {
    share: before.shareRelative,
    path: checked.relative,
    entries: listing.list.entries,
    truncated: listing.list.truncated,
    diagnostics: diagnostics.ok
      ? {
          readable: diagnostics.diagnostics.readable,
          deletable: diagnostics.diagnostics.deletable,
          uid: diagnostics.diagnostics.uid,
          gid: diagnostics.diagnostics.gid,
          // Uploading goes via the daemon and therefore does NOT depend on
          // the agent's permissions, only on whether the container has
          // mounted this directory writable.
          uploadable: target.ok && target.writable
        }
      : null
  });
  return;
}

// Download (GET) or upload (PUT) a file.
export async function handleFile(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  const writing = request.method === "PUT";
  const auditAction = writing ? "webftp-upload" : "webftp-download";
  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard sends
  // `share` and `path`; queryObject still accepts the legacy names. Without
  // them the access check would find no share, and every path would be the
  // root of the share. Goes away once a dashboard of this version or later
  // runs everywhere.
  const query = parseRequest(fileUploadQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: auditAction, containerId, containerName: null }, query.rejection);
    return;
  }
  const before = await checkWebftpAccess(containerId, {
    mutating: writing,
    action: writing ? "webftp-write" : "webftp-read",
    actor,
    share: query.value.share
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
    if (!checked.relative) return void reject(400, "path-traversal");

    const opened = await openBelow(checked.absolute, before.shareAbsolute, "file");
    if (!opened.ok) {
      return void reject(opened.reason === "missing" ? 404 : 400, opened.reason);
    }

    audit.write({
      action: auditAction,
      containerId,
      containerName: before.containerName,
      actor,
      outcome: "allowed",
      reason: `${checked.relative} (${opened.entry.size} B)`
    });

    // ⚠️ NO redaction. Unlike the log this is right here: a file is delivered
    // byte for byte, and a `••••` in the middle of a save game breaks it
    // instead of making it safe. The boundary is not the content but the
    // LOCATION — the share the operator chose, plus the block list for `.env`
    // and Compose files.
    const size = opened.entry.size;
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-store"
    });
    if (size === 0) {
      await opened.entry.handle.close().catch(() => {});
      response.end();
      return;
    }
    // ⚠️ Hard-limited to the measured size. A log file that keeps growing
    // during the download would otherwise deliver more bytes than
    // `content-length` announces — and that is not a cosmetic flaw but a broken
    // HTTP frame on which the next request on the same connection gets stuck.
    const stream = opened.entry.handle.createReadStream({
      autoClose: true,
      start: 0,
      end: size - 1
    });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return;
  }

  // --- Upload ----------------------------------------------------------
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
    containerId,
    inspect: before.inspect,
    targetDirectory: validatedDestination.absolute,
    shareAbsolute: before.shareAbsolute,
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

// Read (GET) and save (PUT) a text file in the editor.
//
// Separate from `file` although it is the same file: the editor delivers
// text plus hash and accepts text plus expected hash. That is the same
// mechanism as for the Compose and `.env` editor (§13.4) and for the same
// reason — the dashboard and the service in the container share the file, and
// overwriting blindly is the one error you no longer see afterwards.
export async function handleFileText(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  const writing = request.method === "PUT";
  const auditAction = writing ? "webftp-text-write" : "webftp-text-read";
  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard sends
  // `share` and `path`; queryObject still accepts the legacy names. Without
  // them the access check would find no share, and every path would be the
  // root of the share. Goes away once a dashboard of this version or later
  // runs everywhere.
  const query = parseRequest(shareQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: auditAction, containerId, containerName: null }, query.rejection);
    return;
  }
  const before = await checkWebftpAccess(containerId, {
    mutating: writing,
    action: writing ? "webftp-write" : "webftp-read",
    actor,
    share: query.value.share
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
  if (!checked.relative) return void reject(400, "path-traversal");

  const loaded = await readTextFile(checked.absolute, before.shareAbsolute);

  if (!writing) {
    if (!loaded.ok) return void reject(loaded.reason === "missing" ? 404 : 400, loaded.reason);
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

  // ⚠️ The expected hash is mandatory and has no "don't care" value —
  // the same rule as in compose-store.ts. An editor that may save without a
  // hash is an editor that silently discards other people's changes. The
  // schema refuses a missing one (`expected-hash-missing`), as it refuses a
  // missing content (`content-missing`) and one above MAX_TEXT_BYTES
  // (`413 too-large`).
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
  if (!loaded.ok) return void reject(loaded.reason === "missing" ? 404 : 400, loaded.reason);
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

  // Writing goes the same way as an upload: put-archive with inherited
  // ownership. Because the file exists, it inherits from itself — owner and
  // permissions stay as they were.
  const parts = checked.relative.split("/");
  // ⚠️ The derived name goes through THE SAME gate as an upload's. It does
  // come from an already checked path, but `checkEntryPath` splits on literal
  // slashes and thus judges something different from `checkName`, which
  // checks the name byte by byte (S19 security review). Two write entry points
  // with two different gates are the place where the next refactor slips.
  const validatedName = checkName(parts.pop() ?? "");
  if (!validatedName.ok) return void reject(400, validatedName.reason);
  // The target directory is derived from the same, already checked path and
  // sent through the same check once more — not built from a second value
  // supplied by the caller.
  const parentPath = checkEntryPath(parts.join("/"), before.shareAbsolute);
  if (!parentPath.ok) return void reject(400, parentPath.reason);
  const result = await writeIntoShare({
    containerId,
    inspect: before.inspect,
    targetDirectory: parentPath.absolute,
    shareAbsolute: before.shareAbsolute,
    name: validatedName.name,
    content: Buffer.from(newContent, "utf8")
  });
  if (!result.ok) return void reject(result.status, result.reason);

  audit.write({
    action: auditAction,
    containerId,
    containerName: before.containerName,
    actor,
    outcome: "allowed",
    // ⚠️ Only path and size — never the content. The audit log is
    // append-only; whatever is in it once stays (§16.4.4).
    reason: `${checked.relative} (${Buffer.byteLength(newContent, "utf8")} B)`
  });
  send(response, 200, { ok: true, hash: hashOf(newContent) });
  return;
}

// Create, rename, delete folders.
export async function handleFileAction(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard sends
  // `share` and `path`; queryObject still accepts the legacy names. Without
  // them the access check would find no share, and every path would be the
  // root of the share. Goes away once a dashboard of this version or later
  // runs everywhere.
  const query = parseRequest(shareQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "webftp-unknown", containerId, containerName: null }, query.rejection);
    return;
  }
  const before = await checkWebftpAccess(containerId, {
    mutating: true,
    action: "webftp-write",
    actor,
    share: query.value.share
  });
  // An unknown or missing action is refused here (`unknown-action`),
  // before the access check: there is nothing to check access for.
  const parsedBody = parseRequest(fileActionRequestSchema, await readJsonBody(request));
  if (!parsedBody.ok) {
    rejectRequest(ctx, { action: "webftp-unknown", containerId, containerName: null }, parsedBody.rejection);
    return;
  }
  const body = parsedBody.value;
  const fileAction = body.action;
  const auditAction = `webftp-${fileAction}`;
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

  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard
  // sends `{ action, path, name? }`. Without the legacy name every folder
  // operation would run on the empty path, i.e. on the SHARE ITSELF —
  // renaming and deleting would hit the root instead of the intended entry.
  // Goes away once a dashboard of this version or later runs everywhere.
  const checked = checkEntryPath(body.path, before.shareAbsolute);
  if (!checked.ok) return void reject(400, checked.reason);

  if (body.action === "create-folder") {
    const validatedName = checkName(body.name);
    if (!validatedName.ok) return void reject(400, validatedName.reason);
    const result = await writeIntoShare({
      containerId,
      inspect: before.inspect,
      targetDirectory: checked.absolute,
      shareAbsolute: before.shareAbsolute,
      name: validatedName.name
    });
    if (!result.ok) return void reject(result.status, result.reason);
    confirm(`${[checked.relative, validatedName.name].filter(Boolean).join("/")} (uid=${result.uid})`);
    send(response, 200, { ok: true, name: validatedName.name });
    return;
  }

  if (body.action === "rename") {
    if (!checked.relative) return void reject(400, "path-blocked");
    const validatedName = checkName(body.name);
    if (!validatedName.ok) return void reject(400, validatedName.reason);
    const result = await renameEntry(checked.absolute, validatedName.name, before.shareAbsolute);
    if (!result.ok) {
      return void reject(result.reason === "no-write-permission" ? 409 : 400, result.reason);
    }
    confirm(`${checked.relative} -> ${validatedName.name}`);
    send(response, 200, { ok: true, name: validatedName.name });
    return;
  }

  // "delete": the schema allows exactly the three actions.
  if (!checked.relative) return void reject(400, "path-blocked");
  const result = await deleteEntry(checked.absolute, before.shareAbsolute);
  if (!result.ok) {
    return void reject(result.reason === "no-write-permission" ? 409 : 400, result.reason);
  }
  confirm(`${checked.relative} (${result.kind})`);
  send(response, 200, { ok: true, kind: result.kind });
}
