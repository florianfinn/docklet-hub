import { UPDATE_START_DEADLINE_SECONDS, updateContainerSettingsSchema, type UpdateTarget,
  type UpdateContainerSettings } from "contract";
import type { Pool } from "pg";

export function updateSettingKey(target: UpdateTarget): string {
  return target.kind === "container" ? JSON.stringify(["container", target.containerName])
    : JSON.stringify(["compose", target.projectName, target.serviceName]);
}
export async function readUpdateSetting(pool: Pool, hostId: string, target: UpdateTarget): Promise<UpdateContainerSettings> {
  const { rows } = await pool.query<{ start_deadline_seconds: number }>(
    "SELECT start_deadline_seconds FROM container_update_setting WHERE host_id = $1 AND target_key = $2", [hostId, updateSettingKey(target)]);
  return updateContainerSettingsSchema.parse({ startDeadlineSeconds: rows[0]?.start_deadline_seconds ?? UPDATE_START_DEADLINE_SECONDS.default });
}
export async function writeUpdateSetting(pool: Pool, hostId: string, target: UpdateTarget, input: unknown): Promise<UpdateContainerSettings> {
  const setting = updateContainerSettingsSchema.parse(input);
  await pool.query(`INSERT INTO container_update_setting (host_id, target_key, start_deadline_seconds) VALUES ($1, $2, $3)
    ON CONFLICT (host_id, target_key) DO UPDATE SET start_deadline_seconds = EXCLUDED.start_deadline_seconds`,
  [hostId, updateSettingKey(target), setting.startDeadlineSeconds]);
  return setting;
}
