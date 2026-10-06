import { SELF_HEALING_ACTOR, selfHealingConfigResponseSchema, type SelfHealingConfig } from "contract";
import { agentPut, type AgentTarget } from "../../platform/agent-transport/protocol.js";

export async function sendSelfHealingConfig(target: AgentTarget, config: SelfHealingConfig): Promise<void> {
  const response = selfHealingConfigResponseSchema.parse(await agentPut(target, "/self-healing/config", config,
    { actor: { kind: "system", name: SELF_HEALING_ACTOR.slice("system:".length) }, timeoutMs: 3000 }));
  if (JSON.stringify(response.config) !== JSON.stringify(config)) throw new Error("Self-healing acknowledgement differs");
}
