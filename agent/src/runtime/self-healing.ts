import { SELF_HEALING_SYSTEM_ACTOR } from "contract";
import { SelfHealingController } from "../self-healing.js";
import { runContainerAction } from "../container-action.js";
import { healingEvidence } from "../self-healing-evidence.js";
import { actionFailureOf } from "../action-failure.js";
import { EngineError } from "../engine.js";
import { selfHealingState, selfHealingConfig, engine, registry, config, audit, dockerEvents } from "./state.js";
import { gate } from "./gate.js";

export const selfHealing = new SelfHealingController(selfHealingState, {
  config: () => selfHealingConfig.read(),
  async check(id) {
    try {
      // Eligibility is observation; any later action gathers its own delegation evidence once.
      const result = await gate(id, { mutating: true, action: "start", actor: SELF_HEALING_SYSTEM_ACTOR, onDelegation: () => {} });
      return result.ok ? result.inspect : null;
    } catch (error) {
      const failure = actionFailureOf(error, true);
      audit.write({ action: "start", containerId: id, containerName: null, actor: SELF_HEALING_SYSTEM_ACTOR,
        outcome: "denied", reason: failure.auditReason });
      return null;
    }
  },
  async inspect(id) {
    try { return await engine.inspect(id); }
    catch (error) { if (error instanceof EngineError && error.status === 404) return null; throw error; }
  },
  start: (id, expected, signal, reserve) => runContainerAction(id, "start", expected, SELF_HEALING_SYSTEM_ACTOR, signal, reserve),
  evidence: (container, cause) => healingEvidence(container, cause, registry.get(container.Id), config.bindBasePath,
    (id, tail, tty) => engine.logs(id, tail, tty))
});

let timer: ReturnType<typeof setInterval> | null = null;
export function startSelfHealing(): void {
  if (timer) return;
  dockerEvents.attachLifecycle(selfHealing);
  timer = setInterval(() => {
    void selfHealing.tick().catch((error: unknown) => {
      console.error("[agent] self-healing state unavailable:", error);
    });
  }, 1000);
  timer.unref();
}
export function stopSelfHealing(): void {
  if (timer) clearInterval(timer);
  timer = null;
  selfHealing.setObserving(false);
}
