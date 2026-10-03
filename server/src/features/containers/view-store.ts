import type { Pool } from "pg";

import type { ContainerViewSettings } from "contract";

// The way to the table `container_view_settings`, and nothing else. Pattern
// and reasons as in `features/logs/store.ts`; only what differs is here.

// The shape lives in the contract (`contract/src/api/settings.ts`, #248).
// The default is `false`.
export type { ContainerViewSettings };

export const DEFAULT_CONTAINER_VIEW_SETTINGS: ContainerViewSettings = { showSystem: false };

type ContainerViewRow = { show_system: boolean };

/**
 * ⚠️ STRIKT ein `boolean`, keine Umwandlung — dieselbe Haltung wie
 * `normalizeLogTailLines`. Ein `"false"` als Zeichenkette wäre in JavaScript
 * wahr, und der Hub schaltete genau das Gegenteil dessen ein, was gemeint war.
 */
export function normalizeShowSystem(value: unknown): { ok: true; value: boolean } | { ok: false } {
  return typeof value === "boolean" ? { ok: true, value } : { ok: false };
}

export async function readContainerViewSettings(pool: Pool): Promise<ContainerViewSettings> {
  const { rows } = await pool.query<ContainerViewRow>(
    "SELECT show_system FROM container_view_settings WHERE singleton"
  );
  return rows[0] ? { showSystem: rows[0].show_system } : DEFAULT_CONTAINER_VIEW_SETTINGS;
}

export async function writeContainerViewSettings(
  pool: Pool,
  settings: ContainerViewSettings
): Promise<ContainerViewSettings> {
  const { rows } = await pool.query<ContainerViewRow>(
    `INSERT INTO container_view_settings (show_system, singleton)
     VALUES ($1, true)
     ON CONFLICT (singleton) DO UPDATE
        SET show_system = EXCLUDED.show_system,
            updated_at = now()
     RETURNING show_system`,
    [settings.showSystem]
  );
  return { showSystem: rows[0].show_system };
}
