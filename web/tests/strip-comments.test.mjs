import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Der Wächter über die EINE Fassung der Kommentar-Entferner.
//
// Vorgeschichte (#71, #78): `stripComments` lag am 2026-09-05 siebenmal
// byteidentisch im Baum. Zusammengelegt wurde er in #74; gemessen am
// 2026-09-06 gibt es im ganzen Repo genau eine Definition, und alle Wächter
// importieren sie. Was fehlte, ist die Schranke davor — nichts hinderte die
// nächste Kopie daran, wieder zu entstehen, und genau das ist bei dieser
// Funktion schon zweimal passiert.
//
// ⚠️ Warum eine Kopie ein Fehler ist und nicht nur unschön: zwei Abschriften
// derselben Rechnung sind zwei Wahrheiten. Wer die eine berichtigt,
// berichtigt die andere nicht, und der Unterschied fällt nicht auf, weil jede
// Kopie für sich grün bleibt. Gemessen in #71: die Zeilentreue in
// `stripCssComments` wurde in zwei Kopien nachgezogen, in der dritten nicht —
// und deren Fundmeldungen zeigten seither auf die falsche Zeile.
//
// ⚠️ Dieser Wächter zählt NICHT, wer die Funktionen benutzt. Eine Liste von
// Verwendern in einem Kommentar veraltet mit dem nächsten Paket (sie stand im
// Kopf von `strip-comments.mjs` und war am 2026-09-06 bereits falsch: 7 statt
// 9, 3 statt 4). Gehalten wird die Eigenschaft, auf die es ankommt — es gibt
// eine Quelle —, nicht ihre Buchführung.

const HERE = fileURLToPath(new URL("./", import.meta.url));
const SOURCE = "strip-comments.mjs";
const FUNCTIONS = ["stripComments", "stripCssComments"];

// Die Wächter selbst und die Hilfsdateien daneben: alles, was in diesem
// Verzeichnis Code ist.
function testFiles() {
  return readdirSync(HERE)
    .filter((name) => /\.(mjs|tsx)$/.test(name))
    .filter((name) => name !== SOURCE);
}

test("keine zweite Definition der Kommentar-Entferner", () => {
  const findings = [];
  for (const name of testFiles()) {
    // Der eigene Entferner auf den eigenen Text: ein Name in einer Prosazeile
    // ist keine Definition, und dieser Kopf hier nennt beide Funktionen
    // mehrfach.
    const code = stripComments(readFileSync(new URL(name, `file://${HERE}`), "utf8"));
    for (const fn of FUNCTIONS) {
      const pattern = new RegExp(`(function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=)`);
      if (pattern.test(code)) findings.push(`${name}: eigene Definition von \`${fn}\``);
    }
  }
  assert.deepEqual(
    findings,
    [],
    `Kommentar-Entferner gehören einmal ins Repo, nach ${SOURCE}:\n${findings.join("\n")}`
  );
});

test("wer sie benutzt, importiert sie aus der einen Datei", () => {
  const findings = [];
  for (const name of testFiles()) {
    const code = stripComments(readFileSync(new URL(name, `file://${HERE}`), "utf8"));
    const used = FUNCTIONS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code));
    if (used.length === 0) continue;
    if (!code.includes(`from "./${SOURCE}"`)) {
      findings.push(`${name}: benutzt ${used.join(", ")}, importiert aber nicht aus ${SOURCE}`);
    }
  }
  assert.deepEqual(findings, [], findings.join("\n"));
});

test("der Entferner behält die Zeilen und die Zeichenketten", () => {
  // Die zwei Eigenschaften, an denen die Wächter hängen — und die eine Kopie
  // als erstes verlöre. Ohne Zeilentreue zeigt jede Fundmeldung auf die
  // falsche Zeile; ohne die Zeichenketten fände ein Wächter die Farbe nicht
  // mehr, die er sucht.
  const source = ['const url = "https://example.test/pfad"; // Kommentar', "/* zwei", "   Zeilen */ const rest = 1;"].join(
    "\n"
  );
  const stripped = stripComments(source);

  assert.equal(stripped.split("\n").length, source.split("\n").length);
  assert.match(stripped, /"https:\/\/example\.test\/pfad"/);
  assert.doesNotMatch(stripped, /Kommentar/);
  assert.doesNotMatch(stripped, /zwei/);
  assert.match(stripped, /const rest = 1;/);
});
