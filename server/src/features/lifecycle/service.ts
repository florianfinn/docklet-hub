import { selfHealingMaintenanceRequestSchema, selfHealingMaintenanceDeleteSchema, selfHealingTargetRequestSchema } from "contract";
import type { HostRouteRequest, HostRouteAccessResult } from "../../domain/hosts/index.js";
import type { LiveEvents, RefreshTarget } from "../../domain/live-events/index.js";
import { readStopIntents, readSelfHealing, writeLifecycle } from "../../domain/lifecycle/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";

export type LifecycleOperation = "maintenance-on" | "maintenance-off" | "acknowledge";
function reject(status: number, error: string): never {
  throw new AgentError("Lifecycle-Anfrage abgelehnt.", status, { detail: { error } });
}
export function createLifecycleService(deps: {
  openHost: (ref: HostRouteRequest, writing: "reads" | "writes") => Promise<HostRouteAccessResult>;
  liveEvents?: Pick<LiveEvents, "refresh">;
  agent?: { readStopIntents: typeof readStopIntents; readSelfHealing: typeof readSelfHealing; writeLifecycle: typeof writeLifecycle };
}) {
  const agent = deps.agent ?? { readStopIntents, readSelfHealing, writeLifecycle };
  async function access(ref: HostRouteRequest, writing: "reads" | "writes") {
    const opened = await deps.openHost(ref, writing);
    if (!opened.ok) {
      if (opened.failure.kind === "agent-error") throw opened.failure.error;
      reject(opened.failure.status, opened.failure.error === "host-unreachable" ? "runtime-host-offline" : opened.failure.error);
    }
    return opened.access;
  }
  return {
    read: async (ref: HostRouteRequest, kind: "stop-intents" | "self-healing") => {
      const opened = await access(ref, "reads");
      return kind === "stop-intents" ? agent.readStopIntents(opened.target, opened.options)
        : agent.readSelfHealing(opened.target, opened.options);
    },
    write: async (ref: HostRouteRequest, operation: LifecycleOperation, raw: unknown) => {
      const schema = operation === "maintenance-on" ? selfHealingMaintenanceRequestSchema
        : operation === "maintenance-off" ? selfHealingMaintenanceDeleteSchema : selfHealingTargetRequestSchema;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) reject(400, "invalid-input");
      const opened = await access(ref, "writes");
      const target = parsed.data.target;
      const refresh: RefreshTarget = target.kind === "container" ? { host: true } : { project: target.projectName };
      try { return await agent.writeLifecycle(opened.target, operation, parsed.data, opened.options); }
      finally { void deps.liveEvents?.refresh(ref.hostId, refresh).catch(() => undefined); }
    }
  };
}
