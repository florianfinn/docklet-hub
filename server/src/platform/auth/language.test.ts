import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LANGUAGE, LANGUAGES, toLanguage } from "./language.js";

test("es gibt genau zwei Sprachen", () => {
  // Wer eine dritte Sprache ergänzt, ändert damit auch den CHECK in
  // 005-user-language.sql — dieser Fall soll ihn daran erinnern.
  assert.deepEqual([...LANGUAGES], ["de", "en"]);
});

test("die Vorgabe ist Deutsch", () => {
  // Sie steht an zwei Stellen: hier im Code und als DEFAULT der Spalte. Beide
  // müssen dasselbe sagen, sonst zeigte ein Konto ohne gesetzte Sprache etwas
  // anderes als eine frisch angelegte Zeile.
  assert.equal(DEFAULT_LANGUAGE, "de");
});

test("was nicht als Sprache erkennbar ist, wird zur Vorgabe", () => {
  // Fail closed. Ein `null` aus einer Spalte, eine Zahl aus einem falsch
  // geparsten Rumpf, ein unbekannter Code, eine abweichende Schreibweise:
  // keiner davon macht eine Oberfläche ohne Wörterbuch.
  for (const value of [undefined, null, 42, "fr", "DE", "", {}, ["de"]]) {
    assert.equal(
      toLanguage(value),
      DEFAULT_LANGUAGE,
      `${JSON.stringify(value) ?? "undefined"} hätte zur Vorgabesprache werden müssen`
    );
  }
});

test("jede Sprache der Aufzählung kommt unverändert durch", () => {
  // ⚠️ Über LANGUAGES und nicht über zwei genannte Werte. Zwei genannte Werte
  // wüchsen bei einer dritten Sprache nicht mit: `toLanguage` wiese sie still
  // ab, dieser Fall bliebe grün, und die Route antwortete mit 400 auf eine
  // Sprache, die in der Aufzählung, in der Spalte und in der Oberfläche als
  // gültig dasteht. Dieser Fall ist die Stelle, an der das auffällt.
  for (const language of LANGUAGES) {
    assert.equal(toLanguage(language), language, `„${language}" steht in LANGUAGES, kommt aber nicht durch`);
  }
});
