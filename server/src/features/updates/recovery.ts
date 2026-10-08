import type { AgentJobsResponse } from "contract";
import type { HostRecord } from "../../domain/hosts/index.js";
import type { AgentTarget } from "../../platform/agent-transport/protocol.js";
import { list } from "./agent-client.js";

// The live reconnect and reachability probe both discover jobs without remembered IDs.
export function createUpdateRecovery(deps: { connect: (host: HostRecord) => Promise<AgentTarget> }) {
  const pending = new Map<string, Promise<AgentJobsResponse>>();
  return {
    syncHost(host: HostRecord): Promise<AgentJobsResponse> {
      const running = pending.get(host.id); if (running) return running;
      const task = (async () => {
        return list(await deps.connect(host), { kind: "update" }, { actor: { kind: "system", name: "hub" } });
      })().finally(() => pending.delete(host.id));
      pending.set(host.id, task); return task;
    }
  };
}
