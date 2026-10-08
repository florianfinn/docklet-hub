import type { Pool } from "pg";
import type { HostRecord } from "../../domain/hosts/index.js";
import type { AgentTarget } from "../../platform/agent-transport/protocol.js";
import { list } from "./agent-client.js";
import { recordUpdateJobs } from "./store.js";

// The live reconnect and reachability probe both discover jobs without remembered IDs.
export function createUpdateRecovery(deps: { pool: Pool; connect: (host: HostRecord) => Promise<AgentTarget> }) {
  const pending = new Map<string, Promise<void>>();
  return {
    syncHost(host: HostRecord): Promise<void> {
      const running = pending.get(host.id); if (running) return running;
      const task = (async () => {
        const jobs = await list(await deps.connect(host), { kind: "update" }, { actor: { kind: "system", name: "hub" } });
        await recordUpdateJobs(deps.pool, host.id, jobs);
      })().finally(() => pending.delete(host.id));
      pending.set(host.id, task); return task;
    }
  };
}
