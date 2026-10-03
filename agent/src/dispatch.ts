import type http from "node:http";
import { CONTRACT_HEADERS, CONTRACT_VERSION } from "./contract.js";
import { containerIdFromPath, checkTier } from "./route-policy.js";
import { EnvRedactionUnavailableError } from "./env-file.js";
import { KeyedMutexBusyError } from "./concurrency.js";
import { AGENT_VERSION } from "./version.js";

import {
  config,
  registry,
  audit,
  secretCheck,
  execSessions,
  openStreams,
  monitorStreams,
  bootstrapRegistration
} from "./runtime/state.js";
import {
  errorText,
  InvalidJsonError,
  SAFE_ACTIONS,
  parseTier,
  isAuthorized,
  send,
  firstHeader,
  logUnauth,
  type RouteContext
} from "./runtime/http.js";
import {
  handleContract,
  handleRegistrySync,
  handleHostContainers,
  handleContainerList,
  handleHostInfo,
  handleMonitorEvents,
  handleMonitorList,
  handleMonitorSync,
  handleAuditArchive,
  handleAuditArchiveDiscard
} from "./routes/agent-routes.js";
import {
  handleSelfUpdateStart,
  handleSelfUpdateStatus,
  handleSelfUpdateAvailable
} from "./routes/self-update-routes.js";
import {
  handleStackList,
  handleStackAdopt,
  handleStackRaw,
  handleContainerCreate,
  handleStackContext,
  handleStackAction
} from "./routes/stack-routes.js";
import { handleExecInput, handleExec } from "./routes/exec-routes.js";
import {
  handleContainerDetail,
  handleUpdateCheck,
  handleHardening,
  handleLogs,
  handleLogsStream,
  handleLogFile
} from "./routes/container-routes.js";
import {
  handleShareCandidates,
  handleFileList,
  handleFile,
  handleFileText,
  handleFileAction
} from "./routes/file-routes.js";
import { handlePull, handlePullStream, handleRecreatePreview } from "./routes/image-routes.js";
import { handleRecreate } from "./routes/recreate-routes.js";
import {
  handleCompose,
  handleConfiguration,
  handleStackServices,
  handleEnv,
  handleComposeCandidates
} from "./routes/compose-routes.js";
import { handleComposeRaw, handleResolve } from "./routes/compose-raw-routes.js";
import { handleApplySpec, handleRemove, handleSafeAction } from "./routes/definition-routes.js";


// Narrow internal API of the docker-agent (stage plan 3.2).
//
// Only the main API talks into this, over the dedicated Docker network and
// with its own shared secret. No host port, no public route.
//
// The agent is the LAST AUTHORITY, not an executing assistant: it checks
// allowlist, tier and hardening itself and rejects what does not suit it — even
// if the main API waves it through. Precisely in the attack that the socket
// isolation protects against, a check only in the API would already be bypassed.
//
// State as of stage 3: reading, safe actions (start/stop/restart), pull against
// the pinned ref and a host discovery reduced to id/name/image for maintaining
// the allowlist. destructive/exec/webftp/compose come later, each with its own
// stage — they are already in the route table, so that their rejection does
//
// The dispatcher stands in this file and not in index.ts (#272), so that a
// test can serve the real handlers from its own server: the round-trip tests
// (`server/src/agent/agent-roundtrip.test.ts` and its sibling in
// `server/src/features/logs/`) let the hub's
// agent client talk to them, with a Docker stand-in instead of docker.sock.
// index.ts creates the listening server and starts the agent around it.
export async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://agent");
  // ⚠️ Via firstHeader instead of a cast: a header set twice yields a string[]
  // in Node, and `as string` would have turned that into an array that only
  // turns out to be something else at the comparison (parseTier) or at the
  // session owner (actor).
  const actor = firstHeader(request, CONTRACT_HEADERS.actor);
  const tier = firstHeader(request, CONTRACT_HEADERS.tier);
  const parsedTier = parseTier(tier);

  // /health is deliberately unprotected and says nothing about containers —
  // only that the process is alive.
  if (request.method === "GET" && url.pathname === "/health") {
    // `selfProtection` is the NUMBER of protected own directories, not the
    // paths: after a rollout it proves that the agent has found its own mounts
    // (S23), without revealing where things are stored. The endpoint deliberately
    // sits before the secret check — hence only numbers here, as with `entries`.
    send(response, 200, {
      ok: true,
      // The agent's own version. It sits here and not behind the secret, because
      // exactly this endpoint is the one the dashboard queries when connecting and
      // periodically afterwards (S18/U4) — and because "which agent runs on which
      // host" is the question without which there is no guided update of the
      // agents. The information is reachable over the WireGuard network, not
      // publicly; whoever can read it can reach the port anyway.
      version: AGENT_VERSION,
      contractVersion: CONTRACT_VERSION,
      readOnly: config.readOnly,
      entries: registry.size(),
      selfProtection: config.selfPaths.length,
      // The audit log deliberately does not rotate (audit.ts). So that its growth
      // stays observable instead of being noticed when the volume is full, the
      // SIZE travels along — a number, like `entries` and `selfProtection`.
      auditBytes: audit.sizeBytes(),
      // How much is still free on the /state volume at all (#30).
      //
      // Without this number "the log is large" is the only possible statement, and
      // the threshold for it has to be guessed. Measured on 2026-08-22 the two sizes
      // were four orders of magnitude apart (1.4 MB log, 26.9 GB free) — an
      // absolute byte mark can only estimate this gap. With both numbers the
      // threshold becomes a RATIO, and the alarm says what it is supposed to say:
      // not "the log is growing", but "it is eating the last remainder".
      //
      // Like `auditBytes` only a number and not a path — the endpoint sits before
      // the secret check.
      stateFreeBytes: audit.freeSpaceBytes(),
      // How many streams are open right now, measured against their cap (R3).
      // Sits next to `auditBytes` for the same reason: whatever grows silently has
      // to be visible before it hits the limit. Only numbers — who holds which
      // stream is in the audit log, not in front of the secret check.
      streams: {
        open: openStreams.count,
        maximum: openStreams.maximum,
        monitor: monitorStreams.count,
        exec: execSessions.count,
        // R5: how long the long-lived paths are ACTUALLY open. The transport
        // deadlines (connection-limits.ts) could only be chosen after this question
        // was answered — and it stays answerable instead of having been estimated
        // once. If `longestMs` rises close to a deadline, that is the hint that
        // otherwise only a torn-off log stream would give.
        //
        // Only the two capped pools: the duration of an exec session is in its audit
        // entry anyway (`exec-end`, `duration=`), and it is the only one hard-limited,
        // by EXEC_MAX_DURATION_MS.
        oldestMs: Math.max(openStreams.oldestMs, monitorStreams.oldestMs),
        longestMs: Math.max(openStreams.longestMs, monitorStreams.longestMs)
      },
      // Whether this host is registered with the main API (R9). Since v0.8.0 the
      // registration gives up after a deadline instead of trying forever —
      // without this information "given up" would be a state that only a look into
      // the container log reveals. Of all endpoints, this one is the one the
      // dashboard queries anyway when connecting.
      //
      // Only phase and counter, like `entries` and `selfProtection`: the address of
      // the main API and the reason for the rejection stay in the log.
      bootstrap: bootstrapRegistration.state(),
      // Is a secret rotation in progress, and is the old value still needed
      // (#19)? `used` is the number of requests that came in since the start ONLY
      // via the transition value — if it stands still after the main API has
      // switched over, the old value can go.
      secondarySecret: {
        active: secretCheck.secondaryActive,
        used: secretCheck.secondaryUsed
      }
    });
    return;
  }

  if (!isAuthorized(request)) {
    // No detail to the outside; the attempt is logged.
    //
    // ⚠️ Aggregated instead of one line per attempt. This is the second half of
    // the cap from audit.ts: there every FIELD is limited, here the NUMBER.
    // Without both, the only endpoint before the secret check would at the same
    // time be the cheapest way to fill up the /state volume — and without a
    // writable audit log the agent executes nothing at all any more.
    //
    // Nothing is concealed by this: the first attempt of a window is logged
    // immediately, all further ones go as a counter into the next entry. An
    // attack thus looks like more in the log, not like less.
    logUnauth(request.method ?? "?", url.pathname, actor, tier);
    send(response, 401, { error: "unauthorized" });
    return;
  }

  // The tier decision. ONE point, against the table in route-policy.ts.
  //
  // ⚠️ It used to live in three places — in INTERNAL_ONLY_ACTIONS, in the `if` in
  // gate() and in sixteen handwritten `if`s per special route. Two routes had
  // never received the third place; exactly that was finding S1. What stands
  // here is therefore not a rebuild out of love of order: "which route requires
  // which tier?" is from now on a line in a table and not a property one has to
  // piece together from 6,400 lines.
  //
  // The check applies BEFORE any work on the request — before reading the body,
  // before collecting the secrets, before any engine call.
  // Whatever is not in the table counts as internal-only (default deny).
  //
  // gate() then checks the action level a second time on the container: the
  // agent is the last authority, and it does not give up this promise even
  // towards itself.
  const tierDecision = checkTier(request.method ?? "", url.pathname, parsedTier, actor);
  if (!tierDecision.ok) {
    audit.write({
      action: tierDecision.audit,
      containerId: containerIdFromPath(url.pathname),
      containerName: null,
      actor,
      networkTier: tier,
      outcome: "denied",
      reason: tierDecision.reason
    });
    send(response, tierDecision.status, { error: tierDecision.reason });
    return;
  }

  const ctx: RouteContext = { request, response, url, actor, tier, parsedTier };
  try {
    if (request.method === "GET" && url.pathname === "/contract") {
      await handleContract(ctx);
      return;
    }

    if (request.method === "PUT" && url.pathname === "/registry") {
      await handleRegistrySync(ctx);
      return;
    }

    if (request.method === "POST" && url.pathname === "/self-update") {
      await handleSelfUpdateStart(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/self-update") {
      await handleSelfUpdateStatus(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/self-update/available") {
      await handleSelfUpdateAvailable(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/host-containers") {
      await handleHostContainers(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/stacks") {
      await handleStackList(ctx);
      return;
    }

    if (request.method === "POST" && url.pathname === "/stacks/adopt") {
      await handleStackAdopt(ctx);
      return;
    }

    if (request.method === "POST" && url.pathname === "/stacks/raw") {
      await handleStackRaw(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/containers") {
      await handleContainerList(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/host-info") {
      await handleHostInfo(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/monitor-events") {
      await handleMonitorEvents(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/monitors") {
      await handleMonitorList(ctx);
      return;
    }

    if (request.method === "PUT" && url.pathname === "/monitors") {
      await handleMonitorSync(ctx);
      return;
    }

    if (request.method === "GET" && url.pathname === "/audit-archive") {
      await handleAuditArchive(ctx);
      return;
    }

    if (request.method === "POST" && url.pathname === "/audit-archive/discard") {
      await handleAuditArchiveDiscard(ctx);
      return;
    }

    if (request.method === "POST" && url.pathname === "/containers") {
      await handleContainerCreate(ctx);
      return;
    }

    // --- Stack context and project-wide actions (S11) ---------------------
    //
    // The request names exclusively a registry anchor. Path, file, project name
    // and services come from the agent's own registry or from Docker/Compose.
    // That way there is no request parameter that could be abused as a path,
    // CLI project name or service list.
    const stackContextMatch = url.pathname.match(/^\/stacks\/([^/]+)\/context$/);
    if (request.method === "GET" && stackContextMatch) {
      await handleStackContext(ctx, stackContextMatch);
      return;
    }

    const stackActionMatch = url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/);
    if (request.method === "POST" && stackActionMatch) {
      await handleStackAction(ctx, stackActionMatch);
      return;
    }

    // --- Back channel of a shell session (S16 — K1d, §20.1) -------------------
    //
    // Input, window size and closing sit NEXT TO the output stream, because an
    // HTTP request is only good at one direction. Three points nevertheless make
    // this safe:
    //
    //   1. The session id is 256 random bits — not guessable, not
    //      enumerable.
    //   2. It is NOT ENOUGH: the actor has to be the same as when opening.
    //      Otherwise an overheard id would be a way into someone else's shell.
    //   3. The tier is checked again. A session that started internally cannot
    //      be continued from the outside.
    //
    // ⚠️ Deliberately NOTHING that goes through is logged here: that would be the
    // recording that condition 1 of §20.1 rules out. Rejected attempts, however,
    // are — typing into someone else's session is exactly the signal the log
    // exists for.
    const execMatch = url.pathname.match(/^\/exec\/([^/]+)\/(input|size|close)$/);
    if (request.method === "POST" && execMatch) {
      await handleExecInput(ctx, execMatch);
      return;
    }

    const containerMatch = url.pathname.match(/^\/containers\/([^/]+)(?:\/([^/]+))?$/);
    if (containerMatch) {
      const containerId = decodeURIComponent(containerMatch[1]);
      const action = containerMatch[2];

      if (request.method === "GET" && !action) {
        await handleContainerDetail({ ...ctx, containerId });
        return;
      }

      if (request.method === "GET" && action === "update-check") {
        await handleUpdateCheck({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "hardening") {
        await handleHardening({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "logs") {
        await handleLogs({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "logs-stream") {
        await handleLogsStream({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "log-file") {
        await handleLogFile({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "share-candidates") {
        await handleShareCandidates({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "files") {
        await handleFileList({ ...ctx, containerId, action });
        return;
      }

      if (action === "file" && (request.method === "GET" || request.method === "PUT")) {
        await handleFile({ ...ctx, containerId, action });
        return;
      }

      if (action === "file-text" && (request.method === "GET" || request.method === "PUT")) {
        await handleFileText({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "files") {
        await handleFileAction({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "exec") {
        await handleExec({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "pull") {
        await handlePull({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "pull-stream") {
        await handlePullStream({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "recreate-preview") {
        await handleRecreatePreview({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "recreate") {
        await handleRecreate({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "compose") {
        await handleCompose({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "configuration") {
        await handleConfiguration({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "GET" && action === "stack-services") {
        await handleStackServices({ ...ctx, containerId, action });
        return;
      }

      if (action === "env" && (request.method === "GET" || request.method === "PUT")) {
        await handleEnv({ ...ctx, containerId, action });
        return;
      }

      if (
        (request.method === "GET" && action === "compose-candidates") ||
        ((request.method === "PUT" || request.method === "DELETE") && action === "compose-selection")
      ) {
        await handleComposeCandidates({ ...ctx, containerId, action });
        return;
      }

      if (
        (action === "compose-raw" && (request.method === "GET" || request.method === "POST")) ||
        (action === "compose-raw-preview" && request.method === "POST") ||
        (action === "compose-raw-stream" && request.method === "POST")
      ) {
        await handleComposeRaw({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "resolve") {
        await handleResolve({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "apply-spec") {
        await handleApplySpec({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action === "remove") {
        await handleRemove({ ...ctx, containerId, action });
        return;
      }

      if (request.method === "POST" && action && SAFE_ACTIONS.has(action)) {
        await handleSafeAction({ ...ctx, containerId, action });
        return;
      }
    }

    send(response, 404, { error: "unknown-endpoint" });
  } catch (error) {
    // Engine error messages can contain paths and names — they go into the
    // container log, but not into the response.
    // A body that is not JSON (#272): a named rejection for every route, not a
    // 500. Before, three routes answered it themselves and the rest crashed.
    if (error instanceof InvalidJsonError) {
      audit.write({
        action: `${request.method} ${url.pathname}`,
        containerId: containerIdFromPath(url.pathname),
        containerName: null,
        actor,
        networkTier: tier,
        outcome: "denied",
        reason: "invalid-json"
      });
      send(response, 400, { error: "invalid-json", field: "" });
      return;
    }
    if (error instanceof KeyedMutexBusyError) {
      audit.write({
        action: "stack-busy",
        containerId: null,
        containerName: null,
        actor,
        networkTier: tier,
        outcome: "denied",
        reason: "stack-busy"
      });
      send(response, 409, { error: "stack-busy" });
      return;
    }
    if (error instanceof EnvRedactionUnavailableError) {
      audit.write({
        action: "log-redaction",
        containerId: null,
        containerName: null,
        actor,
        networkTier: tier,
        outcome: "denied",
        reason: "redaction-unavailable"
      });
      // All three log paths read the secret set before their response headers.
      // That way even an external grant stays fail-closed on EACCES/EIO.
      send(response, 503, { error: "redaction-unavailable" });
      return;
    }
    console.error("[agent] error:", error);
    audit.write({
      action: `${request.method} ${url.pathname}`,
      containerId: null,
      containerName: null,
      actor,
      networkTier: tier,
      outcome: "error",
      // ⚠️ With the MESSAGE, not just the name. `error.name` is simply "Error"
      // for almost every error — a line that says nothing, at exactly the place
      // where one looks later. The response stays at the blanket 500 (it goes to
      // the network); the audit lives on the host and is the place where the
      // operator needs the real sentence.
      reason: errorText(error)
    });
    send(response, 500, { error: "internal-error" });
  }
}
