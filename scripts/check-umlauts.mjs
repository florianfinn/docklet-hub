// Die Prüfung auf deutsche Wörter in ASCII-Umschreibung und auf doppelt
// kodierte Umlaute — einmal, für alle Aufrufer.
//
// AGENTS.md, Abschnitt Sprache: Umlaute und ß werden richtig gesetzt, auch im
// Commit-Betreff. Daraus folgen drei Prüfstellen mit derselben Frage:
//
//   web/tests/german-umlauts.test.mjs      die Dateien im Repo
//   web/tests/commit-messages.test.mjs     die Commit-Texte seit der Grundlinie
//   .githooks/commit-msg                  der Commit-Text, der gerade entsteht
//
// Alle rufen hier herein. Zwei Umsetzungen wären zwei Auslegungen davon, was
// als Wort zählt — und die eine ließe durch, was die andere anhält.
//
// Zwei Fehlerklassen, zwei Erkenner:
//
//   1. ASCII-Umschreibung („u-e statt Umlaut", „s-s statt Eszett") — jemand hatte keine Umlaute auf
//      der Tastatur oder ein Werkzeug hat sie ersetzt. Wortliste.
//   2. Doppelt kodierte Umlaute — ein UTF-8-Text wurde unterwegs als
//      Windows-1252 gelesen und erneut als UTF-8 geschrieben; aus „ü" wird
//      ein A mit Tilde plus ein Viertel-Zeichen, aus „—" ein a mit Zirkumflex,
//      ein Euro-Zeichen und ein Anführungszeichen. Gemessen am 2026-09-04:
//      zwei Squash-Commits auf Standard-Branches, der PR-Titel war beim
//      Anlegen in einer Shell-Zeile gekippt, und der Merge übernahm ihn
//      ungeprüft. Kein Wort der Liste trifft so etwas, darum der zweite
//      Erkenner über die drei Zeichenfolgen, die in deutschem oder englischem
//      Text nie vorkommen und in Mojibake immer.
//
// ⚠️ Bewusst Node und keine Shell-Zeile mit `grep -f`: auf der Arbeitsumgebung
// dieses Repos (git-bash unter Windows) bricht `grep` mit einer Wortliste
// dieser Größe ab (Signal 6, gemessen am 2026-09-01). Ein Haken, der auf dem
// Rechner des Entwicklers abstürzt, wird abgeschaltet, nicht repariert.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIST_FILE = new URL("../web/tests/umlaut-words.txt", import.meta.url);

/** Die Suchwörter ohne Kommentar- und Leerzeilen. */
export function loadWords() {
  return readFileSync(LIST_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

// Die Marke, ab der in der Wortliste die ß-Wörter stehen.
//
// ⚠️ WARUM DIESE UNTERSCHEIDUNG SEIN MUSS (#99, gemessen am 2026-09-07). Der
// Vergleich läuft ohne Rücksicht auf Groß- und Kleinschreibung, und für die
// Umlaut-Umschreibungen ist das richtig: `Aenderung` ist derselbe Fehler wie
// `aenderung`. Für ein ß ist es FALSCH. In Großbuchstaben wird das ß seit jeher
// als SS geschrieben — `HEISST`, `WEISS`, `GRÖSSE` und `VON AUSSEN` sind
// korrekt und kein Verstoß. Dieses Repo schreibt seine Warnzeilen in
// Großbuchstaben, und ohne diese Ausnahme meldete der Wächter beim ersten Lauf
// 30 richtig geschriebene Stellen — genau die Fehlalarmquote, an der ein
// Wächter abgeschaltet statt befolgt wird.
//
// ⚠️ NUR das ganze Wort in Großbuchstaben ist ausgenommen. Ein `Gross` am
// Satzanfang bleibt ein Verstoß: dort steht ein einzelner Großbuchstabe am
// Wortanfang, und mitten im Wort gilt die Regel wie sonst auch.
const ESZETT_MARKER = "# ss statt ß";

/**
 * Die Wörter, bei denen ein ß gemeint ist — alles ab der Marke in der Liste.
 *
 * ⚠️ Aus der Reihenfolge der Datei und nicht aus einer zweiten Liste: eine
 * zweite Liste liefe der ersten davon, und ein neu eingetragenes ß-Wort wäre
 * still ohne seine Ausnahme.
 */
export function loadEszettWords() {
  const lines = readFileSync(LIST_FILE, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === ESZETT_MARKER);
  if (start < 0) {
    throw new Error(`Die Marke „${ESZETT_MARKER}" fehlt in der Wortliste — ohne sie gilt keine Ausnahme.`);
  }
  return new Set(
    lines
      .slice(start)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );
}

/**
 * Sucht die Wörter in einem Text. Ganze Wörter, ohne Rücksicht auf
 * Groß-/Kleinschreibung — ohne die Wortgrenzen träfe ein kurzer Eintrag auch
 * mitten in einem längeren Bezeichner, und der Wächter bekäme genau die
 * Fehlalarme, die ihn unbrauchbar machen.
 *
 * Gibt Treffer als `{ line, word }` zurück, Zeilennummern ab 1.
 */
export function findTransliterations(text, words = loadWords(), eszett = loadEszettWords()) {
  const pattern = new RegExp(`\\b(${words.join("|")})\\b`, "giu");
  const findings = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(pattern)) {
      const found = match[1];
      // Ein ß-Wort in Großbuchstaben ist richtig geschrieben — siehe die
      // Begründung an `ESZETT_MARKER`.
      if (eszett.has(found.toLowerCase()) && found === found.toUpperCase() && found !== found.toLowerCase()) continue;
      findings.push({ line: index + 1, word: found });
    }
  });
  return findings;
}

// Die Spuren eines UTF-8-Textes, der als Windows-1252 gelesen und erneut
// kodiert wurde: U+00C3 (A mit Tilde) beginnt jeden Umlaut und das ß, U+00C2
// (A mit Zirkumflex) das geschützte Leerzeichen und §, U+00E2 U+20AC die
// Zeichen aus dem Bereich U+2000 (Gedankenstrich, typografische
// Anführungszeichen). Als Escape-Folgen geschrieben, damit diese Datei den
// Dateiwächter nicht selbst auslöst.
const MOJIBAKE = /\u00C3.|\u00C2.|\u00E2\u20AC./gu;

/**
 * Sucht doppelt kodierte Umlaute. Gibt Treffer als `{ line, sample }` zurück,
 * `sample` ist die betroffene Stelle mit etwas Umgebung, damit die Meldung
 * ohne Nachschlagen lesbar ist.
 */
export function findMojibake(text) {
  const findings = [];
  text.split("\n").forEach((line, index) => {
    const match = line.match(MOJIBAKE);
    if (!match) return;
    const at = line.indexOf(match[0]);
    const sample = line.slice(Math.max(0, at - 12), at + match[0].length + 12).trim();
    findings.push({ line: index + 1, sample });
  });
  return findings;
}

// --- Aufruf über die Kommandozeile ------------------------------------------
//
//   node scripts/check-umlauts.mjs <datei>     der commit-msg-Haken
//   … | node scripts/check-umlauts.mjs -        ein PR-Titel vor dem Merge:
//       gh pr view N --json title -q .title | node scripts/check-umlauts.mjs -
//
// Der Weg über stdin ist der Grund für das `-`: der PR-Titel liegt in keiner
// Datei, und ein Titel als Argument einer Shell-Zeile ist genau der Weg, auf
// dem er 2026-09-04 gekippt ist.

const runAsProgram = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (runAsProgram) {
  const path = process.argv[2];
  if (!path) {
    console.error("Aufruf: node scripts/check-umlauts.mjs <datei>   oder   … | node scripts/check-umlauts.mjs -");
    process.exit(2);
  }
  // Die Kommentarzeilen der Commit-Vorlage gehören nicht zur Nachricht; sie
  // landen ohnehin nicht im Commit.
  const text = readFileSync(path === "-" ? 0 : path, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");

  const transliterations = findTransliterations(text);
  const mojibake = findMojibake(text);
  if (transliterations.length > 0) {
    console.error("check-umlauts: deutsche Wörter in ASCII-Umschreibung gefunden.");
    console.error("");
    for (const match of transliterations) console.error(`  Zeile ${match.line}: ${match.word}`);
    console.error("");
  }
  if (mojibake.length > 0) {
    console.error("check-umlauts: doppelt kodierte Umlaute (Mojibake) gefunden.");
    console.error("");
    for (const match of mojibake) console.error(`  Zeile ${match.line}: …${match.sample}…`);
    console.error("");
    console.error("Der Text ist unterwegs als Windows-1252 gelesen worden. Betreff und PR-Titel");
    console.error("aus einer UTF-8-Datei übergeben (git commit -F, gh … --body-file / --input),");
    console.error("nicht als Argument einer Shell-Zeile.");
    console.error("");
  }
  if (transliterations.length > 0 || mojibake.length > 0) {
    console.error("Umlaute und ß gehören richtig gesetzt — auch im Commit-Betreff (AGENTS.md).");
    process.exit(1);
  }
}
