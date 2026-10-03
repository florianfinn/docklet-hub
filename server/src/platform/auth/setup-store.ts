import type { Pool } from "pg";

import { CLAIM_STALE_AFTER_MS, type SetupState } from "./setup-gate.js";

// Die Zeilen hinter der Erstanmeldung: lesen, belegen, freigeben.
//
// Getrennt von setup-gate.ts, weil dort die Entscheidung steht und hier der
// Zugriff. Die Trennung ist nicht kosmetisch: die Entscheidung ist die Stelle,
// an der man sich irren kann, und sie muss ohne Datenbank prüfbar sein
// (AGENTS.md, Tests).

/** Liest den Zustand, aus dem `decideSetupAccess` entscheidet. */
export async function readSetupState(pool: Pool): Promise<SetupState> {
  const { rows } = await pool.query<{ user_exists: boolean; claimed_at: Date | null }>(
    `SELECT EXISTS (SELECT 1 FROM "user")        AS user_exists,
            (SELECT claimed_at FROM setup_claim) AS claimed_at`
  );
  const row = rows[0];
  // Fail closed: ohne Antwort gilt der Weg als zu. Ein Fehler in dieser
  // Abfrage darf nicht dazu führen, dass die Erstanmeldung wieder offensteht.
  return { userExists: row?.user_exists ?? true, claimedAt: row?.claimed_at ?? null };
}

/**
 * Belegt den Platz der Erstanmeldung — oder meldet, dass er vergeben ist.
 *
 * ⚠️ EINE Anweisung, und das ist der ganze Punkt dieser Funktion. Ein
 * gelesenes „noch kein Konto da" gefolgt von einem Anlegen wären zwei
 * Schritte, und zwei gleichzeitige Anfragen auf einem frischen Betrieb kämen
 * beide durch. Der Primärschlüssel entscheidet stattdessen: die zweite Anfrage
 * läuft in `ON CONFLICT`, ihre `WHERE`-Bedingung greift nicht, und sie bekommt
 * keine Zeile zurück.
 *
 * Die Prüfung auf bestehende Konten liegt davor und darf das: sobald ein Konto
 * existiert, existiert es weiter. Ein Wettlauf entsteht nur, solange keines da
 * ist — und genau den entscheidet die Anweisung unten.
 */
export async function claimSetupSlot(
  pool: Pool,
  staleAfterMs: number = CLAIM_STALE_AFTER_MS
): Promise<boolean> {
  const existing = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "user") AS present`
  );
  if (existing.rows[0]?.present !== false) return false;

  const { rows } = await pool.query<{ claimed_at: Date }>(
    `INSERT INTO setup_claim (claimed, claimed_at)
     VALUES (true, now())
     ON CONFLICT (claimed) DO UPDATE SET claimed_at = now()
       WHERE setup_claim.claimed_at < now() - ($1::double precision * interval '1 millisecond')
     RETURNING claimed_at`,
    [staleAfterMs]
  );
  return rows.length === 1;
}

/**
 * Gibt einen Platz wieder frei, dem kein Konto folgte.
 *
 * Der Rückweg zur Frist aus setup-gate.ts: scheitert die Erstanmeldung nach
 * dem Belegen, wartet der Betreiber sonst zehn Minuten vor einem System, in
 * dem es nichts zu schützen gibt. Die Frist bleibt trotzdem — dieser Weg läuft
 * nur, wenn der Fehler im Hub selbst auffällt, und nicht, wenn der Browser
 * mitten im Vorgang verschwindet.
 */
export async function releaseSetupSlot(pool: Pool): Promise<void> {
  // `NOT EXISTS` als Riegel: nach einer erfolgreichen Erstanmeldung darf der
  // Platz nicht mehr freigegeben werden, auch nicht durch einen Fehler, der
  // erst danach auftritt.
  await pool.query(`DELETE FROM setup_claim WHERE NOT EXISTS (SELECT 1 FROM "user")`);
}
