import test from "node:test";
import assert from "node:assert/strict";

import { PlanError, planMigrations } from "./migration-plan.js";

// Diese Datei ist der Grund, warum das Migrationswerkzeug selbst geschrieben
// ist statt zugekauft: die vier Regeln aus AGENTS.md („Datenbank") sind hier
// prüfbar, ohne dass ein Postgres läuft. Ein fremdes Werkzeug wäre in diesem
// Repo genau so weit geprüft, wie sein Autor es gemeint hat.

const file = (filename: string, checksum = `summe-${filename}`) => ({ filename, checksum });

test("frische Datenbank: alle Migrationen stehen aus, in Nummernreihenfolge", () => {
  const plan = planMigrations([file("002-b.sql"), file("001-a.sql"), file("010-c.sql")], []);
  assert.deepEqual(
    plan.map((entry) => entry.filename),
    ["001-a.sql", "002-b.sql", "010-c.sql"]
  );
});

test("sortiert wird nach der Nummer, nicht alphabetisch", () => {
  // Der Fehler, den dreistellige Nummern verhindern: „10" vor „9" wäre
  // textuell richtig und fachlich falsch.
  const plan = planMigrations([file("010-zehn.sql"), file("009-neun.sql")], []);
  assert.deepEqual(
    plan.map((entry) => entry.filename),
    ["009-neun.sql", "010-zehn.sql"]
  );
});

test("bereits angewandte Migrationen laufen nicht erneut", () => {
  const plan = planMigrations(
    [file("001-a.sql"), file("002-b.sql")],
    [file("001-a.sql")]
  );
  assert.deepEqual(
    plan.map((entry) => entry.filename),
    ["002-b.sql"]
  );
});

test("eine nachträglich geänderte Migration hält den Start an", () => {
  assert.throws(
    () => planMigrations([file("001-a.sql", "neu")], [file("001-a.sql", "alt")]),
    (error: unknown) => error instanceof PlanError && /geändert/.test((error as Error).message)
  );
});

test("eine angewandte, aber entfernte Migration hält den Start an", () => {
  assert.throws(
    () => planMigrations([file("002-b.sql")], [file("001-a.sql")]),
    (error: unknown) => error instanceof PlanError && /nicht mehr im Verzeichnis/.test((error as Error).message)
  );
});

test("eine neue Migration unter dem angewandten Stand hält den Start an", () => {
  // Der Rückwärts-Fall: jemand fügt 002 ein, während 003 längst läuft.
  assert.throws(
    () =>
      planMigrations(
        [file("001-a.sql"), file("002-neu.sql"), file("003-c.sql")],
        [file("001-a.sql"), file("003-c.sql")]
      ),
    (error: unknown) => error instanceof PlanError && /nur vorwärts/.test((error as Error).message)
  );
});

test("zwei Migrationen mit derselben Nummer halten den Start an", () => {
  assert.throws(
    () => planMigrations([file("001-a.sql"), file("001-b.sql")], []),
    (error: unknown) => error instanceof PlanError && /dieselbe Nummer|die Nummer 1/.test((error as Error).message)
  );
});

test("ein Dateiname außerhalb des Musters hält den Start an", () => {
  for (const name of ["schema.sql", "1-a.sql", "001_a.sql", "001-A.sql", "001-a.txt"]) {
    assert.throws(
      () => planMigrations([file(name)], []),
      (error: unknown) => error instanceof PlanError,
      `„${name}" hätte abgelehnt werden müssen`
    );
  }
});

test("Lücken in der Nummerierung sind erlaubt", () => {
  // Nummern sind eine Reihenfolge, keine Zählung. Ein verworfener Zweig darf
  // eine Lücke hinterlassen, ohne dass später jemand umnummeriert — und
  // Umnummerieren wäre genau das Ändern, das die Regel verbietet.
  const plan = planMigrations([file("001-a.sql"), file("005-b.sql")], [file("001-a.sql")]);
  assert.deepEqual(
    plan.map((entry) => entry.filename),
    ["005-b.sql"]
  );
});

test("gleicher Stand, nichts zu tun", () => {
  assert.deepEqual(planMigrations([file("001-a.sql")], [file("001-a.sql")]), []);
});

test("ein leeres Migrationsverzeichnis hält den Start an", () => {
  // Der gefährlichste Fehlerfall des Läufers: ohne diese Prüfung legt der Hub
  // ein leeres Schema an und meldet Erfolg. Ausgelöst wird er nicht von Hand,
  // sondern von einem Image, in das die .sql-Dateien nicht kopiert wurden.
  assert.throws(
    () => planMigrations([], []),
    (error: unknown) => error instanceof PlanError && /nicht mit ins Image kopiert/.test((error as Error).message)
  );
});
