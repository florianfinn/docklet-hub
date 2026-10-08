import { updatePreviewRequestSchema, updateStartRequestSchema, updateTargetSchema, updateContainerSettingsSchema,
  type UpdateTarget, type AgentJobsQuery } from "contract";
import type { Pool } from "pg";
import type { HostRouteRequest, HostRouteAccessResult, ContainerAccessRequest, ContainerAccessResult } from "../../domain/hosts/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { readUpdateSetting, writeUpdateSetting } from "./store.js";
import * as client from "./agent-client.js";

export function rejectUpdate(status: number, error: string): never {
  throw new AgentError("Update-Anfrage abgelehnt.", status, { detail: { error } });
}
export function createUpdatesService(deps: {
  pool: Pool;
  openHost: (ref: HostRouteRequest, writing: "reads" | "writes") => Promise<HostRouteAccessResult>;
  openContainer: (ref: ContainerAccessRequest, writing: "reads" | "writes") => Promise<ContainerAccessResult>;
  agent?: typeof client;
}) {
  const agent = deps.agent ?? client;
  async function access(ref: HostRouteRequest, writing: "reads" | "writes") {
    const opened = await deps.openHost(ref, writing);
    if (!opened.ok) {
      if (opened.failure.kind === "agent-error") throw opened.failure.error;
      rejectUpdate(opened.failure.status, opened.failure.error);
    }
    return opened.access;
  }
  async function selection(ref: HostRouteRequest, target: UpdateTarget, id: string) {
    const opened = await deps.openContainer({ ...ref, containerId: id }, "writes");
    if (!opened.ok) {
      if (opened.failure.kind === "agent-error") throw opened.failure.error;
      rejectUpdate(opened.failure.status, opened.failure.error);
    }
    const container = opened.access.container;
    if (target.kind === "container" ? container.name !== target.containerName || Boolean(container.compose)
      : container.compose?.project !== target.projectName || container.compose.service !== target.serviceName) rejectUpdate(409, "state-changed");
    return opened.access;
  }
  return {
    async preview(ref: HostRouteRequest, raw: unknown) {
      const parsed = updatePreviewRequestSchema.safeParse(raw); if (!parsed.success) rejectUpdate(400, "invalid-request");
      const opened = await access(ref, "writes");
      const services = await Promise.all(parsed.data.services.map(async (service) => {
        await selection(ref, service.target, service.expectedContainer.containerId);
        return { ...service, ...await readUpdateSetting(deps.pool, ref.hostId, service.target) };
      }));
      return agent.preview(opened.target, { ...parsed.data, services }, opened.options);
    },
    async start(ref: HostRouteRequest, raw: unknown) {
      const parsed = updateStartRequestSchema.safeParse(raw); if (!parsed.success) rejectUpdate(400, "invalid-request");
      const opened = await access(ref, "writes");
      for (const service of parsed.data.services) {
        await selection(ref, service.target, service.expectedContainer.containerId);
        const setting = await readUpdateSetting(deps.pool, ref.hostId, service.target);
        if (setting.startDeadlineSeconds !== service.startDeadlineSeconds) rejectUpdate(409, "update-preview-stale");
      }
      return agent.start(opened.target, parsed.data, opened.options);
    },
    async list(ref: HostRouteRequest, query: AgentJobsQuery) {
      const opened = await access(ref, "reads"); const jobs = await agent.list(opened.target, query, opened.options);
      return jobs;
    },
    async progress(ref: HostRouteRequest, id: string) {
      const opened = await access(ref, "reads"); return agent.progress(opened.target, id, opened.options);
    },
    async cancel(ref: HostRouteRequest, id: string) {
      const opened = await access(ref, "writes"); return agent.cancel(opened.target, id, opened.options);
    },
    async setting(ref: ContainerAccessRequest, rawTarget: unknown, input?: unknown) {
      const parsed = updateTargetSchema.safeParse(rawTarget); if (!parsed.success) rejectUpdate(400, "invalid-request");
      await selection(ref, parsed.data, ref.containerId);
      if (input !== undefined) {
        if (!updateContainerSettingsSchema.safeParse(input).success) rejectUpdate(400, "invalid-request");
        return writeUpdateSetting(deps.pool, ref.hostId, parsed.data, input);
      }
      return readUpdateSetting(deps.pool, ref.hostId, parsed.data);
    }
  };
}
