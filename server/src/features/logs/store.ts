import type { Pool } from "pg";

import { LOG_TAIL_LINE_OPTIONS, type LogSettings, type LogTailLines } from "contract";

// Der Weg zur Tabelle `log_settings` — und sonst nichts. Muster und
// Begründungen wie in `domain/hosts/hub-network-store.ts`; hier steht nur, was
// anders ist.

// The shape, the four allowed values and the reason they stop at 2000 live
// in the contract (`contract/src/api/settings.ts`, #248): the web builds its
// picker from the same list the server checks input against.
//
// One setting of the hub and not one per arm. The hub sends this value as
// `tail` with EVERY request to the agent, so the agent's own default never
// applies (200, `DEFAULT_LOG_TAIL_LINES` in `agent/src/log-tail.ts`).
export { LOG_TAIL_LINE_OPTIONS };
export type { LogSettings, LogTailLines };

/**
 * Die Vorgabe des Leitstands: der kleinste der vier Werte, der für eine
 * Fehlersuche mehr als einen Bildschirm zeigt.
 */
export const DEFAULT_LOG_TAIL_LINES: LogTailLines = 500;

export const DEFAULT_LOG_SETTINGS: LogSettings = { tailLines: DEFAULT_LOG_TAIL_LINES };

type LogSettingsRow = { tail_lines: number };

/**
 * Bildet einen unbekannten Wert auf die Liste der vier erlaubten ab — oder
 * lehnt ihn ab.
 *
 * ⚠️ Ein Treffer oder gar nichts. Ein Wert, der die Liste nicht trifft, wird
 * NICHT stillschweigend auf die Vorgabe gezogen — sonst quittiert der Hub
 * eine Einstellung, die er gar nicht übernommen hat, und der Betreiber merkt
 * es erst beim nächsten Blick in die Logansicht.
 *
 * ⚠️ STRIKTE Typprüfung, keine Umwandlung: eine Zeichenkette `"500"` wird
 * abgelehnt und nicht in eine Zahl umgewandelt. Dieselbe Haltung wie bei
 * `normalizeExternalEndpoint` (dort: nur `string`, hier: nur `number`) — ein
 * JSON-Rumpf, der eine Zahl meint, schickt eine Zahl. Eine Umwandlung öffnete
 * die Tür für Werte wie `"500e0"` oder `"  500  "`, die zwar auf 500
 * abbildeten, aber nichts mehr über den ursprünglichen Rumpf verrieten.
 */
export function normalizeLogTailLines(value: unknown): { ok: true; value: LogTailLines } | { ok: false } {
  if (typeof value !== "number") return { ok: false };
  if (!Number.isFinite(value)) return { ok: false };
  const match = LOG_TAIL_LINE_OPTIONS.find((option) => option === value);
  if (match === undefined) return { ok: false };
  return { ok: true, value: match };
}

export async function readLogSettings(pool: Pool): Promise<LogSettings> {
  const { rows } = await pool.query<LogSettingsRow>("SELECT tail_lines FROM log_settings WHERE singleton");
  return rows[0] ? { tailLines: rows[0].tail_lines } : DEFAULT_LOG_SETTINGS;
}

/**
 * Schreibt die Zeilenzahl und meldet den Stand zurück.
 *
 * Eine Anweisung mit `ON CONFLICT`, aus denselben zwei Gründen wie beim
 * Netz: sie deckt „Zeile da" und „Zeile von Hand gelöscht" ab, und der
 * gemeldete Stand kommt aus `RETURNING` statt aus einem zweiten Lesen.
 */
export async function writeLogSettings(pool: Pool, settings: LogSettings): Promise<LogSettings> {
  const { rows } = await pool.query<LogSettingsRow>(
    `INSERT INTO log_settings (tail_lines, singleton)
     VALUES ($1, true)
     ON CONFLICT (singleton) DO UPDATE
        SET tail_lines = EXCLUDED.tail_lines,
            updated_at = now()
     RETURNING tail_lines`,
    [settings.tailLines]
  );
  return { tailLines: rows[0].tail_lines };
}
