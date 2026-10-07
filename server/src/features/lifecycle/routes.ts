import type { Router, Response } from "express";
import type { Pool } from "pg";
import { createHostAccess, openHostAccess, resolveProbeHost, type HostRecord, type AgentHealth, type HostRepository }
  from "../../domain/hosts/index.js";
import type { LiveEvents } from "../../domain/live-events/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { withSession } from "../../platform/auth/session.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { agentFailureReason } from "../../platform/agent-transport/stream-rejection.js";
import { createLifecycleService, type LifecycleOperation } from "./service.js";

const ERRORS = new Set(["invalid-input", "invalid-request", "invalid-json", "actor-not-allowed", "agent-outdated", "host-unknown",
  "runtime-host-offline", "lifecycle-invalid-response", "lifecycle-observation-unavailable", "internal-error"]);
function rejection(error: unknown, response: Response) {
  const reason = error instanceof AgentError ? agentFailureReason(error) : null;
  const key = reason && ERRORS.has(reason) ? reason : error instanceof AgentError && error.status === 503
    ? "lifecycle-observation-unavailable" : error instanceof AgentError && error.status === null
      ? "runtime-agent-unreachable" : "lifecycle-agent-failed";
  response.status(error instanceof AgentError ? error.status ?? 502 : 500).json({ error: key });
}
export type LifecycleRouteOptions = {
  auth: Auth; pool: Pool; repository: HostRepository; agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>; liveEvents?: LiveEvents;
};
export function registerLifecycleRoutes(router: Router, options: LifecycleRouteOptions) {
  const hosts = createHostAccess(options);
  const probe = resolveProbeHost(options);
  const service = createLifecycleService({ openHost: (ref, writing) => openHostAccess({ hosts, probe }, ref, writing),
    ...(options.liveEvents ? { liveEvents: options.liveEvents } : {}) });
  const read = (kind: "stop-intents" | "self-healing") => withSession(options.auth, async (request, response, user) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      const result = await service.read({ hostId: String(request.params.hostId), userId: user.id }, kind);
      response.status(result.observing ? 200 : 503).json(result);
    } catch (error) { rejection(error, response); }
  });
  router.get("/hosts/:hostId/stop-intents", read("stop-intents"));
  router.get("/hosts/:hostId/self-healing/status", read("self-healing"));
  const write = (operation: LifecycleOperation) => withSession(options.auth, async (request, response, user) => {
    response.setHeader("Cache-Control", "no-store");
    try { response.json(await service.write({ hostId: String(request.params.hostId), userId: user.id }, operation, request.body)); }
    catch (error) { rejection(error, response); }
  });
  router.put("/hosts/:hostId/self-healing/maintenance", requireAdmin(options.auth), write("maintenance-on"));
  router.delete("/hosts/:hostId/self-healing/maintenance", requireAdmin(options.auth), write("maintenance-off"));
  router.post("/hosts/:hostId/self-healing/incidents/acknowledge", requireAdmin(options.auth), write("acknowledge"));
}
