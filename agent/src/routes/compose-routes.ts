import { projectLockKey } from "../project-lock.js";
import { stackLocks } from "../runtime/state.js";
import { KeyedMutexBusyError } from "../concurrency.js";
import { composeSelectionRequestSchema, envQuerySchema, envWriteRequestSchema } from "contract";
import { queryObject } from "../request-keys.js";
import {
  EngineError
} from "../engine.js";
import {
  composeContextOf,
  composeContextFindingOf,
  isValidProjectName,
  specFromComposeConfig
} from "../compose.js";
import {
  composeConfig
} from "../compose-cli.js";
import {
  readComposeFile
} from "../compose-store.js";
import {
  envView,
  readEnvFile,
  writeEnvFile,
  type EnvChange
} from "../env-file.js";
import { derivedConfig } from "../derived-config.js";
import {
  splitEnvEntry
} from "../redact.js";
import { config, engine, registry, composeSelections, audit } from "../runtime/state.js";
import { composeBasePath, availableComposeCandidates } from "../runtime/containers.js";
import { checkEnvAccess } from "../runtime/access.js";
import { send, readJsonBody, parseRequest, rejectRequest, ContainerRouteContext } from "../runtime/http.js";
import { gate } from "../runtime/gate.js";
import { externallyManagedServices } from "../raw-ownership.js";

// --- Read the Compose file (stage 5c) ---------------------------------
//
// The way the spec is read back: not from the database but from the file.
// That way there is only ONE state, and the consequence deliberately accepted
// in 5b (env values in plain text in the app database) goes away.
//
// The file names host paths and env values in plain text.
export async function handleCompose(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId } = ctx;
  if (!registry.isAllowed(containerId)) {
    send(response, 404, { error: "not-allowlisted" });
    return;
  }

  let inspect;
  try {
    inspect = await engine.inspect(containerId);
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) {
      send(response, 404, { error: "container-gone" });
      return;
    }
    throw error;
  }

  const context = composeContextOf(inspect.Config?.Labels ?? undefined, composeBasePath);
  if (!context) {
    // Either not Compose-managed at all, or the project directory lies
    // outside the base path. Both mean the same here: from this place nothing
    // is read and nothing is written.
    send(response, 409, { error: "no-compose-directory-in-base-path" });
    return;
  }

  const file = readComposeFile(context.projectDir, context.composeFileName);
  if (!file.exists) {
    // The container carries Compose labels, but the file is gone. That is a
    // real finding and not an empty answer: the container runs without the
    // definition it comes from.
    send(response, 409, {
      error: "compose-file-missing",
      projectDir: context.projectDir
    });
    return;
  }

  // Reading uses Compose's own parser. What comes out is NOT validated — it is
  // the actual state of a file that someone may have edited by hand. The
  // response says so via `specComplete` and `unsupportedKeys`, so that a UI
  // cannot present it as a checked spec (open point 3 from 6.2).
  let parsedSpec: unknown = null;
  let specReason: string | null = null;
  let unsupportedKeys: string[] = [];
  try {
    // ComposeContext carries projectDir AND composeFileName and thus
    // satisfies ComposeProject.
    const normalized = await composeConfig(context);
    const read = specFromComposeConfig(normalized, context.serviceName);
    if (read.ok) {
      parsedSpec = read.spec;
      unsupportedKeys = read.unsupportedKeys;
    } else {
      specReason = read.reason;
    }
  } catch {
    specReason = "compose-config-failed";
    console.error("[agent] compose config failed", { reason: specReason });
  }

  audit.write({
    action: "compose-read",
    containerId,
    containerName: (inspect.Name ?? "").replace(/^\//, ""),
    actor,
    outcome: "allowed",
    reason: context.projectDir
  });
  send(response, 200, {
    containerId,
    containerName: (inspect.Name ?? "").replace(/^\//, ""),
    projectDir: context.projectDir,
    serviceName: context.serviceName,
    composeFileName: context.composeFileName,
    content: file.content,
    // Exactly this hash has to be confirmed along with an edit.
    composeHash: file.hash,
    spec: parsedSpec,
    specComplete: parsedSpec !== null && unsupportedKeys.length === 0,
    unsupportedKeys,
    ...(specReason ? { specReason } : {})
  });
  return;
}

// --- Derived configuration (S5b, §16.3) ------------------------------
//
// Goes through gate() like the detail view. Its content is an allowlist of six
// fields (derived-config.ts), not a filtered copy of the inspect: host paths,
// labels, env and capabilities structurally cannot show up here.
export async function handleConfiguration(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId } = ctx;
  const result = await gate(containerId, {
    mutating: false,
    action: "configuration"
  });
  if (!result.ok) {
    audit.write({
      action: "configuration",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }
  send(response, 200, derivedConfig(result.inspect));
  return;
}

// --- Services of a container's project (security review S5b) ----------
//
// The main API needs the service→id mapping BEFORE it requests `.env` data:
// it has to check its grants against EVERY service of the project, and the
// agent does not know the grants. Conversely, the main API does not reliably
// know the project's composition — for a stack that has not been adopted,
// nothing about it is in its database.
//
// A SEPARATE, lean endpoint instead of attaching the ids to the env response:
// otherwise the main API would already have read the secrets when it decides
// about access. Decide first, then fetch.
//
// It returns names and ids, no file content and no values — but it names the
// project directory.
export async function handleStackServices(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId } = ctx;
  const before = await checkEnvAccess(containerId);
  if (!before.ok) {
    audit.write({
      action: "stack-services",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: before.reason
    });
    send(response, before.status, before.body);
    return;
  }
  send(response, 200, {
    projectDir: before.context.projectDir,
    composeFileName: before.context.composeFileName,
    serviceName: before.context.serviceName,
    containerName: before.containerName,
    containerIds: Object.fromEntries(before.serviceIds)
  });
  return;
}

// --- Environment: the `.env` next to the Compose file (S5b, §16) -------
//
// It hangs off docker.compose.raw (§16.2): whoever may write the Compose file
// can put any value in there anyway — a separate scope would be theatre. The
// main API checks the scope.
//
// The directory comes from the LABELS of the running container, never from
// the request (security review 5c, finding 4). There is no way to name a path
// to the agent here.
async function handleEnvUnlocked(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, url, actor, containerId } = ctx;
  const writing = request.method === "PUT";

  if (writing && config.readOnly) {
    send(response, 503, { error: "agent-read-only" });
    return;
  }
  // Allowlist, Compose directory, self-management lock AND the sweep
  // over all services of the project — see checkEnvAccess.
  const before = await checkEnvAccess(containerId);
  if (!before.ok) {
    audit.write({
      action: writing ? "env-write" : "env-read",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: before.reason
    });
    send(response, before.status, before.body);
    return;
  }
  const { context, containerName, inspect } = before;

  if (!writing) {
    // §16.4.5: plain text leaves the agent only on explicit request — not
    // "delivered and hidden in the frontend".
    // TRANSITION (#418, reasoning in request-keys.ts): the dashboard asks with
    // `?plaintext=1`. Without the legacy name (queryObject) the view would
    // stay masked permanently — no error, just asterisks where the operator
    // explicitly requested plain text. Goes away as soon as a dashboard of
    // this version or later runs everywhere.
    const query = parseRequest(envQuerySchema, queryObject(url));
    if (!query.ok) {
      rejectRequest(ctx, { action: "env-read", containerId, containerName: null }, query.rejection);
      return;
    }
    const { plaintext } = query.value;
    const file = readEnvFile(context.projectDir);

    // The image defaults say which line someone set and which was always
    // there. If the call fails (image gone locally), simply no line counts as
    // an image default.
    let imageEnv: string[];
    try {
      const imageInspect = inspect.Image ? await engine.inspectImage(inspect.Image) : null;
      imageEnv = imageInspect?.Config?.Env ?? [];
    } catch {
      imageEnv = [];
    }

    const entries = envView({
      file: file.entries,
      containerEnv: (inspect.Config?.Env ?? []).map(splitEnvEntry),
      imageEnv: imageEnv.map(splitEnvEntry),
      plaintext
    });

    // Merely viewing is logged too — unlike the status read calls, which are
    // deliberately not in the log. Here it is an access to secrets and belongs
    // on record, and the plain-text fetch is a SEPARATE entry (§16.2).
    audit.write({
      action: plaintext ? "env-read-plaintext" : "env-read",
      containerId,
      containerName,
      actor,
      outcome: "allowed",
      reason: `${context.projectDir}: ${entries.length} keys`
    });

    send(response, 200, {
      projectDir: context.projectDir,
      composeFileName: context.composeFileName,
      serviceName: context.serviceName,
      containerName,
      filePresent: file.exists,
      // Exactly this hash has to be confirmed along with a save.
      envHash: file.hash,
      plaintext,
      entries
    });
    return;
  }

  // There is deliberately no value for "don't care": either a hash (the file
  // is to look as last read) or explicitly null (none is supposed to exist
  // here yet). If the field is missing altogether, the schema refuses it
  // (`env-hash-missing`), as it refuses a value that is not text or holds a null
  // byte (`invalid-env-value`) and a request that changes nothing
  // (`no-change`).
  //
  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard sends `set`
  // and `remove`; readJsonBody still accepts the legacy names. Without them
  // every .env change would be empty, end in the "no change" 400 and the
  // editor would save into the void.
  const write = parseRequest(envWriteRequestSchema, await readJsonBody(request));
  if (!write.ok) {
    rejectRequest(ctx, { action: "env-write", containerId, containerName: before.containerName }, write.rejection);
    return;
  }
  const { expectedEnvHash: expectedHash, set, remove } = write.value;

  // The `.env` is part of the stack's definition, so an externally managed
  // anchor or service locks writing it like the raw editor (#121). Checked
  // synchronously right before the write; reading stays allowed.
  const managed = externallyManagedServices(containerId, before.serviceIds, (id) => registry.isExternallyManaged(id));
  if (managed !== null) {
    audit.write({
      action: "env-write",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: `externally-managed: ${managed.join(",")}`
    });
    send(response, 403, { error: "externally-managed", services: managed });
    return;
  }

  const change: EnvChange = { set, remove };
  let result;
  try {
    result = writeEnvFile(context.projectDir, change, {
      expectedHash,
      basePath: composeBasePath
    });
  } catch {
    send(response, 400, {
      error: "invalid-env-key",
      detail: "invalid-env-key"
    });
    return;
  }

  if (!result.ok) {
    audit.write({
      action: "env-write",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, 409, { error: result.reason, actualHash: result.actualHash });
    return;
  }

  // ⚠️ §16.4.4: only WHICH keys, never which values. The audit log is
  // append-only — what is in it once stays.
  audit.write({
    action: "env-write",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason:
      `${context.projectDir}: set [${Object.keys(set).sort().join(",")}] ` +
      `removed [${[...remove].sort().join(",")}]`
  });

  send(response, 200, {
    ok: true,
    projectDir: context.projectDir,
    envHash: result.hash,
    set: Object.keys(set).sort(),
    removed: [...remove].sort()
  });
  return;
}

export async function handleComposeCandidates(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, actor, containerId } = ctx;
  if (!registry.isAllowed(containerId)) {
    if (request.method !== "GET") {
      audit.write({ action: "compose-selection", containerId, containerName: null, actor,
        outcome: "denied", reason: "not-allowlisted" });
    }
    send(response, 404, { error: "not-allowlisted" });
    return;
  }
  const changing = request.method !== "GET";
  if (changing && config.readOnly) {
    audit.write({ action: "compose-selection", containerId, containerName: null, actor,
      outcome: "denied", reason: "agent-read-only" });
    send(response, 503, { error: "agent-read-only" });
    return;
  }
  const inspect = await engine.inspect(containerId);
  const containerName = (inspect.Name ?? "").replace(/^\//, "");
  if (containerName !== registry.get(containerId)?.containerName) {
    if (changing) {
      audit.write({ action: "compose-selection", containerId, containerName, actor,
        outcome: "denied", reason: "container-name-mismatch" });
    }
    send(response, 409, { error: "container-name-mismatch" });
    return;
  }
  const labels = inspect.Config?.Labels ?? undefined;
  const finding = composeContextFindingOf(labels, composeBasePath);
  const candidates = availableComposeCandidates(labels);
  const selected = composeSelections.get(containerName, candidates);
  if (!changing) {
    send(response, 200, {
      composeAnchor: finding.ok
        ? { ok: true, projectDir: finding.context.projectDir }
        : { ok: false, reason: finding.reason, projectDir: finding.projectDir },
      selectedFilePath: selected?.filePath ?? null,
      labelFilePaths: (labels?.["com.docker.compose.project.config_files"] ?? "")
        .split(",").map((file) => file.trim()).filter(Boolean),
      candidates
    });
    return;
  }
  if (request.method === "PUT") {
    const selection = parseRequest(composeSelectionRequestSchema, await readJsonBody(request));
    if (!selection.ok) {
      rejectRequest(ctx, { action: "compose-selection", containerId, containerName }, selection.rejection);
      return;
    }
    const { filePath } = selection.value;
    if (!labels?.["com.docker.compose.service"] || !isValidProjectName(labels["com.docker.compose.project"])) {
      audit.write({ action: "compose-selection", containerId, containerName, actor,
        outcome: "denied", reason: "compose-anchor-labels-missing" });
      send(response, 409, { error: "compose-anchor-labels-missing" });
      return;
    }
    if (!composeSelections.set(containerName, filePath, candidates)) {
      audit.write({ action: "compose-selection", containerId, containerName, actor,
        outcome: "denied", reason: "invalid-compose-candidate" });
      send(response, 400, { error: "invalid-compose-candidate" });
      return;
    }
    audit.write({ action: "compose-selection", containerId, containerName, actor,
      outcome: "allowed", reason: filePath });
    send(response, 200, { ok: true, selectedFilePath: filePath });
    return;
  }
  composeSelections.clear(containerName);
  audit.write({ action: "compose-selection", containerId, containerName, actor,
    outcome: "allowed", reason: "cleared" });
  send(response, 200, { ok: true, selectedFilePath: null });
  return;
}

export async function handleEnv(ctx: ContainerRouteContext): Promise<void> {
  if (ctx.request.method === "GET") return handleEnvUnlocked(ctx);
  const anchor = registry.get(ctx.containerId)?.compose;
  const inspect = anchor?.projectName ? null : await engine.inspect(ctx.containerId);
  const labelProject = inspect?.Config?.Labels?.["com.docker.compose.project"];
  const containerName = inspect?.Name?.replace(/^\//, "") ?? registry.get(ctx.containerId)?.containerName;
  const key = projectLockKey({ registryProject: anchor?.projectName, labelProject, containerName, containerId: ctx.containerId });
  try { await stackLocks.runExclusive(key, () => handleEnvUnlocked(ctx)); }
  catch (error) {
    if (!(error instanceof KeyedMutexBusyError)) throw error;
    send(ctx.response, 409, { error: "busy" });
  }
}
