import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Wächter über Steuerzeichen in Quelldateien.
//
// ⚠️ WARUM ES IHN GIBT — ZWEIMAL GEMESSEN, ZWEIMAL AN DERSELBEN STELLE
// VORBEIGELAUFEN. In Paket #98 stand ein NUL-Byte in einer frisch geschriebenen
// Datei; in Paket B5 (#5) waren es drei in einer neuen `.tsx`. In beiden Fällen
// blieben `tsc`, ESLint, `vite build` und die eigenen Testfälle der Datei GRÜN.
// Gefunden hat es beide Male ein Mensch beziehungsweise ein Agent, der aus
// einem anderen Grund hinsah — beim ersten Mal an einer Diffstat-Zeile, beim
// zweiten Mal, weil `grep` „binary file matches" sagte.
//
// Zweimal in Folge ist kein Einzelfall mehr, sondern die Regel bei neu
// geschriebenen Dateien. Bis hierher stand in jedem Bauauftrag dieses Repos ein
// Prüfbefehl von Hand — eine Krücke, die vergessen wird, sobald niemand mehr
// daran denkt. Dieser Fall ersetzt sie.
//
// ⚠️ WARUM KEINE DER BESTEHENDEN KETTEN DAS SIEHT:
//   * `tsc` und ESLint lesen den Quelltext als UTF-8-Zeichenstrom. Ein NUL ist
//     dort ein gültiges Zeichen — in einem Kommentar oder einer Zeichenkette
//     fällt es durch jede Syntaxprüfung.
//   * `vite build` bündelt es mit und liefert es aus.
//   * Die Textwächter dieses Repos suchen WÖRTER. Ein Steuerzeichen ist keines.
//   * `git` selbst hält die Datei ab einer gewissen Dichte für binär und zeigt
//     dann keinen Diff mehr — genau dann, wenn man ihn am nötigsten bräuchte.
//
// ⚠️ WAS ER NICHT PRÜFT, und zwar absichtlich:
//   * `\t`, `\n`, `\r` (0x09, 0x0A, 0x0D). Der Tabulator steht in Makefiles und
//     in manchen Textdateien; die Zeilenenden sind Sache von `.gitattributes`
//     und nicht dieses Falls. Ein Wächter, der zwei Fragen gleichzeitig stellt,
//     beantwortet keine davon deutlich.
//   * Binärdateien. Sie sind hier durch die Auswahl der Endungen ausgeschlossen
//     und nicht durch eine Inhaltsprüfung: „sieht binär aus" ist genau die
//     Heuristik, an der der Fehler bisher vorbeigekommen ist.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// The patterns of the umlaut guard plus the file kinds only this guard reads:
// stylesheets, HTML, plain JS and the Git hooks are source too. JSON is in both
// since the umlaut guard took it in (#285: a mojibake dash in a tsconfig).
const PATTERNS = [
  "*.md",
  "*.ts",
  "*.tsx",
  "*.mjs",
  "*.js",
  "*.json",
  "*.css",
  "*.html",
  "*.sh",
  "*.sql",
  "*.yml",
  "*.yaml",
  "*.txt",
  "Dockerfile",
  ".githooks/*"
];

/**
 * Die Steuerzeichen, die in einer Quelldatei nichts zu suchen haben.
 *
 * C0 ohne Tabulator, Zeilenvorschub und Wagenrücklauf, dazu DEL (0x7F).
 *
 * ⚠️ Als Prüfung auf dem BYTE-Strom und nicht auf dem Zeichenstrom: `readFile`
 * mit `utf8` ersetzt ungültige Folgen still durch das Ersatzzeichen, und ein
 * NUL überlebt diese Reise unverändert — aber eine kaputte Mehrbyte-Folge nicht,
 * und dann meldete der Fall eine Stelle, die es so im Bestand gar nicht gibt.
 */
function isForbidden(byte) {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte < 0x20 || byte === 0x7f;
}

/**
 * Sucht verbotene Steuerzeichen in einem Puffer.
 *
 * Gibt `{ line, column, byte }` zurück, Zeilennummern ab 1 — dieselbe Form wie
 * `findTransliterations`, damit die Meldungen beider Wächter gleich aussehen.
 */
export function findControlCharacters(buffer) {
  const findings = [];
  let line = 1;
  let column = 1;
  for (const byte of buffer) {
    if (byte === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }
    if (isForbidden(byte)) findings.push({ line, column, byte });
    column += 1;
  }
  return findings;
}

function describe(byte) {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}

test("der Erkenner selbst: Steuerzeichen ja, Tabulator und Umbruch nein", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung — und dieser hier wird im
  // Normalfall NIE rot. Ohne diesen Fall sähe ein kaputter Erkenner genauso aus
  // wie ein sauberer Bestand.
  const withNul = Buffer.from([0x61, 0x00, 0x62]);
  assert.deepEqual(findControlCharacters(withNul), [{ line: 1, column: 2, byte: 0x00 }]);

  // Die Zeilennummer zeigt auf die Zeile und nicht auf den Dateianfang.
  const secondLine = Buffer.from([0x61, 0x0a, 0x62, 0x07]);
  assert.deepEqual(findControlCharacters(secondLine), [{ line: 2, column: 2, byte: 0x07 }]);

  // ⚠️ Der wichtigste Fall ist der, in dem NICHTS gemeldet wird: Tabulator,
  // Umbruch und Wagenrücklauf sind Bestand dieses Repos. Meldete der Erkenner
  // sie, wäre er beim ersten Lauf über tausendfach rot und damit erledigt.
  assert.deepEqual(findControlCharacters(Buffer.from("a\tb\r\nc\n")), []);

  // Ein deutscher Umlaut ist zwei Bytes, beide über 0x7f — kein Befund.
  assert.deepEqual(findControlCharacters(Buffer.from("Wächter, größer", "utf8")), []);

  // DEL ist kein Steuerzeichen unter 0x20 und fiele durch eine naive Prüfung.
  assert.deepEqual(findControlCharacters(Buffer.from([0x7f])), [{ line: 1, column: 1, byte: 0x7f }]);
});

test("keine Quelldatei trägt ein Steuerzeichen", () => {
  const files = execFileSync("git", ["ls-files", ...PATTERNS], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  // ⚠️ Ohne diese Zusicherung wäre der Fall grün, sobald `git ls-files` nichts
  // mehr liefert — ein umbenanntes Verzeichnis, ein Muster, das nicht mehr
  // trifft. „Nichts gefunden" ist eine Aussage über den Sucher, solange nicht
  // feststeht, dass er sucht.
  assert.ok(files.length > 200, `git ls-files lieferte nur ${files.length} Dateien — der Wächter liefe ins Leere`);

  const findings = [];
  for (const path of files) {
    const buffer = readFileSync(new URL(path, `file://${ROOT}`));
    for (const match of findControlCharacters(buffer)) {
      findings.push(`${path}:${match.line}:${match.column} — ${describe(match.byte)}`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    "Steuerzeichen in einer Quelldatei. Sie entstehen beim Schreiben durch ein Werkzeug, nicht " +
      "durch einen Menschen, und keine andere Prüfung dieses Repos sieht sie — `tsc`, ESLint und " +
      "der Bau bleiben grün. Entfernen, nicht ersetzen: an dieser Stelle war nie ein Zeichen " +
      `gemeint.\n${findings.join("\n")}`
  );
});
