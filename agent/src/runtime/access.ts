import fs from "node:fs";
import path from "node:path";
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
  openBelow,
  checkSharePath
} from "../webftp.js";
import { tarWithOneEntry, TarNameInvalid, TarNameTooLong } from "../tar.js";
import {
  requiredComposeContextForFileLogs
} from "../log-compose-context.js";
import { engine, registry } from "./state.js";
import { composeBasePath } from "./containers.js";
import { rawOps } from "./raw-ops.js";
import { gate } from "./gate.js";

// The shared precheck for everything attached to the `.env` of a Compose
// project (S5b, §16 — sweep added later in the security review).
//
// ⚠️ The sweep over ALL services is the core of this function.
//
// The `.env` belongs to the PROJECT, not to the anchor container: it feeds the
// `${VAR}` interpolation of the whole Compose file and, where `env_file` says
// so, the environment of every service in it. Without this sweep ONE
// allowlisted container would be enough to reach the secrets of all others in
// the same directory via the shared file — exactly the shift in granularity
// against which the raw editor (stage 7) carries the same check.
//
// The first draft of this stage only checked the anchor. That was noticed in
// the security review and is added here; the main API does the matching
// permission check per service (it knows the grants, the agent does not).
//
// ⚠️ A service that is in the file but never had a container cannot be
// checked here — there is no allowlist entry anything could be attached to.
// The same gap as with gateStackRaw and acceptable for the same reason:
// without a container there are no running secrets it contributes either.
export type EnvPrecheck =
  | {
      ok: true;
      context: ComposeContext;
      containerName: string;
      inspect: RawInspect;
      // Service -> full container id. Goes to the main API so it can map its
      // grants onto it.
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

  // The directory comes from the LABELS of the running container, never from
  // the request (security review 5c, finding 4).
  const context = composeContextOf(inspect.Config?.Labels ?? undefined, composeBasePath);
  if (!context) {
    return {
      ok: false,
      status: 409,
      body: { error: "no-compose-directory-in-base-path" },
      reason: "no-compose-directory-in-base-path"
    };
  }

  // ⚠️ The self-management lock applies here even when READING, unlike for
  // /hardening and /compose. The `.env` of the dashboard stack contains the DB
  // password, the session secret and the agent shared secret.
  if (forcedManagement(context.projectDir) === "read-only") {
    return {
      ok: false,
      status: 403,
      body: { error: "self-management-locked", projectDir: context.projectDir },
      reason: `self-management-locked: ${context.projectDir}`
    };
  }

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

// --- Web-FTP: resolving the share (S19 — K6, §5.3) --------------------------

export type WebftpPrecheck =
  | {
      ok: true;
      inspect: RawInspect;
      containerName: string;
      projectDir: string;
      // Relative to the project directory — what the UI shows.
      shareRelative: string;
      // Absolute on the host — what every path is checked against.
      shareAbsolute: string;
    }
  | { ok: false; status: number; reason: string };

// Four barriers, and each one on its own can stop everything:
//
//  1. `gate()` — kill switch, allowlist, fresh inspect and, for mutating
//     actions, the self-management lock.
//  2. The project directory comes from the labels AND must be confirmed by the
//     registry anchor (requiredComposeContextForFileLogs, the same fail-closed
//     rule as for the file logs). Without confirmation it would be a file
//     primitive into a foreign project.
//  3. The self-management lock — here also when READING, as for the `.env`
//     and the file logs. Under dashboard-repo/dashboard-state live the DB
//     password, the session secret and the audit records.
//  4. The share itself. It comes from the own registry copy, never from the
//     request, and without it there is no file access at all.
export async function checkWebftpAccess(
  containerId: string,
  options: {
    mutating: boolean;
    action: string;
    actor: string | null;
    // Which of the shared roots is meant. If it is missing and there is exactly
    // one, that one is taken; if there are several, it is a usage error.
    share?: string | null;
  }
): Promise<WebftpPrecheck> {
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
    // ⚠️ WITHOUT the path. The reason travels all the way into the user's HTTP
    // response — an absolute host path would be a map of the server there
    // (§16.3). The S8 log file route has always done it
    // this way: path into the audit, response without it.
    return { ok: false, status: 403, reason: "self-management-locked" };
  }

  // ⚠️ The list comes from the own registry copy, the REQUESTED entry from the
  // request. That does not contradict the S19 rule ("the root never comes from
  // the request"): the caller may only SELECT what the operator has shared — a
  // path that is not exactly in the list is rejected, not checked and then
  // used.
  const known = registry.get(containerId)?.shares ?? [];
  if (known.length === 0) return { ok: false, status: 409, reason: "no-share" };

  const requested = (options.share ?? "").trim();
  const rawShare = requested
    ? known.find((pathname) => pathname === requested)
    : known.length === 1
      ? known[0]
      : undefined;
  if (!rawShare) {
    // Two different cases, two different reasons: "you named none, but there
    // are several" is a usage question, "the named one does not exist" is a
    // rejection.
    return requested
      ? { ok: false, status: 404, reason: "share-unknown" }
      : { ok: false, status: 400, reason: "share-missing" };
  }

  // The STORED path is checked too, not only the entered one. It can only be
  // set via the internal management route, but it lives in a file the agent
  // reads at startup — and a guarantee that depends on the state of a file is
  // no guarantee.
  const share = checkSharePath(rawShare, composeContext.projectDir);
  if (!share.ok) return { ok: false, status: 409, reason: `invalid-share: ${share.reason}` };

  return {
    ok: true,
    inspect: result.inspect,
    containerName,
    projectDir: composeContext.projectDir,
    shareRelative: share.relative,
    shareAbsolute: share.absolute
  };
}

export type ShareWriteResult = { ok: true; uid: number } | { ok: false; status: number; reason: string };

// The write path of Web-FTP: a file or directory is created via
// `PUT /containers/{id}/archive` instead of via `fs.writeFile`.
//
// ⚠️ The security decision is NOT made here. By this point it has been made
// completely in the host path space: share from the own registry, traversal
// checked against it, target directory opened with O_NOFOLLOW and held
// against the share via realpath. What happens here is the translation of the
// same location into the container's language — and if it does not succeed,
// nothing is written. A fallback to direct file access would be a second
// interpretation of the same permission, and two interpretations are the
// place where traversal checks fail.
export async function writeIntoShare(input: {
  containerId: string;
  inspect: RawInspect;
  targetDirectory: string;
  shareAbsolute: string;
  name: string;
  // Without content a directory is created.
  content?: Buffer;
}): Promise<ShareWriteResult> {
  const directory = await openBelow(input.targetDirectory, input.shareAbsolute, "directory");
  if (!directory.ok) {
    return { ok: false, status: directory.reason === "missing" ? 404 : 400, reason: directory.reason };
  }
  await directory.entry.handle.close().catch(() => {});

  const destinationPath = path.join(directory.entry.real, input.name);
  // ⚠️ The daemon extracts INSIDE the container and follows symlinks while
  // doing so. An existing link at the destination would thus be the one way
  // to write past the host-side check — so it is rejected here, before the
  // archive is even created.
  let existing: fs.Stats | null = null;
  try {
    existing = await fs.promises.lstat(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, status: 400, reason: "not-readable" };
    }
  }
  if (existing?.isSymbolicLink()) return { ok: false, status: 409, reason: "target-is-symlink" };
  if (existing && !input.content) return { ok: false, status: 409, reason: "already-exists" };
  // A file may replace a file — that is the point of an upload — but never a
  // directory. `noOverwriteDirNonDir` tells the engine the same thing once
  // more; it is here so that the message is understandable.
  if (existing && input.content && !existing.isFile()) {
    return { ok: false, status: 409, reason: "target-not-a-file" };
  }

  const target = containerPathFor(directory.entry.real, input.inspect.Mounts ?? []);
  if (!target.ok) return { ok: false, status: 409, reason: "share-not-in-container" };
  if (!target.writable) return { ok: false, status: 409, reason: "mount-read-only" };

  // Ownership and permissions are INHERITED, not set.
  //
  //   * If an existing file is overwritten, it inherits from ITSELF. That is
  //     the case that matters for the editor and for re-uploading: a
  //     configuration file that suddenly belongs to another user after saving,
  //     or loses its execute bit, is broken.
  //   * If it is new, it inherits from the TARGET DIRECTORY — then it belongs
  //     to the same user as its neighbours. For a new file the execute bits
  //     are dropped: an uploaded save game is not a program.
  const uid = existing ? existing.uid : directory.entry.uid;
  const gid = existing ? existing.gid : directory.entry.gid;
  const mode = existing
    ? existing.mode & 0o7777
    : input.content
      ? directory.entry.mode & 0o666
      : directory.entry.mode & 0o777;

  let archive: Buffer;
  try {
    archive = tarWithOneEntry({
      name: input.name,
      kind: input.content ? "file" : "directory",
      ...(input.content ? { content: input.content } : {}),
      mode: mode,
      uid,
      gid,
      mtime: Math.floor(Date.now() / 1000)
    });
  } catch (error) {
    if (error instanceof TarNameTooLong) return { ok: false, status: 400, reason: "path-too-long" };
    // `checkName` should never let this through — if it does, it is exactly the
    // case the byte check in the tar header exists for, and it ends here
    // instead of at the daemon.
    if (error instanceof TarNameInvalid) return { ok: false, status: 400, reason: "path-invalid-characters" };
    throw error;
  }

  try {
    await engine.putArchive(input.containerId, target.absolutePath, archive);
  } catch (error) {
    // The engine message can contain paths and is therefore only logged, not
    // passed on (the same line as everywhere else here).
    console.error("[agent] webftp put-archive:", error);
    return { ok: false, status: 502, reason: "write-failed" };
  }

  return { ok: true, uid };
}
