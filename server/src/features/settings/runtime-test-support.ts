import { DEFAULT_SELF_HEALING_CONFIG, type SelfHealingConfig } from "contract";
import type { Pool } from "pg";

export function runtimePool() {
  const state = { applyComposeDefinition: true, config: structuredClone(DEFAULT_SELF_HEALING_CONFIG), revision: 1 };
  const writes: unknown[][] = [];
  const deliveries = new Map<string, { applied_revision: number | null; status: "synced" | "failed"; updated_at: Date }>();
  const hosts = [{ id: "demo-host", name: "Demo" }];
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("SELECT apply_compose_definition")) return { rows: [{ apply_compose_definition: state.applyComposeDefinition }] };
    if (sql.startsWith("SELECT self_healing_config")) return { rows: [{ self_healing_config: state.config, self_healing_revision: state.revision }] };
    if (sql.startsWith("UPDATE runtime_settings SET apply_compose_definition")) {
      writes.push(values); state.applyComposeDefinition = values[0] as boolean; return { rows: [] };
    }
    if (sql.startsWith("UPDATE runtime_settings SET self_healing_config")) {
      writes.push(values); state.config = JSON.parse(values[0] as string) as SelfHealingConfig;
      state.revision += 1; return { rows: [{ self_healing_revision: state.revision }] };
    }
    if (sql.includes("FROM docker_host h LEFT JOIN self_healing_delivery")) return { rows: hosts.map((host) => {
      const row = deliveries.get(host.id);
      return { host_id: host.id, name: host.name, applied_revision: row?.applied_revision ?? null,
        status: row?.status ?? null, updated_at: row?.updated_at ?? null };
    }) };
    if (sql.includes("INSERT INTO self_healing_delivery")) {
      const hostId = values[0] as string;
      const status = values[2] as "synced" | "failed";
      deliveries.set(hostId, { applied_revision: status === "synced" ? values[1] as number : deliveries.get(hostId)?.applied_revision ?? null,
        status, updated_at: new Date("2026-10-06T12:00:00Z") });
      return { rows: [] };
    }
    throw new Error("Unexpected test query");
  };
  return { pool: { query } as unknown as Pool, state, writes, deliveries };
}
