import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getAuthTables } from "better-auth/db";

import { AUTH_OPTIONS_FOR_SCHEMA } from "../auth/schema-source.js";

// Wächter über die Migration der Anmeldung.
//
// Das Schema steht von Hand in 002-auth.sql, weil die Migrationsfolge der Ort
// der Wahrheit ist (AGENTS.md, Datenbank) — ein Werkzeug, das das Schema aus
// einer Konfiguration ableitet und beim Start abgleicht, wäre ein zweiter
// solcher Ort und gewönne im Zweifel.
//
// Der Preis dafür ist Drift: better-auth ergänzt in einer neuen Fassung ein
// Feld, die Migration weiß nichts davon, und der Fehler fällt beim ersten
// Anmeldeversuch auf — in einer Meldung über eine fehlende Spalte, die
// niemand mit einem Abhängigkeits-Update in Verbindung bringt. Genau so ist
// `account.issuer` in 1.7 entstanden.
//
// Dieser Fall zahlt den Preis nicht, sondern verschiebt ihn: er liest
// dieselbe Beschreibung, aus der das Werkzeug seine Migrationen erzeugt, und
// vergleicht sie mit der Datei. Ein Update, das ein Feld ergänzt, wird damit
// rot, bevor es ausgeliefert ist.
//
// ⚠️ Er steht bei den Servertests und nicht unter web/tests/, obwohl er ein
// Wächter über eine Regel ist: er braucht `better-auth`, und das ist eine
// Abhängigkeit des Servers. Ein Wächter, der aus dem Nachbarworkspace in ein
// fremdes node_modules greift, bricht beim nächsten Umbau der Installation.

const DIRECTORY = new URL("./migrations/", import.meta.url);

// Die Migration, in der das Schema der Anmeldung ANGELEGT wird. Der zweite
// Fall unten prüft eine Aussage über genau diese Datei und liest sie deshalb
// weiterhin einzeln.
const AUTH_MIGRATION = "002-auth.sql";
const AUTH_MIGRATION_SQL = readFileSync(fileURLToPath(new URL(AUTH_MIGRATION, DIRECTORY)), "utf8");

/** Die Migrationen des Verzeichnisses in der Reihenfolge ihrer Nummern. */
function sequence(): string[] {
  return readdirSync(fileURLToPath(DIRECTORY))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => Number(/^\d+/.exec(a)?.[0] ?? 0) - Number(/^\d+/.exec(b)?.[0] ?? 0))
    .map((filename) => readFileSync(fileURLToPath(new URL(filename, DIRECTORY)), "utf8"));
}

/**
 * Die zitierten Spaltennamen einer Tabelle, wie sie nach der GANZEN Folge
 * dasteht.
 *
 * ⚠️ Nicht eine Datei, sondern die Folge — und das ist der Punkt. Bis 005 las
 * dieser Wächter nur 002-auth.sql, und ein Feld, das eine SPÄTERE Migration
 * ergänzt, fehlte für ihn. Seine eigene Fehlermeldung sagt „was hier fehlt,
 * ergänzt eine NEUE Migration"; wer ihr folgte, machte ihn damit rot. Diese
 * Lücke ist hier geschlossen: gelesen wird dasselbe, was auf einer frischen
 * Datenbank läuft.
 *
 * Angewandt werden die drei Formen, in denen dieses Repo Spalten bewegt —
 * mehr kann diese Auswertung nicht, und mehr soll sie auch nicht: eine
 * Migration, die eine Tabelle umbenennt oder Spalten über SQL erzeugt, das
 * hier nicht erkannt wird, macht diesen Wächter rot statt still falsch.
 */
function columnsOf(table: string): Set<string> {
  const columns = new Set<string>();
  let created = false;

  for (const sql of sequence()) {
    const start = sql.indexOf(`CREATE TABLE "${table}" (`);
    if (start !== -1) {
      created = true;
      const body = sql.slice(start, sql.indexOf("\n);", start));
      for (const line of body.split("\n").slice(1)) {
        // Nur die Zeilen, die mit einem zitierten Namen BEGINNEN. Damit fallen
        // Kommentare und Bedingungen (CHECK, REFERENCES) heraus, die denselben
        // Namen noch einmal nennen.
        const match = /^\s*"([A-Za-z]+)"\s/.exec(line);
        if (match) columns.add(match[1]);
      }
    }

    // `ALTER TABLE "<t>" ADD COLUMN "<c>"` und das Gegenstück. Sie stehen in
    // eigenen Anweisungen und nicht in einer Klammer, deshalb reicht hier ein
    // Ausdruck über den ganzen Text der Datei.
    for (const match of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+"${table}"\\s+ADD COLUMN\\s+"([A-Za-z]+)"`, "g")
    )) {
      columns.add(match[1]);
    }
    for (const match of sql.matchAll(
      new RegExp(`ALTER TABLE\\s+"${table}"\\s+DROP COLUMN\\s+"([A-Za-z]+)"`, "g")
    )) {
      columns.delete(match[1]);
    }
  }

  assert.ok(created, `Die Migrationsfolge legt keine Tabelle „${table}" an`);
  return columns;
}

test("die Migration trägt genau die Felder, die better-auth erwartet", () => {
  const tables = getAuthTables(AUTH_OPTIONS_FOR_SCHEMA);

  const findings: string[] = [];
  for (const table of Object.values(tables)) {
    const expected = new Set<string>(["id"]);
    for (const [name, field] of Object.entries(table.fields)) {
      expected.add(field.fieldName ?? name);
    }
    const actual = columnsOf(table.modelName);

    for (const name of expected) {
      if (!actual.has(name)) findings.push(`${table.modelName}: die Spalte „${name}" fehlt in der Migrationsfolge`);
    }
    for (const name of actual) {
      if (!expected.has(name)) {
        findings.push(
          `${table.modelName}: die Spalte „${name}" steht in der Migrationsfolge, aber nicht bei better-auth`
        );
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Migrationen laufen nur vorwärts (AGENTS.md): was hier fehlt, ergänzt eine NEUE Migration —\n" +
      `002-auth.sql wird nicht mehr angefasst. Gelesen wird die ganze Folge, die neue Datei zählt also mit.\n${findings.join("\n")}`
  );
});

test("der Riegel der Erstanmeldung steht in derselben Migration", () => {
  // Er gehört zur Anmeldung und nicht zu den Hosts: ohne ihn wäre die
  // Erstanmeldung eine Prüfung mit einem Fenster (setup-store.ts).
  //
  // ⚠️ Dieser Fall bleibt auf 002-auth.sql gerichtet und liest bewusst NICHT
  // die Folge: er sagt aus, in welcher Datei der Riegel steht, und nicht, dass
  // es ihn irgendwo gibt.
  assert.match(AUTH_MIGRATION_SQL, /CREATE TABLE setup_claim/);
});
