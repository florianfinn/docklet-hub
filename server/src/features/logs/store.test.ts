import test from "node:test";
import assert from "node:assert/strict";

import { LOG_TAIL_LINE_OPTIONS, normalizeLogTailLines } from "./store.js";

// `normalizeLogTailLines` ist eine REINE Funktion — geprüft ohne Pool und
// ohne Postgres. Was sie gegen die Tabelle tut (`readLogSettings`,
// `writeLogSettings`), hält `server/src/app/settings-logs-routes.test.ts`
// über den erfundenen Pool fest, wie beim Netz.
//
// ⚠️ JEDER Grenzfall einzeln: ein JSON-Rumpf ist offen für alles, was JSON
// selbst zulässt, und ein Aufrufer, der die falsche Form schickt, bekommt eine
// klare Ablehnung statt einer Vorgabe, die er nie gewählt hat.

test("jeder der vier erlaubten Werte wird angenommen", () => {
  for (const option of LOG_TAIL_LINE_OPTIONS) {
    const result = normalizeLogTailLines(option);
    assert.deepEqual(result, { ok: true, value: option });
  }
});

test("eine Zeichenkette wird abgelehnt, auch wenn sie wie ein erlaubter Wert aussieht", () => {
  assert.deepEqual(normalizeLogTailLines("500"), { ok: false });
});

test("eine Kommazahl wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines(500.4), { ok: false });
});

test("NaN wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines(Number.NaN), { ok: false });
});

test("Unendlich wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines(Number.POSITIVE_INFINITY), { ok: false });
});

test("eine negative Zahl wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines(-1), { ok: false });
});

test("eine Zahl außerhalb der Liste wird abgelehnt, auch weit außerhalb", () => {
  assert.deepEqual(normalizeLogTailLines(999999), { ok: false });
});

test("eine Zahl knapp neben einem erlaubten Wert wird abgelehnt", () => {
  // ⚠️ Der Fall, der eine Prüfung mit „liegt zwischen 200 und 2000" nicht
  // fände: 501 ist im Bereich, aber keiner der vier Werte.
  assert.deepEqual(normalizeLogTailLines(501), { ok: false });
});

test("null wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines(null), { ok: false });
});

test("undefined wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines(undefined), { ok: false });
});

test("ein Objekt wird abgelehnt", () => {
  assert.deepEqual(normalizeLogTailLines({ tailLines: 500 }), { ok: false });
});

test("ein Feld wird nicht stillschweigend auf die Vorgabe gezogen", () => {
  // Die eigentliche Zusage hinter allen Fällen oben: eine Ablehnung ist eine
  // Ablehnung, `{ ok: false }`, und nie `{ ok: true, value: 500 }` für einen
  // Wert, den niemand so gemeint hat.
  const result = normalizeLogTailLines("nicht-mal-eine-zahl");
  assert.equal(result.ok, false);
});
