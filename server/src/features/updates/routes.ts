import type { Router, Response } from "express";
import { agentJobsQuerySchema, UPDATE_ERRORS, BACKUP_ERRORS, FILE_ACCESS_ERRORS } from "contract";
import { createHostAccess, openHostAccess, openContainerAccess, resolveProbeHost, type HostRepository,
  type HostRecord, type AgentHealth } from "../../domain/hosts/index.js";
import type { Pool } from "pg";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { agentFailureReason } from "../../platform/agent-transport/stream-rejection.js";
import { createUpdatesService } from "./service.js";

const errors = new Set<string>([...UPDATE_ERRORS, ...BACKUP_ERRORS, ...FILE_ACCESS_ERRORS,
  "agent-read-only", "observe-only", "externally-managed", "self-management-locked", "not-allowlisted",
  "invalid-request", "host-unknown", "host-unreachable", "agent-outdated", "runtime-invalid-response", "runtime-outcome-unknown"]);
function rejection(error: unknown, response: Response): void {
  const reason = error instanceof AgentError ? agentFailureReason(error) : null;
  response.status(error instanceof AgentError ? error.status ?? 502 : 500)
    .json({ error: reason && errors.has(reason) ? reason : "runtime-agent-failed" });
}
export function registerUpdateRoutes(router: Router, options: {
  auth: Auth; pool: Pool; repository: HostRepository; agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
}) {
  const hosts = createHostAccess(options); const probe = resolveProbeHost(options);
  const service = createUpdatesService({ pool: options.pool,
    openHost: (ref, writing) => openHostAccess({ hosts, probe }, ref, writing),
    openContainer: (ref, writing) => openContainerAccess({ hosts, probe }, ref, writing) });
  const handler = (operation: "preview" | "start" | "list" | "progress" | "cancel" | "setting" | "backups" | "restorePreview" | "restoreStart") =>
    withSession(options.auth, async (request, response, user) => {
      response.setHeader("Cache-Control", "no-store");
      const ref = { hostId: String(request.params.hostId), userId: user.id };
      try {
        if (operation === "backups") { response.json(await service.backups({ ...ref, containerId: String(request.params.containerId) })); return; }
        if (operation === "restorePreview" || operation === "restoreStart") { response.json(await service[operation](ref, request.body)); return; }
        if (operation === "preview" || operation === "start") { response.json(await service[operation](ref, request.body)); return; }
        if (operation === "progress" || operation === "cancel") {
          response.json(await service[operation](ref, String(request.params.jobId))); return;
        }
        if (operation === "setting") {
          let target: unknown;
          try { target = request.method === "GET" ? JSON.parse(String(request.query.target)) : request.body?.target; }
          catch { response.status(400).json({ error: "invalid-request" }); return; }
          response.json(await service.setting({ ...ref, containerId: String(request.params.containerId) }, target,
            request.method === "GET" ? undefined : request.body?.settings)); return;
        }
        let target: unknown;
        try { target = request.query.target ? JSON.parse(String(request.query.target)) : undefined; }
        catch { response.status(400).json({ error: "invalid-request" }); return; }
        const query = agentJobsQuerySchema.safeParse({ target, kind: request.query.kind });
        if (!query.success) { response.status(400).json({ error: "invalid-request" }); return; }
        response.json(await service.list(ref, query.data));
      } catch (error) { rejection(error, response); }
    });
  router.get("/hosts/:hostId/containers/:containerId/backups", requireAdmin(options.auth), handler("backups"));
  router.post("/hosts/:hostId/restore-previews", requireAdmin(options.auth), handler("restorePreview"));
  router.post("/hosts/:hostId/restores", requireAdmin(options.auth), handler("restoreStart"));
  router.post("/hosts/:hostId/update-previews", requireAdmin(options.auth), handler("preview"));
  router.post("/hosts/:hostId/updates", requireAdmin(options.auth), handler("start"));
  router.get("/hosts/:hostId/jobs", requireAdmin(options.auth), handler("list"));
  router.get("/hosts/:hostId/jobs/:jobId", requireAdmin(options.auth), handler("progress"));
  router.post("/hosts/:hostId/jobs/:jobId/cancel", requireAdmin(options.auth), handler("cancel"));
  router.get("/hosts/:hostId/containers/:containerId/update-settings", requireAdmin(options.auth), handler("setting"));
  router.put("/hosts/:hostId/containers/:containerId/update-settings", requireAdmin(options.auth), handler("setting"));
}
