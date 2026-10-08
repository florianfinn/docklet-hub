import path from "node:path";
import { UpdateJournal, recoverUpdateRemnants } from "../update-recovery.js";
import { UpdateRecoveryController } from "../update-recovery-controller.js";
import { stopIntentTarget } from "../stop-intent.js";
import type { RawInspect } from "../engine.js";
import { config, engine, registry, selfHealingState, dockerEvents, audit } from "./state.js";
import { composeBasePath } from "./containers.js";

export const updateJournal = new UpdateJournal(path.join(path.dirname(config.registryFile), "update-pending.json"));
export const updateRecovery = new UpdateRecoveryController({
  pending: () => updateJournal.read().map((entry) => entry.target),
  recover: () => recoverUpdateRemnants({ engine, registry, journal: updateJournal, state: selfHealingState, basePath: composeBasePath,
    notify: (id) => dockerEvents.notifyLifecycleChange(id) }),
  failed(error, retryMs) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? error.code : null;
    const reason = `${error instanceof Error ? error.name : "Error"}${code ? ` (${code})` : ""}`;
    console.error(`[agent] update recovery failed: ${reason}; retry in ${retryMs} ms`);
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
