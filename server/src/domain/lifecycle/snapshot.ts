import type { LifecycleSnapshot } from "contract";
import type { AgentTarget, RequestOptions } from "../../platform/agent-transport/protocol.js";
import { actorName, type ReadActorNames } from "./actors.js";
import { readStopIntents, readSelfHealing } from "./agent-client.js";

/** One read per observation source and host; a refusal never becomes an empty, known observation. */
export async function readLifecycleSnapshot(target: AgentTarget, options: RequestOptions,
  settings: Pick<LifecycleSnapshot, "applyDefinition" | "maintenanceDurationSeconds">, readNames?: ReadActorNames): Promise<LifecycleSnapshot> {
  const [stopIntents, selfHealing] = await Promise.allSettled([readStopIntents(target, options), readSelfHealing(target, options)]);
  const intents = stopIntents.status === "fulfilled" ? stopIntents.value : null;
  const ids = [...new Set(intents?.intents.flatMap((entry) => entry.actor?.startsWith("user:") ? [entry.actor.slice(5)] : []) ?? [])];
  const names = ids.length && readNames ? await readNames(ids).catch(() => new Map<string, string>()) : new Map<string, string>();
  return { ...settings,
    stopIntents: intents ? { ...intents, intents: intents.intents.map((entry) => ({ ...entry, actorName: actorName(entry.actor, names) })) } : null,
    selfHealing: selfHealing.status === "fulfilled" ? selfHealing.value : null };
}
