import type { Request, Response, Router } from "express";
import type { Pool } from "pg";
import { runtimeActionSchema } from "contract";
import { createHostAccess, openContainerAccess, resolveProbeHost, type HostRepository,
  type HostRecord, type AgentHealth } from "../../domain/hosts/index.js";
import type { LiveEvents } from "../../domain/live-events/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { relayAgentStream } from "../../platform/streams/agent-stream-relay.js";
import { createRuntimeActionsService } from "./service.js";
import { runtimeRejection } from "./rejections.js";

export type RuntimeActionsRouteOptions = {
  auth: Auth; pool: Pool; repository: HostRepository; agentSecret: string;
  readApplyDefinition: () => Promise<boolean>;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
  liveEvents?: LiveEvents;
};

export function registerRuntimeActionsRoutes(router: Router, options: RuntimeActionsRouteOptions) {
  const hosts = createHostAccess(options);
  const probe = resolveProbeHost(options);
  const service = createRuntimeActionsService({
    openContainer: (ref) => openContainerAccess({ hosts, probe }, ref, "writes"),
    readApplyDefinition: options.readApplyDefinition,
    ...(options.liveEvents ? { liveEvents: options.liveEvents } : {})
  });
  const rejection = (error: AgentError, response: Response, stack: boolean) => {
    const result = runtimeRejection(error, stack);
    response.status(result.status).json(result.body);
  };
  const handler = (stack = false) => withSession(options.auth, async (request: Request, response, user) => {
    response.setHeader("Cache-Control", "no-store");
    const parsed = runtimeActionSchema.safeParse(request.params.action);
    if (!parsed.success) { response.status(400).json({ error: "invalid-input" }); return; }
    const action = parsed.data;
    const ref = { hostId: String(request.params.hostId), containerId: String(request.params.containerId), userId: user.id };
    if (stack) {
      await relayAgentStream(request, response, {
        brokenEvent: { kind: "error", reason: "runtime-stream-broken" },
        translateError: (error, answer) => rejection(error, answer, true)
      }, async (relay) => { await service.execute(ref, action, request.body, relay.signal, relay); });
      return;
    }
    const caller = new AbortController();
    const abort = () => { if (!response.writableFinished) caller.abort(); };
    response.on("close", abort);
    if (response.destroyed) abort();
    try {
      const result = await service.execute(ref, action, request.body, caller.signal);
      if (!caller.signal.aborted) response.json(result);
    } catch (error) {
      if (caller.signal.aborted) return;
      if (!(error instanceof AgentError)) throw error;
      rejection(error, response, false);
    } finally { response.off("close", abort); }
  });
  router.post("/hosts/:hostId/containers/:containerId/:action", requireAdmin(options.auth), handler());
  router.post("/hosts/:hostId/stacks/:containerId/actions/:action", requireAdmin(options.auth), handler(true));
}
