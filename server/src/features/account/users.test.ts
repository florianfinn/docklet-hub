import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { listUserAccounts } from "./users.js";

// Geprüft gegen einen erfundenen Pool — kein Postgres (AGENTS.md, „Tests").
// Dasselbe Verfahren wie in `domain/hosts/host-store.test.ts`: was hier geprüft wird, ist
// die BAUART der Abfrage und die Übersetzung ihrer Zeilen, nicht, ob das SQL
// gegen echtes Postgres läuft.
//
// Was still bricht und deshalb hier steht:
//
//   1. Ein unquotierter Bezeichner. Die Tabellen von better-auth stehen in
//      Anführungszeichen und tragen camelCase-Spalten (002-auth.sql, Kopf);
//      `SELECT lastSignInAt` suchte `lastsigninat` und fände nichts. Das
//      fällt nicht im Typcheck auf, sondern beim ersten Aufruf im Betrieb.
//   2. `COUNT` kommt aus `node-postgres` als ZEICHENKETTE (bigint). Ohne die
//      Umwandlung stünde `"3"` in der Antwort, und die Oberfläche rechnete
//      damit weiter.
//   3. Ein INNERER Verbund. Ein Konto ohne Sitzung fiele damit aus der Liste
//      — und das ist genau der Fall, den diese Fläche zeigen soll.

type Call = { text: string; values: unknown[] };

function fakePool(rows: unknown[]): { pool: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows, rowCount: rows.length });
    }
  } as unknown as Pool;
  return { pool, calls };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "user-1",
    name: "Florian",
    email: "florian@example.org",
    role: "admin",
    last_sign_in_at: new Date("2026-09-04T18:30:00.000Z"),
    session_count: "2",
    ...overrides
  };
}

test("eine Zeile wird in den Vertrag der Oberfläche übersetzt", async () => {
  const { pool } = fakePool([row()]);
  assert.deepEqual(await listUserAccounts(pool), [
    {
      id: "user-1",
      name: "Florian",
      email: "florian@example.org",
      role: "admin",
      lastSignInAt: "2026-09-04T18:30:00.000Z",
      sessionCount: 2
    }
  ]);
});

test("die Zahl der Sitzungen ist eine Zahl und keine Zeichenkette", async () => {
  const { pool } = fakePool([row({ session_count: "17" })]);
  const [account] = await listUserAccounts(pool);
  assert.equal(account.sessionCount, 17);
  assert.equal(typeof account.sessionCount, "number");
});

test("ein Konto, das sich nie angemeldet hat, steht in der Liste", async () => {
  const { pool } = fakePool([row({ last_sign_in_at: null, session_count: "0" })]);
  assert.deepEqual(await listUserAccounts(pool), [
    {
      id: "user-1",
      name: "Florian",
      email: "florian@example.org",
      role: "admin",
      lastSignInAt: null,
      sessionCount: 0
    }
  ]);
});

test("eine unlesbare Rolle wird zur kleineren und nicht zu admin", async () => {
  // `toRole` ist fail closed (auth/roles.ts). Eine Zeile, deren Spalte leer
  // ist, darf keinen Admin ergeben.
  const { pool } = fakePool([row({ role: null }), row({ id: "user-2", role: "vorstand" })]);
  const accounts = await listUserAccounts(pool);
  assert.deepEqual(
    accounts.map((account) => account.role),
    ["user", "user"]
  );
});

test("die Abfrage zitiert die Bezeichner von better-auth", async () => {
  const { pool, calls } = fakePool([]);
  await listUserAccounts(pool);
  const [call] = calls;

  // Die Tabellen: `user` ist in Postgres ein Schlüsselwort, `session` trägt
  // camelCase-Spalten — beide gehören in Anführungszeichen (002-auth.sql
  // Z. 23 und Z. 40).
  assert.match(call.text, /FROM "user" u/);
  assert.match(call.text, /LEFT JOIN "session" s ON s\."userId" = u\."id"/);

  // Die abgeleiteten Felder, an der Migration gemessen: `"createdAt"`
  // (Z. 44) datiert die Anmeldung, `"expiresAt"` (Z. 42) weist eine Sitzung
  // als gültig aus.
  assert.match(call.text, /MAX\(s\."createdAt"\)\s+AS last_sign_in_at/);
  assert.match(call.text, /COUNT\(s\."id"\) FILTER \(WHERE s\."expiresAt" > now\(\)\) AS session_count/);

  // Kein unquotierter camelCase-Bezeichner — der fände in Postgres nichts.
  assert.doesNotMatch(call.text, /[^"\w](createdAt|expiresAt|userId|lastSignInAt)[^"]/);

  // Und kein Passwort-Hash: der liegt in `"account"` und wird hier nicht
  // berührt (dieselbe Regel wie beim Agent-Secret der Hosts).
  assert.doesNotMatch(call.text, /"account"|password/i);
});

test("die Reihenfolge kommt aus dem SQL und nicht aus dem Browser", async () => {
  const { pool, calls } = fakePool([]);
  await listUserAccounts(pool);
  assert.match(calls[0].text, /ORDER BY u\."name" ASC, u\."id" ASC/);
});
