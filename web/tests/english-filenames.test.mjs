import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GERMAN_WORDS, splitWords } from "../../eslint-rules/english-identifiers.mjs";

// Wächter über die zweite Hälfte der Sprachregel aus AGENTS.md: Bezeichner
// UND Dateinamen sind englisch. Für Bezeichner hält das die ESLint-Regel
// daneben; Dateinamen sieht sie nicht, denn sie arbeitet auf dem Syntaxbaum,
// und ein Dateiname steht in keinem.
//
// Warum eine Maschine: im Quellsystem stand derselbe Satz jahrelang in
// AGENTS.md, und trotzdem lagen dort am 2026-09-03 113 deutsch benannte
// Code-Dateien (dashboard-homelab#629). Die Regel war bekannt, nur nichts
// wurde rot. Hier ist der Bestand null, und das soll er bleiben — die
// billigste Art, eine Umbenennung zu vermeiden, ist, sie nie nötig zu machen.
//
// Geprüft wird JEDES Segment eines getrackten Pfads, Verzeichnisse
// eingeschlossen: ein deutscher Ordnername ist derselbe Fehler wie ein
// deutscher Dateiname. Dieselbe Wortliste wie die ESLint-Regel, damit beide
// Hälften der Regel dasselbe unter „deutsch" verstehen.
//
// ⚠️ Sieht nur getrackte Dateien (`git ls-files`). Eine neu angelegte Datei
// fällt erst auf, wenn sie im Index steht — der Wächter greift beim `git add`,
// nicht beim Speichern.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Zerlegt einen Pfad in seine Wörter und nennt die deutschen darunter. Ein
// Segment wird an `.` und `-` getrennt und jedes Stück wie ein Bezeichner
// gelesen (camelCase, snake_case). Die Endung zählt mit — sie ist kurz und
// englisch, und eine Sonderbehandlung wäre eine Tür.
export function germanWordsInPath(path, words) {
  const findings = [];
  for (const segment of path.split("/")) {
    for (const piece of segment.split(/[.-]+/)) {
      for (const word of splitWords(piece)) {
        if (words.has(word)) {
          findings.push({ segment, word });
          break;
        }
      }
    }
  }
  return findings;
}

test("der Erkenner selbst: ganze Wörter je Segment, Verzeichnisse eingeschlossen", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung. Geprüft mit
  // Kunstwörtern, damit diese Datei nicht selbst über die Liste stolpert.
  const words = new Set(["xaebc", "xoedf"]);
  assert.deepEqual(germanWordsInPath("server/src/xaebc-thing.ts", words), [{ segment: "xaebc-thing.ts", word: "xaebc" }]);
  assert.deepEqual(germanWordsInPath("web/src/xoedf/index.ts", words), [{ segment: "xoedf", word: "xoedf" }]);
  assert.deepEqual(germanWordsInPath("web/src/useXaebc.ts", words), [{ segment: "useXaebc.ts", word: "xaebc" }]);
  // Wortgrenzen: ein Teilwort in einem englischen Namen ist kein Treffer.
  assert.deepEqual(germanWordsInPath("server/src/myxaebc.ts", words), []);
  assert.deepEqual(germanWordsInPath("docs/design/plan.md", words), []);
});

test("kein getrackter Datei- oder Verzeichnisname trägt ein deutsches Wort", () => {
  // Ohne diesen Fall liefe der Wächter bei einer leeren Liste ins Leere.
  assert.ok(GERMAN_WORDS.size > 100, `Die Wortliste zählt nur ${GERMAN_WORDS.size} Einträge — das sieht nach einem Unfall aus`);

  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(files.length > 0, "git ls-files lieferte nichts — der Wächter liefe ins Leere");

  const findings = files.flatMap((path) =>
    germanWordsInPath(path, GERMAN_WORDS).map((hit) => `${path}: „${hit.segment}" trägt „${hit.word}"`)
  );

  assert.deepEqual(
    findings,
    [],
    `Deutsche Datei- oder Verzeichnisnamen (AGENTS.md, Abschnitt Sprache):\n${findings.join("\n")}`
  );
});
