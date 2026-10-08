import {
  auditDiscardRequestSchema,
  monitorSyncRequestSchema,
  registrySyncRequestSchema,
  type MonitorEventLine
} from "contract";
import { AGENT_CONTRACT } from "../contract.js";
import {
  EngineError
} from "../engine.js";
import {
  composeLabelsOf,
  toContainerSummary,
  type ContainerSummary
} from "../redact.js";
import { foreignManagementOf } from "../external-management.js";
import { mapLimit } from "../concurrency.js";
import { fromLegacyForms } from "../registry.js";
import { toMonitorStatus } from "../monitor.js";
import { sendLine } from "../ndjson-line.js";
import { forcedManagement } from "../stacks.js";
import { config, engine, registry, monitors, audit, statsHistory, monitorStreams, dockerEvents } from "../runtime/state.js";
import { hardeningOptionsFor, imageManagerLabelOf, volumeBindsOf } from "../runtime/containers.js";
import { send, readJsonBody, parseRequest, rejectRequest, RouteContext } from "../runtime/http.js";

export async function handleContract(ctx: RouteContext): Promise<void> {
  const { response } = ctx;
  response.setHeader("cache-control", "no-store");
  send(response, 200, AGENT_CONTRACT);
  return;
}

// --- Allowlist sync (stage plan 3.4) --------------------------------------
//
// This route writes the list AGAINST which the agent checks everything else:
// `allowed` decides whether a container exists at all, `imageRef` what a
// `pull` may pull, `compose.origin` whether a foreign compose file may be
// overwritten, and `shares` which directory is readable and writable via
// Web FTP. It is therefore more powerful than any single action it
// authorises.
export async function handleRegistrySync(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;
  // ⚠️ A broken entry refuses the WHOLE list (`400`), instead of being
  // dropped silently as before #272: an allowlist the agent shortened on its
  // own, acknowledged with 200, was exactly the silent outage described at
  // `fromLegacyForms` (registry.ts). The legacy forms are read first.
  const body = await readJsonBody(request);
  const sync = parseRequest(registrySyncRequestSchema, {
    ...body,
    entries: Array.isArray(body.entries) ? body.entries.map(fromLegacyForms) : body.entries
  });
  if (!sync.ok) {
    rejectRequest(ctx, { action: "registry-sync", containerId: null, containerName: null }, sync.rejection);
    return;
  }
  registry.replaceAll(sync.value.entries);
  audit.write({
    action: "registry-sync",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `${registry.size()} Eintraege`
  });
  send(response, 200, { ok: true, entries: registry.size() });
  return;
}

// --- Host discovery (only for allowlist maintenance) ----------------------
// The only endpoint that also shows containers that are NOT allowlisted:
// without it the allowlist could only be filled by hand-written SQL. That is
// why it is reduced to id/name/image/status — no env, no mounts.
//
// Plus the two compose labels (project/service), so that the maintenance
// view can show containers that belong together grouped instead of as a
// flat list of two dozen names. ONLY these two, not the whole label map —
// see composeLabelsOf().
export async function handleHostContainers(ctx: RouteContext): Promise<void> {
  const { response, actor } = ctx;
  const listed = await engine.listWithComposeLabels();
  // The hub derives the registry's `externallyManaged` from this field.
  const containers = await mapLimit(listed, 6, async (container) => ({
    id: container.id,
    name: container.name,
    image: container.image,
    status: container.status,
    compose: composeLabelsOf(container.labels),
    externalManagement: foreignManagementOf(
      container.labels,
      await imageManagerLabelOf(container.labels, container.imageId)
    )
  }));
  audit.write({
    action: "host-discovery",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `${containers.length} Container`
  });
  send(response, 200, { containers });
  return;
}

export async function handleContainerList(ctx: RouteContext): Promise<void> {
  const { response } = ctx;
  // Since S13 the list is free of fresh stats calls: CPU/RAM comes from
  // the agent's ten-second ring buffer. Inspect and volume resolution
  // remain the only engine work of this read path.
  const CONTAINER_LIST_CONCURRENCY = 6;
  const withGaps = await mapLimit(
    registry.allowedIds(),
    CONTAINER_LIST_CONCURRENCY,
    async (id): Promise<ContainerSummary | null> => {
      try {
        const inspect = await engine.inspect(id);
        const volumeResolution = await volumeBindsOf(inspect);
        return { ...toContainerSummary(inspect, {
          ...hardeningOptionsFor(id),
          volumeBinds: volumeResolution.binds,
          unresolvedVolumes: volumeResolution.unresolved,
          stats: statsHistory.snapshot(id),
          imageManagerLabel: await imageManagerLabelOf(inspect.Config?.Labels, inspect.Image)
        }), exitCode: inspect.State?.ExitCode ?? null,
          runtimeAccess: { blocker: registry.checkAccess(id, true, false) === "observe-only" ? "observe-only" :
            !registry.isAllowed(id) ? "not-allowlisted" :
              forcedManagement(inspect.Config?.Labels?.["com.docker.compose.project.working_dir"] ?? "") === "read-only"
                ? "self-management-locked" : null } };

      } catch (error) {
        if (error instanceof EngineError && error.status === 404) return null;
        throw error;
      }
    }
  );
  const summaries = withGaps.filter((summary): summary is ContainerSummary => summary !== null);
  send(response, 200, { containers: summaries });
  return;
}

// S13/K2c: only the two values from the Docker engine that are available
// without a host mount. The actual utilisation is only summed up in the
// server from the container stats visible to the respective user.
export async function handleHostInfo(ctx: RouteContext): Promise<void> {
  const { response } = ctx;
  const info = await engine.info();
  send(response, 200, {
    cpuCores: Number.isSafeInteger(info.NCPU) && info.NCPU! > 0 ? info.NCPU : null,
    memTotalBytes: typeof info.MemTotal === "number" && info.MemTotal > 0 ? info.MemTotal : null
  });
  return;
}

// S13/K2b: the main API holds this long-lived stream and, on a
// relevant state change, triggers its existing monitor logic. Raw Docker
// event material (names, labels, attributes) never leaves the agent.
export async function handleMonitorEvents(ctx: RouteContext): Promise<void> {
  const { response, actor } = ctx;
  if (!dockerEvents.isObserving()) {
    audit.write({ action: "monitor-events", containerId: null, containerName: null,
      actor, outcome: "error", reason: "events-unavailable" });
    send(response, 503, { error: "events-unavailable" });
    return;
  }
  // Bound concurrent readers while allowing a reconnecting successor.
  const releaseMonitorSlot = monitorStreams.tryAcquire();
  if (!releaseMonitorSlot) {
    audit.write({
      action: "monitor-events",
      containerId: null,
      containerName: null,
      actor,
      outcome: "denied",
      reason: "too-many-streams"
    });
    send(response, 429, { error: "too-many-streams" });
    return;
  }
  // Fallback as with the reading streams: `close` fires on every path, and
  // the release only counts once — a slot is never lost.
  response.once("close", releaseMonitorSlot);
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-accel-buffering": "no"
  });
  response.flushHeaders();
  await new Promise<void>((resolve) => {
    const unsubscribe = dockerEvents.subscribe((event) => {
      if (registry.isAllowed(event.containerId) || monitors.has(event.containerId, event.containerName)) {
        // Names/labels still stay on the agent host. The name is only used
        // locally for recreate matching.
        sendLine(response, { action: event.action, containerId: event.containerId } satisfies MonitorEventLine);
      }
    }, () => { response.end(); });
    if (response.destroyed) { unsubscribe(); resolve(); }
    else response.once("close", () => { unsubscribe(); resolve(); });
  });
  releaseMonitorSlot();
  response.end();
  return;
}

// --- Watch-only status (Docker monitoring D1) -----------------------------
//
// A separate list of its own (monitors), NOT the allowlist. Deliberately does
// NOT go through gate(): a monitor entry is not a control permission. The
// response is reduced to running/since-when/health/status (W2,
// toMonitorStatus) and names neither names nor image nor any other
// reconnaissance surface.
export async function handleMonitorList(ctx: RouteContext): Promise<void> {
  const { response } = ctx;
  const statuses = [];
  for (const entry of monitors.list()) {
    try {
      const status = toMonitorStatus(await engine.inspect(entry.containerName ?? entry.containerId));
      statuses.push({ ...status, ...(entry.monitorId ? { monitorId: entry.monitorId } : {}) });
    } catch (error) {
      // A vanished container drops out of the list — the main API treats
      // "in the list, but no longer here" as "not running".
      if (error instanceof EngineError && error.status === 404) continue;
      throw error;
    }
  }
  send(response, 200, { monitors: statuses });
  return;
}

// Sync of the watch-only list (analogous to PUT /registry). Separately
// authenticated, not part of the action path. Whoever writes this list
// decides which containers the agent gives information about at all.
export async function handleMonitorSync(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;
  const sync = parseRequest(monitorSyncRequestSchema, await readJsonBody(request));
  if (!sync.ok) {
    rejectRequest(ctx, { action: "monitor-sync", containerId: null, containerName: null }, sync.rejection);
    return;
  }
  monitors.replaceAll(sync.value.entries);
  audit.write({
    action: "monitor-sync",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `${monitors.size()} Eintraege`
  });
  send(response, 200, { ok: true, entries: monitors.size() });
  return;
}

// --- Audit archive: fetch (#30) -------------------------------------------
//
// The audit log deliberately does not rotate, so it grows. That leaves
// exactly two possible endings: a full /state volume (and an agent that no
// longer executes anything without a writable log) or a way to get the
// existing log off the host WITHOUT losing it. This is the first half of
// that way; the second only discards against proof.
//
// What is handed out is a PREFIX with byte count and SHA-256 in the header.
// What the agent keeps writing in the meantime is explicitly not part of
// the handoff — it starts at byte N+1 and stays for the next run.
export async function handleAuditArchive(ctx: RouteContext): Promise<void> {
  const { response, actor } = ctx;
  const handoff = await audit.prepareHandoff();
  if (handoff === null) {
    send(response, 404, { error: "no-log" });
    return;
  }
  // While truncating, the file is replaced — the header would then refer to
  // different bytes than the body. Better a repeatable refusal.
  if (handoff === "already-running") {
    send(response, 409, { error: "already-running" });
    return;
  }
  // ⚠️ The entry is created AFTER the handoff is fixed. It therefore lies
  // behind byte N — and stays on the host when the prefix is discarded.
  // That is exactly why a truncated log does not begin mid-operation
  // without explanation, but with the line that says what was fetched.
  //
  // It means "handed out", not "arrived". The proof of arrival is the
  // call to the second route, and without it nothing happens on the host.
  audit.write({
    action: "audit-archive-fetched",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `${handoff.bytes} B sha256:${handoff.sha256}`
  });
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-length": String(handoff.bytes),
    // The proof belongs in the header and not in an envelope around the
    // data: the body is the log content itself, byte for byte — anything else
    // would be a second format that has to add up when read back.
    "x-audit-bytes": String(handoff.bytes),
    "x-audit-sha256": handoff.sha256,
    "cache-control": "no-store"
  });
  response.flushHeaders();
  if (handoff.bytes === 0) {
    response.end();
    return;
  }
  const stream = audit.readStream(handoff.bytes);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
  return;
}

// --- Audit archive: discard, only against proof (#30) ---------------------
//
// The only place in the whole agent where audit records disappear. It
// requires `{bytes, sha256}` from the handoff and recalculates ITSELF that
// the file still begins with exactly these bytes today. If anything does
// not match, nothing happens.
//
// The caller thereby does not say "delete the log" but "I have a copy of
// exactly these bytes" — and only that can the agent verify.
export async function handleAuditArchiveDiscard(ctx: RouteContext): Promise<void> {
  const { request, response, actor } = ctx;
  // Like every mutating route, behind the kill switch. An agent that is
  // not supposed to change anything on the host right now does not change
  // its log either.
  if (config.readOnly) {
    send(response, 503, { error: "agent-read-only" });
    return;
  }
  const proof = parseRequest(auditDiscardRequestSchema, await readJsonBody(request));
  if (!proof.ok) {
    rejectRequest(ctx, { action: "audit-archive-discarded", containerId: null, containerName: null }, proof.rejection);
    return;
  }
  const { bytes, sha256 } = proof.value;
  const result = await audit.discardPrefix({ bytes, sha256 });
  if (!result.ok) {
    // A rejected truncation is the most interesting entry of this route:
    // either someone is reaching for the log with stale proof, or the
    // dashboard's archiving is lagging behind reality. You want to see
    // both.
    audit.write({
      action: "audit-archive-discarded",
      containerId: null,
      containerName: null,
      actor,
      outcome: "denied",
      reason: `${result.reason} (${bytes} B sha256:${sha256})`
    });
    send(response, result.reason === "no-log" ? 404 : 409, { error: result.reason });
    return;
  }
  // The first entry the truncated log itself receives. Together with the
  // `audit-archive-fetched` before it, the whole operation is recorded:
  // time span (via the two timestamps), bytes, SHA-256, caller.
  audit.write({
    action: "audit-archive-discarded",
    containerId: null,
    containerName: null,
    actor,
    outcome: "allowed",
    reason: `${result.removed} B discarded, ${result.rest} B kept, sha256:${sha256}`
  });
  send(response, 200, {
    ok: true,
    removed: result.removed,
    rest: result.rest,
    auditBytes: audit.sizeBytes(),
    stateFreeBytes: audit.freeSpaceBytes()
  });
  return;
}
