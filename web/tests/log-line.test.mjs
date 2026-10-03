import assert from "node:assert/strict";
import test from "node:test";

import { parseAnsi, stripAnsi } from "../src/features/logs/log-line/ansi.ts";
import { detectLevel } from "../src/features/logs/log-line/log-level.ts";
import { shortTime } from "../src/features/logs/log-line/LogRow.tsx";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Farben im Log-Feld (Wunsch des Betreibers vom 2026-09-29, Vorbild
// Dozzle) hängen an zwei reinen Funktionen: dem Leser der ANSI-Folgen und der
// Erkennung der Stufe. Beide werden hier an Zeilen geprüft, wie sie am
// 2026-09-29 auf den Armen standen — nicht an erfundenen.
//
// ⚠️ DAS ESC ENTSTEHT ÜBER `String.fromCharCode`, aus demselben Grund wie im
// Leser: kein Steuerzeichen in einer Quelldatei.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const sgr = (codes) => `${ESC}[${codes}m`;

test("eine Zeile ohne ESC ist ein Abschnitt ohne Stil", () => {
  const segments = parseAnsi("[Info] RssSyncService: Starting RSS Sync");
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "[Info] RssSyncService: Starting RSS Sync");
  assert.equal(segments[0].style.fg, null);
  assert.deepEqual(parseAnsi(""), []);
});

test("overseerr: die Stufe in Blau, der Rest ohne Farbe, kein ESC im Text", () => {
  const line = `2026-09-29T15:48:00.005Z ${sgr(34)}debug${sgr(39)}[Jobs]: Starting scheduled job: Download Sync`;
  const segments = parseAnsi(line);
  assert.deepEqual(
    segments.map((segment) => [segment.text, segment.style.fg]),
    [
      ["2026-09-29T15:48:00.005Z ", null],
      ["debug", "var(--terminal-ansi-blue)"],
      ["[Jobs]: Starting scheduled job: Download Sync", null]
    ]
  );
  assert.ok(!segments.some((segment) => segment.text.includes(ESC)), "ein ESC blieb im Text");
});

test("hell, fett, 256 Farben, 24 Bit und das Zurücksetzen", () => {
  const segments = parseAnsi(`${sgr("1;91")}a${sgr("38;5;208")}b${sgr("38;2;1;2;3;48;5;4")}c${sgr(0)}d`);
  assert.deepEqual(
    segments.map((segment) => [segment.text, segment.style.fg, segment.style.bg, segment.style.bold]),
    [
      ["a", "var(--terminal-ansi-bright-red)", null, true],
      ["b", "rgb(255, 135, 0)", null, true],
      ["c", "rgb(1, 2, 3)", "var(--terminal-ansi-blue)", true],
      ["d", null, null, false]
    ]
  );
});

test("andere Steuerfolgen fallen weg, eine abgeschnittene verschluckt nichts davor", () => {
  assert.equal(stripAnsi(`${ESC}[2Kvor${ESC}]0;Titel${BEL}nach`), "vornach");
  assert.equal(stripAnsi(`Anfang ${ESC}[3`), "Anfang ");
  assert.equal(stripAnsi(`${ESC}(Bx`), "x");
});

test("die Stufe der Logger, die auf den Armen laufen", () => {
  const cases = [
    ["2026/09/15 17:15:14.456801 [error] dnsproxy: response received", "error", "error"],
    ["[Info] RssSyncService: Starting RSS Sync", "info", "Info"],
    ["2026-09-29T15:48:00.005Z debug[Jobs]: Starting scheduled job", "debug", "debug"],
    ['time=2026-09-29T10:00:00Z level=warn msg="disk almost full"', "warn", "warn"],
    ['{"level":"error","msg":"boom"}', "error", "error"],
    ["[10:00:00 WRN] Retrying", "warn", "WRN"],
    ["WARNING: something", "warn", "WARNING"]
  ];
  for (const [line, level, word] of cases) {
    const match = detectLevel(line);
    assert.ok(match !== null, `keine Stufe in „${line}"`);
    assert.equal(match.level, level, line);
    assert.equal(line.slice(match.start, match.end), word, line);
  }
});

test("kein Wort ohne Grenze, und nichts weit hinten", () => {
  assert.equal(detectLevel("Information about stderr handling"), null);
  assert.equal(detectLevel("Starting scheduled job: Download Sync"), null);
  assert.equal(detectLevel(`${"x".repeat(200)} [error] zu spät`), null);
});

test("der Zeitstempel wird gekürzt und nicht umgerechnet", () => {
  assert.equal(shortTime("2026-09-29T15:48:00.005415817Z"), "2026-09-29 15:48:00.005Z");
  assert.equal(shortTime("2026-09-29T15:48:00Z"), "2026-09-29 15:48:00.000Z");
  assert.equal(shortTime("gestern"), "gestern");
});
