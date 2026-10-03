import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Wächter für die eine Statusquelle.
//
// Die Rollentrennung steht in AGENTS.md: Issues tragen den Status, `docs/`
// trägt die Begründung — ausdrücklich OHNE Statusangaben. Der Grund ist nicht
// Ordnungsliebe: eine Zeile wie „noch nicht umgesetzt" veraltet still. Sie
// steht danach jahrelang da und widerspricht dem Issue, das sie ersetzt hat,
// und wer sie liest, weiß nicht, welche der beiden Stellen recht hat.
//
// Dieser Test fällt, sobald ein Dokument wieder einen Umsetzungsstand
// behauptet. Er prüft NICHT auf Datumsangaben: „gemessen am 2026-09-01" ist
// ein Nachweis und soll bleiben.

const ROOT = new URL("../../docs/", import.meta.url);

// Verzeichnisse, die per Definition Vergangenheit sind — dort ist Stand der
// Zweck, nicht der Fehler.
const ARCHIVE = new Set(["history", "migrations"]);

// Wendungen, die den aktuellen Stand behaupten. Bewusst kurz gehalten: jede
// muss so eindeutig sein, dass ein Treffer keine Diskussion auslöst.
//
// ⚠️ Wer hier ergänzt, prüft die KÜRZESTE Form der Wendung, nicht die, die ihm
// gerade begegnet ist. „steht noch aus" enthält „steht aus" NICHT — dazwischen
// liegt ein Wort.
const STATUS_PHRASES = [
  "ist live",
  "sind live",
  "live seit",
  "noch nicht umgesetzt",
  "nichts umgesetzt",
  "nichts gebaut",
  "noch offen",
  "steht aus",
  "stehen aus",
  "steht noch aus",
  "stehen noch aus",
  "ist erledigt",
  "ist damit erledigt",
  "bereits erledigt",
  "nächster schritt",
  "naechster schritt"
];

// Ein Häkchen an einem Plan-Schritt ist dieselbe Aussage in kürzerer Form.
const STATUS_MARKS = ["✅", "☑", "✔"];

async function markdownFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ARCHIVE.has(entry.name)) continue;
      found.push(
        ...(await markdownFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`))
      );
    } else if (entry.name.endsWith(".md")) {
      found.push({ path: `${prefix}${entry.name}`, url: new URL(entry.name, directory) });
    }
  }
  return found;
}

test("kein Dokument in docs/ behauptet einen Umsetzungsstand", async () => {
  const files = await markdownFiles(ROOT);
  assert.ok(files.length > 0, "docs/ enthält keine Markdown-Dateien — der Wächter liefe ins Leere");

  const findings = [];
  for (const file of files) {
    const lines = (await readFile(fileURLToPath(file.url), "utf8")).split("\n");
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      for (const phrase of STATUS_PHRASES) {
        if (lower.includes(phrase)) findings.push(`${file.path}:${index + 1} — „${phrase}"`);
      }
      for (const mark of STATUS_MARKS) {
        if (line.includes(mark)) findings.push(`${file.path}:${index + 1} — „${mark}"`);
      }
    });
  }

  assert.deepEqual(
    findings,
    [],
    `Status gehört in Issues, nicht nach docs/:\n${findings.join("\n")}`
  );
});
