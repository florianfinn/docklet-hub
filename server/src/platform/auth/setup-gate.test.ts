import test from "node:test";
import assert from "node:assert/strict";

import { CLAIM_STALE_AFTER_MS, decideSetupAccess } from "./setup-gate.js";

// Der Riegel der Erstanmeldung ist die Stelle, an der ein Fehler nicht
// auffällt: er ist zu, solange er zu sein soll, und niemand probiert das
// nach. Deshalb steht hier jeder Fall einzeln.

const NOW = new Date("2026-09-04T12:00:00Z");

test("ohne Konto und ohne belegten Platz steht die Erstanmeldung offen", () => {
  assert.deepEqual(decideSetupAccess({ userExists: false, claimedAt: null }, NOW), { open: true });
});

test("sobald ein Konto existiert, ist der Weg zu — auch ohne belegten Platz", () => {
  // Der wichtigste Fall. Ein Betrieb mit Konten darf die Erstanmeldung nie
  // wieder zeigen, sonst legt sich der Nächste einen Admin an.
  assert.deepEqual(decideSetupAccess({ userExists: true, claimedAt: null }, NOW), {
    open: false,
    reason: "users-exist"
  });
  assert.deepEqual(decideSetupAccess({ userExists: true, claimedAt: NOW }, NOW), {
    open: false,
    reason: "users-exist"
  });
});

test("ein frisch belegter Platz hält den Weg zu", () => {
  // Das ist der Wettlauf zweier gleichzeitiger Anfragen auf einem frischen
  // Betrieb: die erste hat belegt, die zweite sieht noch kein Konto.
  const claimedAt = new Date(NOW.getTime() - 1_000);
  assert.deepEqual(decideSetupAccess({ userExists: false, claimedAt }, NOW), {
    open: false,
    reason: "claim-held"
  });
});

test("ein Platz ohne Konto verfällt nach der Frist", () => {
  // Sonst sperrte ein Fehlversuch — zu kurzes Passwort — den Betreiber vor
  // einem System aus, in dem es noch nichts zu schützen gibt.
  const claimedAt = new Date(NOW.getTime() - CLAIM_STALE_AFTER_MS - 1);
  assert.deepEqual(decideSetupAccess({ userExists: false, claimedAt }, NOW), { open: true });
});

test("die Frist gilt exakt: eine Millisekunde davor ist der Weg noch zu", () => {
  const claimedAt = new Date(NOW.getTime() - CLAIM_STALE_AFTER_MS);
  assert.deepEqual(decideSetupAccess({ userExists: false, claimedAt }, NOW), { open: true });
  const almost = new Date(NOW.getTime() - CLAIM_STALE_AFTER_MS + 1);
  assert.deepEqual(decideSetupAccess({ userExists: false, claimedAt: almost }, NOW), {
    open: false,
    reason: "claim-held"
  });
});

test("ein Platz aus der Zukunft gilt als frisch", () => {
  // Hub und Datenbank stehen nicht auf demselben Rechner. Eine vorgehende
  // Datenbankuhr wäre sonst ein dauerhaft offener Weg — die Frist ließe sich
  // nie erreichen, weil das Alter negativ bliebe.
  const claimedAt = new Date(NOW.getTime() + 60 * 60 * 1000);
  assert.deepEqual(decideSetupAccess({ userExists: false, claimedAt }, NOW), {
    open: false,
    reason: "claim-held"
  });
});
