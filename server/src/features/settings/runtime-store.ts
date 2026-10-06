import { runtimeSettingsSchema, selfHealingConfigSchema, type RuntimeSettings, type SelfHealingConfig,
  type SelfHealingDelivery } from "contract";
import type { Pool } from "pg";

export type StoredSelfHealing = { config: SelfHealingConfig; revision: number };

export async function readRuntimeSettings(pool: Pool): Promise<RuntimeSettings> {
  const { rows } = await pool.query<{ apply_compose_definition: boolean }>(
    "SELECT apply_compose_definition FROM runtime_settings WHERE singleton = true"
  );
  return runtimeSettingsSchema.parse({ applyComposeDefinition: rows[0]?.apply_compose_definition });
}

export async function readApplyComposeDefinition(pool: Pool): Promise<boolean> {
  return (await readRuntimeSettings(pool)).applyComposeDefinition;
}

export async function writeRuntimeSettings(pool: Pool, input: RuntimeSettings): Promise<RuntimeSettings> {
  const value = runtimeSettingsSchema.parse(input);
  await pool.query(
    "UPDATE runtime_settings SET apply_compose_definition = $1, updated_at = now() WHERE singleton = true",
    [value.applyComposeDefinition]
  );
  return value;
}

export async function readSelfHealingConfig(pool: Pool): Promise<StoredSelfHealing> {
  const { rows } = await pool.query<{ self_healing_config: unknown; self_healing_revision: number }>(
    "SELECT self_healing_config, self_healing_revision FROM runtime_settings WHERE singleton = true"
  );
  const row = rows[0];
  if (!row) throw new Error("Missing runtime settings");
  return { config: selfHealingConfigSchema.parse(row.self_healing_config), revision: row.self_healing_revision };
}

export async function writeSelfHealingConfig(pool: Pool, input: SelfHealingConfig): Promise<StoredSelfHealing> {
  const config = selfHealingConfigSchema.parse(input);
  const { rows } = await pool.query<{ self_healing_revision: number }>(
    `UPDATE runtime_settings SET self_healing_config = $1::jsonb,
       self_healing_revision = self_healing_revision + 1, updated_at = now()
     WHERE singleton = true RETURNING self_healing_revision`, [JSON.stringify(config)]
  );
  if (!rows[0]) throw new Error("Missing runtime settings");
  return { config, revision: rows[0].self_healing_revision };
}

export async function readSelfHealingDeliveries(pool: Pool, revision: number): Promise<SelfHealingDelivery[]> {
  const { rows } = await pool.query<{
    host_id: string; name: string; applied_revision: number | null;
    status: "synced" | "failed" | null; updated_at: Date | null;
  }>(`SELECT h.id AS host_id, h.name, d.applied_revision, d.status, d.updated_at
      FROM docker_host h LEFT JOIN self_healing_delivery d ON d.host_id = h.id ORDER BY h.name, h.id`);
  return rows.map((row) => ({
    hostId: row.host_id, hostName: row.name,
    status: row.status === "failed" ? "failed" : row.applied_revision === revision ? "synced" : "pending",
    appliedRevision: row.applied_revision, updatedAt: row.updated_at?.toISOString() ?? null
  }));
}

export async function recordSelfHealingDelivery(
  pool: Pool, hostId: string, revision: number, status: "synced" | "failed"
): Promise<void> {
  await pool.query(
    `INSERT INTO self_healing_delivery (host_id, applied_revision, status) VALUES ($1, $2, $3)
     ON CONFLICT (host_id) DO UPDATE SET
       applied_revision = CASE WHEN EXCLUDED.status = 'synced' THEN EXCLUDED.applied_revision
         ELSE self_healing_delivery.applied_revision END,
       status = EXCLUDED.status, updated_at = now()`,
    [hostId, status === "synced" ? revision : null, status]
  );
}
