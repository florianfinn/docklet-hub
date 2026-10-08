import { recoverDataOperations } from "../data-recovery.js";
import { gate } from "./gate.js";
import { dataJournal, resumeAfterData } from "./backups.js";
import { appendRecoveryIncident } from "../update-recovery.js";
import { containerIdsForTarget } from "../routes/contract-route-stubs.js";
import path from "node:path";
import { UpdateJournal, recoverUpdateRemnants } from "../update-recovery.js";
import { UpdateRecoveryController } from "../update-recovery-controller.js";
import { stopIntentTarget } from "../stop-intent.js";
import type { RawInspect } from "../engine.js";
import { config, engine, registry, selfHealingState, dockerEvents, audit, stackLocks, stopIntents } from "./state.js";
import { composeBasePath } from "./containers.js";

export const updateJournal = new UpdateJournal(path.join(path.dirname(config.registryFile), "update-pending.json"));
let lastFailureAudit: { reason: string; at: number } | null = null;
export const updateRecovery = new UpdateRecoveryController({
  pending: () => [...updateJournal.read(), ...dataJournal.read()].map((entry) => entry.target),
  async recover() {
    await recoverDataOperations({ journal: dataJournal, locks: stackLocks, known: containerIdsForTarget,
      async inspect(id, budget) {
        const result = await gate(id, { mutating: true, action: "restore", actor: null, budget });
        if (!result.ok) throw new Error("data-recovery-denied");
        return result.inspect;
      },
      resume: resumeAfterData, intentional: (raw) => stopIntents.beginUpdate([raw]),
      interrupted(target, id, message) {
        appendRecoveryIncident(selfHealingState, target, id, message); dockerEvents.notifyLifecycleChange(id);
      }
    });
    await recoverUpdateRemnants({ engine, registry, journal: updateJournal, state: selfHealingState, basePath: composeBasePath,
      notify: (id) => dockerEvents.notifyLifecycleChange(id) });
  },
  failed(error, retryMs) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? error.code : null;
    const reason = `${error instanceof Error ? error.name : "Error"}${code ? ` (${code})` : ""}`;
    console.error(`[agent] update recovery failed: ${reason}; retry in ${retryMs} ms`);
    if (lastFailureAudit?.reason === reason && Date.now() - lastFailureAudit.at < 15 * 60_000) return;
    lastFailureAudit = { reason, at: Date.now() };
    audit.write({ action: "update-recovery", containerId: null, containerName: null, actor: null,
      outcome: "error", reason: `${reason}; retry in ${retryMs} ms` });
  }
});
export const recoveryBlocksHealing = (raw: RawInspect): boolean => {
  const entry = registry.get(raw.Id);
  const stable = entry?.compose?.projectName ? { kind: "compose" as const, projectName: entry.compose.projectName, serviceName: entry.compose.serviceName }
    : entry ? { kind: "container" as const, containerName: entry.containerName } : null;
  return updateRecovery.blocks(stable) || updateRecovery.blocks(stopIntentTarget(raw));
};
