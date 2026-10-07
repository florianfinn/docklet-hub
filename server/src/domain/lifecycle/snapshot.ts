import type { LifecycleSnapshot } from "contract";
import type { AgentTarget, RequestOptions } from "../../platform/agent-transport/protocol.js";
import { readStopIntents, readSelfHealing } from "./agent-client.js";

/** One read per observation source and host; a refusal never becomes an empty, known observation. */
export async function readLifecycleSnapshot(target: AgentTarget, options: RequestOptions,
  settings: Pick<LifecycleSnapshot, "applyDefinition" | "maintenanceDurationSeconds">): Promise<LifecycleSnapshot> {
  const [stopIntents, selfHealing] = await Promise.allSettled([readStopIntents(target, options), readSelfHealing(target, options)]);
  return { ...settings,
    stopIntents: stopIntents.status === "fulfilled" ? stopIntents.value : null,
    selfHealing: selfHealing.status === "fulfilled" ? selfHealing.value : null };
}
