import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import { authOptions, SIGN_UP_PATH } from "./auth.js";

// Die Zusage, auf der die Rollenvergabe steht.
//
// `databaseHooks.user.create.before` macht JEDES Konto, das better-auth
// anlegt, zum Admin. Das ist richtig, solange es genau einen Weg gibt, auf dem
// dort ein Konto entsteht — und der liegt hinter dem Riegel der Erstanmeldung.
//
// ⚠️ Der Haken selbst prüft das nicht und soll es auch nicht: eine Bedingung
// dort wäre eine zweite Antwort auf dieselbe Frage, und zwei Antworten laufen
// auseinander. Die Zusage hängt stattdessen an der KONFIGURATION — und die
// steht hier unter Aufsicht. Wer einen sozialen Anbieter oder ein Plugin
// einschaltet, öffnet den Haken für jedes neu angelegte Konto; dieser Fall
// fällt dann, statt dass es jemandem auffallen müsste.

const OPTIONS = authOptions({
  // Wird beim Bauen der Optionen nur durchgereicht, nicht benutzt — deshalb
  // genügt hier eine Attrappe, und der Test braucht kein Postgres.
  pool: {} as Pool,
  secret: "x".repeat(32),
  baseUrl: "http://localhost:8080"
});

test("es gibt keinen zweiten Weg, auf dem better-auth ein Konto anlegt", () => {
  // Beides brächte einen eigenen Anlegepfad mit (`/callback/:id`,
  // `/link-social` bzw. was ein Plugin mitbringt), und der Haken oben machte
  // das so entstandene Konto zum Admin.
  //
  // Geprüft wird auf ANWESENHEIT des Schlüssels, nicht auf seinen Wert: ein
  // `socialProviders: {}` wäre zwar leer, aber es stünde da, und der nächste
  // Eintrag darin fiele niemandem mehr auf.
  assert.equal(Object.hasOwn(OPTIONS, "socialProviders"), false, "Ein sozialer Anbieter ist eingeschaltet");
  assert.equal(
    Object.hasOwn(OPTIONS, "plugins"),
    false,
    "Ein Plugin ist eingeschaltet — es kann einen eigenen Anlegepfad mitbringen"
  );
});

test("der Riegel hängt an dem Pfad, den die Anmeldung mit Passwort benutzt", () => {
  // Ein Tippfehler hier wäre kein Fehler, sondern eine offene Registrierung:
  // der Haken liefe nie, und jede Anfrage an /sign-up/email käme durch.
  assert.equal(SIGN_UP_PATH, "/sign-up/email");
  assert.equal(OPTIONS.emailAndPassword.enabled, true);
});

test("die Rolle ist kein Eingabefeld", () => {
  // Ohne `input: false` könnte die Erstanmeldung ihre eigene Rolle
  // mitschicken — und jedes spätere Anlegen ebenso.
  assert.equal(OPTIONS.user.additionalFields.role.input, false);
});

test("es wird nichts nach außen gemeldet", () => {
  // Ein System, das Fremde in ihrem eigenen Netz betreiben sollen, meldet
  // nichts, was sie nicht angeordnet haben.
  assert.equal(OPTIONS.telemetry.enabled, false);
});
