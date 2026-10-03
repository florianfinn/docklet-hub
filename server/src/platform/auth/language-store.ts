import type { Pool } from "pg";

import type { Language } from "./language.js";

// Die eine Zeile hinter der Sprache: schreiben.
//
// Getrennt von language.ts, weil dort die Entscheidung steht und hier der
// Zugriff — dieselbe Trennung wie zwischen setup-gate.ts und setup-store.ts,
// und aus demselben Grund: die Entscheidung ist die Stelle, an der man sich
// irren kann, und sie muss ohne Datenbank prüfbar sein (AGENTS.md, Tests).
//
// ⚠️ Kein eigener Datenbanktest, und das ist Absicht und kein Rückstand.
// setup-store.ts hat auch keinen: geprüft wird in diesem Repo die
// Entscheidung, nicht das SQL. Was hier schiefgehen könnte, fiele beim ersten
// Aufruf auf; was in `toLanguage` schiefginge, fiele niemandem auf.

/**
 * Schreibt die Sprache eines Kontos.
 *
 * ⚠️ Der Wert kommt als `Language` herein und nicht als Zeichenkette. Die
 * Prüfung liegt damit vor dieser Funktion — in der einen Route, die sie
 * aufruft (features/account/routes.ts) — und nicht in ihr. Der CHECK der Spalte
 * (005-user-language.sql) ist die zweite Hälfte derselben Zusage und nicht
 * ihre einzige: eine verletzte Bedingung wäre eine 500 und keine Antwort, die
 * dem Aufrufer sagt, was er falsch gemacht hat.
 *
 * Eine Anweisung. Ein Lesen des heutigen Werts davor bräuchte niemand: die
 * Route setzt einen Wert, sie verrechnet keinen.
 */
export async function writeUserLanguage(pool: Pool, userId: string, language: Language): Promise<void> {
  await pool.query(`UPDATE "user" SET "language" = $2, "updatedAt" = now() WHERE "id" = $1`, [userId, language]);
}
