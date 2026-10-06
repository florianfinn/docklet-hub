import {
  logFileQuerySchema,
  logsSnapshotQuerySchema,
  logsStreamQuerySchema,
  type LogFileStreamLine,
  type LogsStreamLine
} from "contract";
import { queryObject } from "../request-keys.js";
import {
  EngineAbortError,
  EngineError
} from "../engine.js";
import {
  hardeningReport
} from "../hardening.js";
import { mutabilityOf, parseImageRef } from "../image-ref.js";
import { forcedManagement } from "../stacks.js";
import {
  EnvRedactionUnavailableError,
  secretsFromEnvFile
} from "../env-file.js";
import {
  envPlaintextOf,
  redactKnownSecrets,
  toContainerSummary
} from "../redact.js";
import type { DemuxedLine } from "../log-demux.js";
import { checkLogPath, tailLogFile, TailEnded, type LogFileFailureReason } from "../log-file.js";
import {
  logsStreamFailureReason,
  type LogsStreamFailureReason
} from "../stream-failure-reasons.js";
import {
  requiredComposeContextForFileLogs,
  verifiedComposeContextForLogs
} from "../log-compose-context.js";
import { localManifestDigest } from "../update.js";
import { sendLine } from "../ndjson-line.js";
import { engine, registry, audit, statsHistory, openStreams } from "../runtime/state.js";
import {
  composeBasePath,
  hardeningOptionsFor,
  imageManagerLabelOf,
  volumeBindsOf,
  inspectedContainer
} from "../runtime/containers.js";
import {
  parseRequest,
  rejectRequest,
  send,
  type ContainerContext,
  type ContainerRouteContext
} from "../runtime/http.js";
import { gate } from "../runtime/gate.js";

// --- Detail view ------------------------------------------------------
export async function handleContainerDetail(ctx: ContainerContext): Promise<void> {
  const { response, actor, containerId } = ctx;
  const result = await gate(containerId, { mutating: false, action: "view" });
  if (!result.ok) {
    audit.write({
      action: "view",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }
  const volumeResolution = await volumeBindsOf(result.inspect);
  send(
    response,
    200,
    toContainerSummary(result.inspect, {
      ...hardeningOptionsFor(containerId),
      volumeBinds: volumeResolution.binds,
      unresolvedVolumes: volumeResolution.unresolved,
      stats: statsHistory.snapshot(containerId),
      imageManagerLabel: await imageManagerLabelOf(result.inspect.Config?.Labels, result.inspect.Image)
    })
  );
  return;
}

// --- Update check (Docker monitoring D2) ------------------------------
//
// The comparison is done later by the main API (L2): the agent only supplies
// the local manifest digest (from the RepoDigests of the running image) and
// the REMOTE digest that the daemon fetches via the distribution API —
// without pulling layers. The ref is the pinned one from the allowlist, never
// one from the request. Read-only; goes through gate() (allowlist).
export async function handleUpdateCheck(ctx: ContainerRouteContext): Promise<void> {
  const { response, actor, containerId } = ctx;
  const result = await gate(containerId, {
    mutating: false,
    action: "update-check"
  });
  if (!result.ok) {
    audit.write({
      action: "update-check",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }
  const ref = registry.expectedImageRef(containerId);
  const refParsed = ref ? parseImageRef(ref) : null;
  if (!ref || !refParsed) {
    send(response, 409, { error: ref ? "image-ref-unreadable" : "no-image-ref" });
    return;
  }
  const imageId = result.inspect.Image;
  const imageInspect = imageId ? await engine.inspectImage(imageId) : null;
  const localDigest = localManifestDigest(imageInspect?.RepoDigests, ref);
  const remoteDigest = await engine.remoteManifestDigest(ref);
  // R1: "local != remote" means something different for a PINNED ref than
  // for a movable one. For a digest ref a difference would be a
  // contradiction (the digest IS the content); for `:latest` it is the normal
  // case and says nothing about WHAT has changed. Without this information
  // the update view would have to present both the same way.
  send(response, 200, {
    imageRef: ref,
    localDigest,
    remoteDigest,
    imageMutability: mutabilityOf(refParsed)
  });
  return;
}

// --- Hardening report with details (stage 4) ---------------------------
// The details name host paths, capabilities and mount targets — that is a
// map of the host.
//
// Deliberately does NOT go through gate(): a container with blocking
// violations is exactly the one whose report you need to see. The allowlist
// is checked anyway.
export async function handleHardening(ctx: ContainerRouteContext): Promise<void> {
  const { response, containerId } = ctx;
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

  const report = hardeningReport(await inspectedContainer(inspect), hardeningOptionsFor(containerId));
  send(response, 200, {
    containerId,
    containerName: (inspect.Name ?? "").replace(/^\//, ""),
    // "locked" here does NOT mean "the operator can do nothing". It means:
    // this container should not be passed on to third parties; the agent
    // reports and audits it but does not block.
    delegationLocked: report.delegationLock.length > 0,
    delegationLock: report.delegationLock,
    warning: report.warning,
    hint: report.hint,
    checkedAt: new Date().toISOString()
  });
  return;
}

// --- Logs -------------------------------------------------------------
export async function handleLogs(ctx: ContainerRouteContext): Promise<void> {
  const { response, url, actor, containerId } = ctx;
  const result = await gate(containerId, { mutating: false, action: "logs" });
  if (!result.ok) {
    // The rejection is logged too: repeatedly rejected log access is exactly
    // the signal the log exists for.
    audit.write({
      action: "logs",
      containerId,
      containerName: null,
      actor,
      outcome: "denied",
      reason: result.reason
    });
    send(response, result.status, { error: result.reason });
    return;
  }
  const query = parseRequest(logsSnapshotQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "logs", containerId, containerName: null }, query.rejection);
    return;
  }
  const { tail } = query.value;
  const logs = await engine.logs(containerId, tail, result.inspect.Config?.Tty === true);

  // ⚠️ Redaction as for the live stream (§16.4 point 1). Up to R2 it was
  // missing precisely HERE: the one-off snapshot is older than S6 and went
  // out raw, while the same content was masked in the stream. It is also
  // reachable externally via the same grant-required scope and is
  // additionally used by the guided update as a 25-line attachment — masking
  // that depends on the chosen endpoint is no masking.
  const composeContext = verifiedComposeContextForLogs(
    registry.get(containerId),
    result.inspect.Config?.Labels ?? undefined,
    composeBasePath
  );
  const secrets = [
    ...Object.values(envPlaintextOf(result.inspect.Config?.Env)),
    ...(composeContext ? secretsFromEnvFile(composeContext.projectDir) : [])
  ];

  audit.write({
    action: "logs",
    containerId,
    containerName: (result.inspect.Name ?? "").replace(/^\//, ""),
    actor,
    outcome: "allowed",
    // ⚠️ How far the redaction actually reached. Without a confirmed Compose
    // anchor there is no project `.env` as an additional source
    // (log-compose-context.ts) — that is allowed, but it should be in the
    // log. Masking that is weaker than assumed must not be invisibly weaker.
    reason: `envFile=${composeContext ? "yes" : "no"}`
  });
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end(redactKnownSecrets(logs.toString("utf8"), secrets));
  return;
}

// --- Log stream (S6, §12.4) --------------------------------------------
//
// The same scope as "logs" (docker.logs.view, grant-required) — the stream
// says nothing more than the snapshot, it just says it continuously. Hence the
// same gate action "logs".
//
// ⚠️ Redaction is mandatory, not optional (§16.4 point 1): a live log is the
// most convenient secret leak channel of all. The secrets come from TWO
// sources — the container env (always present) and the `.env` file of the
// Compose project, if one exists (secretsFromEnvFile, prepared since S5b and
// without a caller until here). Both together go into
// `redactKnownSecrets()`.
export async function handleLogsStream(ctx: ContainerRouteContext): Promise<void> {
  const { response, url, actor, containerId } = ctx;
  const result = await gate(containerId, { mutating: false, action: "logs" });
  if (!result.ok) {
    audit.write({
      action: "logs-stream",
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

  // R3: the cap comes BEFORE collecting the secrets — that reads the
  // project's `.env` from disk, and doing work for a request that is about
  // to be rejected is exactly the amplification the cap is there to prevent.
  const releaseStreamSlot = openStreams.tryAcquire();
  if (!releaseStreamSlot) {
    audit.write({
      action: "logs-stream",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "too-many-streams"
    });
    send(response, 429, { error: "too-many-streams" });
    return;
  }
  // Fallback against a lost slot: if something goes wrong between here and
  // the `finally` (the disk while writing the audit, a read error on the
  // `.env`), the outer error handler does answer with 500 — but the counter
  // would stay incremented forever, and after eight such cases the endpoint
  // would be permanently closed. `close` fires on every path, and the
  // release only counts once.
  response.once("close", releaseStreamSlot);

  // tail=0 is the internal S15 alert stream: only NEW lines, so that a
  // scheduled reconnect does not report old hits again. Browser callers
  // continue to use a positive excerpt. A value outside 0..MAX_TAIL is
  // refused (`logsStreamQuerySchema`), no longer clamped.
  const query = parseRequest(logsStreamQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "logs-stream", containerId, containerName }, query.rejection);
    return;
  }
  const safeTail = query.value.tail;
  const tty = result.inspect.Config?.Tty === true;

  const composeContext = verifiedComposeContextForLogs(
    registry.get(containerId),
    result.inspect.Config?.Labels ?? undefined,
    composeBasePath
  );
  const secrets = [
    ...Object.values(envPlaintextOf(result.inspect.Config?.Env)),
    ...(composeContext ? secretsFromEnvFile(composeContext.projectDir) : [])
  ];

  audit.write({
    action: "logs-stream",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    // `envFile` says how far the redaction reached — see the reasoning at
    // the snapshot endpoint above.
    reason: `tail=${safeTail} envFile=${composeContext ? "yes" : "no"}`
  });

  // From here on the status is fixed (200) — the same reason for the own
  // try/catch as with pull-stream: an error can only be IN the stream now.
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no"
  });
  const streamAbort = new AbortController();
  const onDisconnect = () => streamAbort.abort();
  response.on("close", onDisconnect);
  if (!sendLine(response, { kind: "start", containerName, tty } satisfies LogsStreamLine)) streamAbort.abort();

  try {
    await engine.logsStream(
      containerId,
      { tail: safeTail, tty },
      (line: DemuxedLine) => {
        if (!sendLine(response, {
          kind: "line",
          stream: line.stream,
          ts: line.ts,
          text: redactKnownSecrets(line.text, secrets)
        } satisfies LogsStreamLine)) streamAbort.abort();
      },
      streamAbort.signal
    );
  } catch (error) {
    // An abort no longer gets an error line (#80). It means "the caller
    // closed the connection" — someone closed the tab — and exactly that
    // connection would be the route by which the line would have to arrive.
    // It never had a reader; reported as `kind: "error"` it turned the
    // normal case into an event the UI has to explain.
    if (!(error instanceof EngineAbortError)) {
      console.error("[agent] logs-stream:", error);
      // Typed as LogsStreamFailureReason: a value outside the set would be a
      // type error HERE and not only at the consumer (issue #82).
      const reason: LogsStreamFailureReason = logsStreamFailureReason(error);
      sendLine(response, { kind: "error", reason } satisfies LogsStreamLine);
    }
  } finally {
    releaseStreamSlot();
    response.off("close", onDisconnect);
  }
  response.end();
  return;
}

// --- Additional log file (S8 — K1e, §20.2) ----------------------------
//
// Game servers do not write to stdout but to their own files. This route
// reads ONE of them from the host file system and follows it — with the side
// effect that tipped the balance: it also works for a STOPPED container, i.e.
// exactly when you want to know why it is down.
//
// No new scope (§20.2): a log file is a log, so the same gate action "logs"
// with the same grant-required policy and the same redaction as the stdout
// stream.
//
// ⚠️ The relative path here — unlike every other file access of the agent —
// comes FROM THE CALLER. It is an operator setting per container and
// therefore cannot be derived at all. The root it is checked against still
// comes solely from the container's labels: it is the directory of THIS
// container, not the global base path (§20.2, R2 in §27.4). Otherwise "add
// log file" would be the way to read from neighbouring containers.
export async function handleLogFile(ctx: ContainerRouteContext): Promise<void> {
  const { response, url, actor, containerId } = ctx;
  const result = await gate(containerId, { mutating: false, action: "logs" });
  if (!result.ok) {
    audit.write({
      action: "log-file",
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
  // ⚠️ The directory comes SOLELY from the labels — without the fallback to
  // `locationFor(name)` that the hardening (hardeningOptionsFor) allows
  // itself. The difference: there the derived path is only an additional
  // barrier, here it would be the permission to READ a file. And the derived
  // location is only a guess: a standalone container named `homepage` would
  // get /home/docker/homepage — the directory of a FOREIGN stack. The same
  // fail-closed rule as in checkEnvAccess (S5b), and for the same reason.
  let composeContext: ReturnType<typeof requiredComposeContextForFileLogs>;
  try {
    composeContext = requiredComposeContextForFileLogs(
      registry.get(containerId),
      result.inspect.Config?.Labels ?? undefined,
      composeBasePath
    );
  } catch (error) {
    audit.write({
      action: "log-file",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "compose-registry-anchor-missing-or-different"
    });
    if (error instanceof EnvRedactionUnavailableError) {
      send(response, 409, { error: "compose-registry-anchor-missing-or-different" });
      return;
    }
    throw error;
  }
  const projectDir = composeContext.projectDir;

  // ⚠️ The self-management lock applies here even when READING — just like
  // for the `.env` (S5b) and unlike for /hardening and /compose.
  //
  // The reason is the same and weighs heavier here: under
  // /home/docker/dashboard-repo and /home/docker/dashboard-state live the DB
  // password, the session secret, the agent shared secret and the audit
  // records. A log file is a way to hand out a file LINE BY LINE.
  if (forcedManagement(projectDir) === "read-only") {
    audit.write({
      action: "log-file",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: `self-management-locked: ${projectDir}`
    });
    send(response, 403, { error: "self-management-locked" });
    return;
  }

  // TRANSITION (#418, reasoning in request-keys.ts): the dashboard asks
  // `log-file?path=`. Without the legacy name (queryObject) the check would
  // run on the empty path and the log file route would reject every request.
  // Goes away as soon as a dashboard from this version on runs everywhere.
  //
  // As for the stdout stream, tail=0 is an explicit "only from now on" for
  // the S15 alert watcher; a value outside 0..MAX_TAIL is refused.
  const query = parseRequest(logFileQuerySchema, queryObject(url));
  if (!query.ok) {
    rejectRequest(ctx, { action: "log-file", containerId, containerName }, query.rejection);
    return;
  }
  const safeTail = query.value.tail;
  const checked = checkLogPath(query.value.path, projectDir);
  if (!checked.ok) {
    // A rejected path is the most interesting entry of this route of all — it
    // goes into the log with its reason, not just as a 400.
    audit.write({
      action: "log-file",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: checked.reason
    });
    send(response, 400, { error: checked.reason });
    return;
  }

  // R3: the same cap as for the stdout stream, for the same reason — a
  // followed file holds a descriptor until the caller leaves. It comes
  // before `secretsFromEnvFile()`, i.e. before the disk work.
  const releaseStreamSlot = openStreams.tryAcquire();
  if (!releaseStreamSlot) {
    audit.write({
      action: "log-file",
      containerId,
      containerName,
      actor,
      outcome: "denied",
      reason: "too-many-streams"
    });
    send(response, 429, { error: "too-many-streams" });
    return;
  }
  // Fallback as for the stdout stream: `close` fires on every path, the
  // release only counts once.
  response.once("close", releaseStreamSlot);


  // The same two sources as for the stdout stream (§16.4 point 1): a log file
  // is not one bit less a secret leak channel than stdout.
  const secrets = [
    ...Object.values(envPlaintextOf(result.inspect.Config?.Env)),
    ...secretsFromEnvFile(projectDir)
  ];

  audit.write({
    action: "log-file",
    containerId,
    containerName,
    actor,
    outcome: "allowed",
    reason: `${checked.relative} (tail=${safeTail})`
  });

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no"
  });
  // ⚠️ The ABSOLUTE path stays in here: it names the structure of the host
  // and this route is also reachable externally via a grant. Only the
  // relative path, which the caller knows anyway, goes outside.
  const streamAbort = new AbortController();
  const onDisconnect = () => streamAbort.abort();
  response.on("close", onDisconnect);
  if (!sendLine(response, { kind: "start", containerName, path: checked.relative } satisfies LogFileStreamLine)) {
    streamAbort.abort();
  }

  try {
    await tailLogFile(
      checked.absolute,
      projectDir,
      { tail: safeTail },
      // Diese Zeile ist NICHT dieselbe Form wie die von logs-stream
      // (DemuxedLine, oben) — vier gemessene Unterschiede, kein
      // Zufall der Feldreihenfolge:
      //
      //  * `ts: null` ist hier ein LITERAL, kein Feld von `LogFileLine`
      //    (log-file.ts, `LogFileLine`) — der Handler schreibt es hin.
      //    Docker stellt bei `timestamps=1` einen RFC3339Nano-Stempel
      //    VOR jede Zeile; eine Datei auf der Platte hat diesen Rahmen
      //    nicht, was an Zeitstempeln drinsteht ist Text der Anwendung
      //    selbst, in unbekanntem Format, und steckt in `text`.
      //    ⚠️ `DemuxedLine.ts` (log-demux.ts) ist `string | null` —
      //    "manchmal ohne Stempel", nicht "nie mit". Der Unterschied
      //    ist also nicht null-gegen-nie-null, sondern
      //    manchmal-null-gegen-IMMER-null: ein Verbraucher, der auf
      //    `ts !== null` prüft, kommt mit beiden Strömen klar; einer,
      //    der `ts` als vorhanden ANNIMMT, fällt schon bei logs-stream.
      //  * Kein `stream`-Feld: `LogFileLine` hat keins. Docker
      //    multiplext stdout/stderr über 8-Byte-Rahmenköpfe
      //    (LogDemuxer); eine Datei ist EIN Bytestrom ohne
      //    Kanalinformation. Es gibt nichts zu setzen — nicht
      //    "weggelassen", sondern "existiert nicht".
      //  * `path` statt `tty` im start-Ereignis oben: `tty` sagt, ob
      //    demultiplext werden musste — bei der Datei gibt es keinen
      //    Rahmen, `tty` wäre dort bedeutungslos. `path` sagt
      //    stattdessen, WELCHE Datei verfolgt wird.
      //  * `partial` kommt dazu und hat keinen Gegenpart bei
      //    logs-stream: die erste gelieferte Zeile kann ein Fragment
      //    sein, weil der Schwanz ab einem BYTE-Offset gelesen wird,
      //    der mitten in einer Zeile liegen kann (log-file.ts,
      //    `lastLinesFrom`). Die Docker-API liefert immer ganze
      //    Rahmen — diesen Fall gibt es dort nicht.
      //
      // Das ist mehr als Kosmetik: ein Verbraucher, der beide Ströme
      // durch denselben Leser schickt, bekommt still `undefined` statt
      // eines Fehlers.
      (line) => {
        if (!sendLine(response, {
          kind: "line",
          ts: null,
          text: redactKnownSecrets(line.text, secrets),
          ...(line.partial ? { partial: true as const } : {})
        } satisfies LogFileStreamLine)) streamAbort.abort();
      },
      streamAbort.signal
    );
  } catch (error) {
    // Getippt auf LogFileFailureReason: die elf Werte aus log-file.ts
    // (Vorgang #82) — ein neuer Wert, den keiner der zwei Zweige
    // liefert, wäre ein Typfehler HIER.
    //
    // Ein Abbruch bekommt KEINE Fehlerzeile mehr (#80) — dieselbe
    // Entscheidung wie an logs-stream und pull-stream, und aus demselben
    // Grund: die Verbindung, auf der sie ankäme, ist gerade zugegangen.
    // `tailLogFile` KEHRT bei einem Abbruch regulär zurück; hierher
    // kommt der Fall nur, wenn zwischen Abbruch und Rückkehr noch ein
    // Fehler geworfen wurde.
    if (error instanceof TailEnded) {
      const reason: LogFileFailureReason = error.reason;
      sendLine(response, { kind: "error", reason } satisfies LogFileStreamLine);
    } else if (!streamAbort.signal.aborted) {
      console.error("[agent] log-file:", error);
      const reason: LogFileFailureReason = "log-file-failed";
      sendLine(response, { kind: "error", reason } satisfies LogFileStreamLine);
    }
  } finally {
    releaseStreamSlot();
    response.off("close", onDisconnect);
  }
  response.end();
  return;
}
