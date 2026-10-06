import { actorHeaderValue, type Actor } from "../../platform/agent-transport/protocol.js";
import type { HostRecord } from "./host-record.js";
import type { HostCycleOutcome } from "./host-cycle.js";

/** Wait for an older cycle, then share one fresh cycle among waiting callers. */
export function createHostSync(run: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>) {
  const running = new Map<string, { task: Promise<HostCycleOutcome>; actor: string }>();
  return async (record: HostRecord, actor: Actor): Promise<HostCycleOutcome> => {
    const previous = running.get(record.id);
    if (previous) await previous.task.catch(() => undefined);
    const actorKey = actorHeaderValue(actor);
    let fresh = running.get(record.id);
    while (fresh) {
      if (fresh.actor === actorKey) return fresh.task;
      // Different actors need their own audit attribution.
      await fresh.task.catch(() => undefined);
      fresh = running.get(record.id);
    }
    const task = run(record, actor).finally(() => {
      if (running.get(record.id)?.task === task) running.delete(record.id);
    });
    running.set(record.id, { task, actor: actorKey });
    return task;
  };
}
