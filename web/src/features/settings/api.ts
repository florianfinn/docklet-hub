import { runtimeSettingsResponseSchema, selfHealingSettingsResponseSchema, settingsSchema,
  type RuntimeSettings, type SelfHealingConfig } from "contract";
import { request, putJson, parseResponse } from "../../platform/http/transport";

export async function fetchRuntimeSettings() {
  const settings = parseResponse("/api/settings", settingsSchema, await request("/api/settings"));
  return { runtime: settings.runtime, selfHealing: settings.selfHealing };
}
export async function setRuntimeSettings(runtime: RuntimeSettings) {
  return parseResponse("/api/settings/runtime", runtimeSettingsResponseSchema,
    await putJson("/api/settings/runtime", { runtime }));
}
export async function setSelfHealingSettings(config: SelfHealingConfig) {
  return parseResponse("/api/settings/self-healing", selfHealingSettingsResponseSchema,
    await putJson("/api/settings/self-healing", { selfHealing: { config } }));
}
