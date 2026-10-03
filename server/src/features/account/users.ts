import type { Pool } from "pg";

import { toRole, type Role } from "../../platform/auth/roles.js";

// Die Konten-Liste der Fläche „Benutzer & Profil" (D6b, Entscheidung des
// Betreibers vom 2026-09-06: LESEND, hinter `requireAdmin`).
//
// ⚠️ ALLE BEZEICHNER SIND AN 002-auth.sql GEMESSEN, nicht am Gedächtnis. Die
// Tabellen von better-auth stehen in Anführungszeichen und tragen ihre
// Spalten in camelCase (die Migration sagt in ihrem Kopf, warum: better-auth
// spricht über Kysely und zitiert seine Bezeichner). Ein unquotiertes
// `SELECT lastSignInAt` fände nichts — Postgres suchte `lastsigninat`.
//
// ⚠️ EINE SPALTE „lastSignInAt" GIBT ES NICHT. Gemessen an 002-auth.sql
// Z. 40-53 trägt `"session"` genau: `"id"`, `"expiresAt"`, `"token"`,
// `"createdAt"`, `"updatedAt"`, `"ipAddress"`, `"userAgent"`, `"userId"`.
// Die letzte Anmeldung ist deshalb ABGELEITET und keine gespeicherte Zahl:
//
//   * `lastSignInAt` = `MAX("session"."createdAt")` (Z. 44). Eine Sitzung
//     ENTSTEHT beim Anmelden — ihr Anlegedatum IST das der Anmeldung. Nicht
//     `"updatedAt"`: das wandert bei jeder Verlängerung mit und hieße dann
//     „zuletzt gesehen" statt „zuletzt angemeldet".
//   * `sessionCount` = die Sitzungen mit `"expiresAt" > now()` (Z. 42). Das
//     ist, was eine Sitzung als AKTIV ausweist: better-auth löscht die Zeile
//     beim Abmelden, aber eine abgelaufene bleibt liegen, bis jemand
//     aufräumt. Ohne diese Bedingung zählte die Liste Sitzungen mit, mit
//     denen niemand mehr arbeiten kann — und der Betreiber sähe an einem
//     stillgelegten Konto sieben offene Sitzungen.
//
// ⚠️ `LEFT JOIN` und nicht `JOIN`: ein Konto, das sich noch nie angemeldet
// hat, gehört in diese Liste. Es ist der interessanteste Fall der Fläche —
// ein angelegtes Konto, das nie benutzt wurde. Mit einem inneren Verbund
// fehlte es, und niemand vermisste eine Zeile, die es nie gab.
//
// ⚠️ Was hier NICHT steht: der Passwort-Hash. Er liegt in `"account"`
// (002-auth.sql Z. 76) und wird von dieser Abfrage nicht berührt — dieselbe
// Regel wie beim Agent-Secret der Hosts: ein Feld, das die Abfrage nicht
// holt, kann nicht versehentlich in einer Antwort landen.

export type UserAccount = {
  id: string;
  name: string;
  email: string;
  role: Role;
  // ISO-8601 oder `null` für ein Konto, das sich noch nie angemeldet hat.
  lastSignInAt: string | null;
  // Wie viele Sitzungen dieses Kontos gerade gültig sind.
  sessionCount: number;
};

type UserAccountRow = {
  id: string;
  name: string;
  email: string;
  role: unknown;
  last_sign_in_at: Date | null;
  session_count: string;
};

// Die Reihenfolge kommt aus dem SQL und nicht aus dem Browser: sie soll auf
// jeder Fläche dieselbe sein. Nach Name, und bei gleichem Namen nach Kennung,
// damit sie überhaupt eindeutig ist — zwei Konten dürfen denselben Namen
// tragen, nur nicht dieselbe Adresse.
const USER_ACCOUNTS_SQL = `
  SELECT u."id",
         u."name",
         u."email",
         u."role",
         MAX(s."createdAt")                                 AS last_sign_in_at,
         COUNT(s."id") FILTER (WHERE s."expiresAt" > now()) AS session_count
    FROM "user" u
    LEFT JOIN "session" s ON s."userId" = u."id"
   GROUP BY u."id", u."name", u."email", u."role"
   ORDER BY u."name" ASC, u."id" ASC
`;

/**
 * Alle Konten mit ihrer letzten Anmeldung und der Zahl gültiger Sitzungen.
 *
 * ⚠️ `COUNT` liefert in Postgres ein `bigint`, und `node-postgres` gibt
 * `bigint` als ZEICHENKETTE zurück (sonst verlöre es Genauigkeit jenseits von
 * 2^53). Ohne das `Number()` stünde in der Antwort `"3"` statt `3`, und die
 * Oberfläche rechnete mit einer Zeichenkette — `sessionCount + 1` wäre „31".
 */
export async function listUserAccounts(pool: Pool): Promise<UserAccount[]> {
  const { rows } = await pool.query<UserAccountRow>(USER_ACCOUNTS_SQL);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    // `toRole` ist fail closed: was nicht als Rolle erkennbar ist, wird zur
    // kleineren (auth/roles.ts). Ein `null` in der Spalte zeigt damit
    // „user" und nicht „admin".
    role: toRole(row.role),
    lastSignInAt: row.last_sign_in_at === null ? null : row.last_sign_in_at.toISOString(),
    sessionCount: Number(row.session_count)
  }));
}
