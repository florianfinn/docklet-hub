import { execInputRequestSchema, terminalSizeSchema, type ExecStreamLine } from "contract";
import {
  secretsFromEnvFile
} from "../env-file.js";
import {
  envPlaintextOf
} from "../redact.js";
import {
  verifiedComposeContextForLogs
} from "../log-compose-context.js";
import {
  EXEC_IDLE_MS,
  EXEC_MAX_DURATION_MS,
  ExecSessions,
  RedactingStream,
  SHELL_CANDIDATES,
  type ExecSession
} from "../exec.js";
import { sendLine } from "../ndjson-line.js";
import { config, engine, registry, audit, execSessions } from "../runtime/state.js";
import { composeBasePath } from "../runtime/containers.js";
import {
  EXEC_AUDIT_NAME,
  send,
  readJsonBody,
  parseRequest,
  rejectRequest,
  RouteContext,
  ContainerRouteContext
} from "../runtime/http.js";
import { gate } from "../runtime/gate.js";

export async function handleExecInput(ctx: RouteContext, execMatch: RegExpMatchArray): Promise<void> {
  const { request, response, actor } = ctx;
  const sessionId = decodeURIComponent(execMatch[1]);
  const subAction = execMatch[2];

  // The audit name is its own word next to the path segment (`size` is
  // `exec-resize`), as `audit:` in `route-policy.ts`. Since contract 6 (#278)
  // it is English; lines archived before carry the old German names, which
  // the changelog lists.
  const auditName = EXEC_AUDIT_NAME[subAction];

  // ⚠️ The kill switch must also catch RUNNING sessions. It is checked via
  // gate() on opening, but a break-glass that lets an already open shell keep
  // typing would be no break-glass. The only exception is "close": ending
  // must always work.
  if (config.readOnly && subAction !== "close") {
    execSessions.fetch(sessionId, actor)?.finish("agent-read-only");
    send(response, 503, { error: "agent-read-only" });
    return;
  }

  const session = execSessions.fetch(sessionId, actor);
  if (!session) {
    // Unknown and foreign are deliberately the same response — otherwise
    // valid session ids could be confirmed via the status code.
    audit.write({
      action: auditName,
      containerId: null,
      containerName: null,
      actor,
      outcome: "denied",
      reason: "session-unknown"
    });
    send(response, 404, { error: "session-unknown" });
    return;
  }

  if (subAction === "close") {
    session.finish("closed");
    send(response, 200, { ok: true });
    return;
  }

  // A registry sync can downgrade an already open shell to the observer
  // class. The random session id and the actor are then no longer enough for
  // input or resize; closing stays possible.
  const sessionAccess = registry.checkAccess(session.containerId, true);
  if (sessionAccess !== "allowed") {
    session.finish("registry-access-revoked");
    audit.write({
      action: auditName,
      containerId: session.containerId,
      containerName: session.containerName,
      actor,
      outcome: "denied",
      reason: sessionAccess
    });
    send(response, sessionAccess === "observe-only" ? 403 : 404, { error: sessionAccess });
    return;
  }

  const body = await readJsonBody(request);
  if (subAction === "size") {
    // Clamped, never refused: the size is display, not a permission.
    const size = terminalSizeSchema.parse(body);
    try {
      await session.resize(size);
    } catch {
      // A failed resize is cosmetic and must not end the session.
    }
    send(response, 200, { ok: true });
    return;
  }

  // Base64 instead of raw text: keyboard input is bytes (control characters,
  // escape sequences, incomplete UTF-8 sequences when typing fast) and not a
  // well-formed string.
  const input = parseRequest(execInputRequestSchema, body);
  if (!input.ok) {
    rejectRequest(
      ctx,
      { action: auditName, containerId: session.containerId, containerName: session.containerName },
      input.rejection,
      input.rejection.error === "input-too-large" ? 413 : 400
    );
    return;
  }
  session.write(Buffer.from(input.value.data, "base64"));
  send(response, 200, { ok: true });
  return;
}

// --- Shell in the container (S16 — K1d, §20.1) -------------------------
//
// The session itself is ONE NDJSON stream (output); input and resize come in
// as separate short requests on /exec/:session. This is deliberately not a
// WebSocket: the agent has no runtime dependencies (package.json), and a
// hand-written RFC 6455 frame parser precisely in the process with
// docker.sock would be the worst conceivable place for home-made protocol
// code. The NDJSON plumbing, on the other hand, has been in place since S6
// and is proven.
//
// ⚠️ `mutating: true` is not a formality. It activates two barriers, both
// right for code execution in the container: the kill switch
// (`agent-read-only`) and the self-management lock (no shell in the
// containers that carry the dashboard itself).
export async function handleExec(ctx: ContainerRouteContext): Promise<void> {
  const { request, response, actor, containerId } = ctx;
  const result = await gate(containerId, { mutating: true, action: "exec", actor });
  if (!result.ok) {
    audit.write({
      action: "exec-start",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }

  const containerName = (result.inspect.Name ?? "").replace(/^\//, "");
  const deny = (status: number, reason: string) => {
    audit.write({
      action: "exec-start",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: reason
    });
    send(response, status, { error: reason });
  };

  // Nothing can be run in a stopped container. Saying so as a response of
  // its own is better than the raw engine error the daemon would otherwise
  // write right into the terminal stream.
  if (result.inspect.State?.Running !== true) {
    deny(409, "container-not-started");
    return;
  }
  if (execSessions.isFull()) {
    deny(429, "too-many-sessions");
    return;
  }

  const size = terminalSizeSchema.parse(await readJsonBody(request));

  // Shell detection (§20.1): bash, otherwise sh — and a container without
  // either SAYS so instead of failing silently.
  let shell: string | null = null;
  for (const candidate of SHELL_CANDIDATES) {
    if (await engine.execAvailable(containerId, candidate)) {
      shell = candidate;
      break;
    }
  }
  if (!shell) {
    deny(409, "no-shell");
    return;
  }

  // The same two secret sources as for the log stream (§16.4 point 1): the
  // container env and the `.env` of the Compose project. An `env` in the
  // shell must not print what the log stream next to it masks.
  const composeContext = verifiedComposeContextForLogs(
    registry.get(containerId),
    result.inspect.Config?.Labels ?? undefined,
    composeBasePath
  );
  const secrets = [
    ...Object.values(envPlaintextOf(result.inspect.Config?.Env)),
    ...(composeContext ? secretsFromEnvFile(composeContext.projectDir) : [])
  ];

  let execId: string;
  let socket: Awaited<ReturnType<typeof engine.execStart>>;
  try {
    execId = await engine.execCreate(containerId, [shell], { tty: true, attach: true });
    socket = await engine.execStart(execId, { tty: true });
  } catch (error) {
    console.error("[agent] exec-start:", error);
    deny(502, "exec-start-failed");
    return;
  }
  // The size only goes AFTER the start; a failure is cosmetic (80x24) and
  // must not prevent the session.
  await engine.execResize(execId, size.cols, size.rows).catch(() => {});

  const sessionId = ExecSessions.newId();
  const redactor = new RedactingStream(secrets);
  const decoder = new TextDecoder("utf-8");
  const startMs = Date.now();
  let lastActivity = startMs;
  let ended = false;
  let grace: NodeJS.Timeout | null = null;

  const writeOutput = (text: string) => {
    if (!text) return;
    if (!sendLine(response, { kind: "output", text } satisfies ExecStreamLine)) finish("backpressure");
  };

  // ⚠️ The grace period is the second half of the redaction: what
  // RedactingStream holds back because it COULD be the start of a secret
  // must still become visible when nothing more follows — otherwise a prompt
  // would remain invisible.
  const planGrace = () => {
    if (grace) clearTimeout(grace);
    grace = setTimeout(() => {
      grace = null;
      writeOutput(redactor.flush());
    }, 300);
  };

  function finish(reason: string): void {
    if (ended) return;
    ended = true;
    if (grace) clearTimeout(grace);
    clearInterval(guard);
    execSessions.remove(sessionId);
    socket.destroy();
    audit.write({
      action: "exec-end",
      containerId,
      containerName,
      actor,
      outcome: "allowed",
      // Volume instead of content (condition 1 from §20.1): duration and byte
      // count, NEVER the input or output. A complete recording would be a
      // secret archive in the append-only log.
      reason: `reason=${reason} duration=${Math.round((Date.now() - startMs) / 1000)}s in=${session.sent}B out=${session.received}B`
    });
  }

  const guard = setInterval(() => {
    if (Date.now() - startMs > EXEC_MAX_DURATION_MS) finish("time-limit");
    else if (Date.now() - lastActivity > EXEC_IDLE_MS) finish("idle");
  }, 30_000);

  const session: ExecSession = {
    id: sessionId,
    containerId,
    containerName,
    actor,
    execId,
    shell,
    started: startMs,
    sent: 0,
    received: 0,
    write(data) {
      lastActivity = Date.now();
      session.sent += data.length;
      socket.write(data);
    },
    async resize(updated) {
      lastActivity = Date.now();
      await engine.execResize(execId, updated.cols, updated.rows);
    },
    finish
  };
  execSessions.register(session);

  audit.write({
    action: "exec-start",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    // As with the log stream: `envFile` says how far the redaction of the
    // output reached (log-compose-context.ts).
    reason: `shell=${shell} envFile=${composeContext ? "yes" : "no"}`
  });

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no"
  });
  // Unlike the log streams, lines here are written from a SECOND socket (the
  // container's). A write error after disconnecting would therefore arrive
  // outside any await — without this listener it would be an unhandled
  // stream event.
  response.on("error", () => finish("connection-error"));
  if (!sendLine(response, { kind: "start", session: sessionId, shell, containerName } satisfies ExecStreamLine)) {
    finish("backpressure");
  }

  const onDisconnect = () => finish("connection-closed");
  response.on("close", onDisconnect);

  socket.on("data", (chunk: Buffer) => {
    lastActivity = Date.now();
    session.received += chunk.length;
    writeOutput(redactor.push(decoder.decode(chunk, { stream: true })));
    planGrace();
  });

  await new Promise<void>((resolve) => {
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    // A `finish` from outside (time limit, disconnect) destroys the socket
    // and thereby also ends up in "close".
  });

  response.off("close", onDisconnect);
  if (grace) clearTimeout(grace);
  // Complete broken multi-byte sequences, then send out the rest of the
  // redaction.
  writeOutput(redactor.push(decoder.decode()));
  writeOutput(redactor.flush());
  sendLine(response, {
    kind: "end",
    // After an abort from outside the exit code is neither known nor
    // interesting — so no further engine call for it.
    exitCode: ended ? null : await engine.execExitCode(execId)
  } satisfies ExecStreamLine);
  finish("process-exited");
  response.end();
  return;
}
