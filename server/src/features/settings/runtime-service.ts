import type { Pool } from "pg";
import { runtimeSettingsSchema, selfHealingSettingsRequestSchema, type SelfHealingSettings } from "contract";
import { readSelfHealingConfig, readSelfHealingDeliveries, writeRuntimeSettings, writeSelfHealingConfig } from "./runtime-store.js";
import type { SelfHealingSync } from "./self-healing-sync.js";

export async function readSelfHealingSettings(pool: Pool): Promise<SelfHealingSettings> {
  const stored = await readSelfHealingConfig(pool);
  return { ...stored, hosts: await readSelfHealingDeliveries(pool, stored.revision) };
}

export async function changeRuntimeSettings(pool: Pool, body: unknown) {
  const parsed = runtimeSettingsSchema.safeParse((body as { runtime?: unknown } | null)?.runtime);
  if (!parsed.success) return null;
  return writeRuntimeSettings(pool, parsed.data);
}

export async function changeSelfHealingSettings(pool: Pool, body: unknown, sync: SelfHealingSync) {
  const parsed = selfHealingSettingsRequestSchema.safeParse((body as { selfHealing?: unknown } | null)?.selfHealing);
  if (!parsed.success) return null;
  await writeSelfHealingConfig(pool, parsed.data.config);
  // Delivery failures must never turn a committed setting into a failed save.
  await sync.syncConnected().catch(() => undefined);
  return readSelfHealingSettings(pool);
}
