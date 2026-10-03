import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Die Bestandsgrenze aus AGENTS.md als Sperrklinke statt als Absatz.
//
// Warum überhaupt: im Quellsystem liegen 15 getrackte Quelldateien über der
// Grenze, die größte bei über 9.000 Zeilen. Keine davon ist an einem Tag so
// geworden. Eine Datei wächst je Änderung um ein paar Zeilen, und niemand hat
// je den Moment gesehen, in dem sie zu groß wurde — genau deshalb misst das
// hier eine Maschine und kein Mensch.
//
// ⚠️ Die Grenze gilt auch für übernommene Dateien. Eine Kopie, die sie schon
// beim Ankommen reißt, wird BEIM Kopieren aufgeteilt. Wer sie hier hochsetzt,
// um eine Übernahme durchzubekommen, hat die Regel abgeschafft, nicht erfüllt.

const LIMIT = 1000;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("keine getrackte Quelldatei liegt über 1.000 Zeilen", () => {
  const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs", "*.js"], {
    cwd: ROOT,
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean);

  assert.ok(files.length > 0, "git ls-files lieferte nichts — der Wächter liefe ins Leere");

  const tooLarge = files
    .map((path) => ({ path, lines: readFileSync(new URL(path, `file://${ROOT}`), "utf8").split("\n").length }))
    .filter((file) => file.lines > LIMIT)
    .sort((a, b) => b.lines - a.lines)
    .map((file) => `${file.path}: ${file.lines} Zeilen`);

  assert.deepEqual(tooLarge, [], `Über der Grenze von ${LIMIT} Zeilen:\n${tooLarge.join("\n")}`);
});
