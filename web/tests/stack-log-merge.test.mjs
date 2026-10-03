import assert from "node:assert/strict";
import test from "node:test";

import { initialSelection, insertByTime, timeKey } from "../src/features/logs/stack-log-merge.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Reiter „Protokoll" der Stack-Seite (#183) mischt mehrere Ströme nach
// Zeitstempel. Die Reihenfolge ist seine eine Zusage, und sie liegt in einer
// reinen Funktion — hier ohne React und ohne DOM geprüft.

let counter = 0;
function line(ts, service = "a", containerId = service) {
  counter += 1;
  return { stream: "stdout", ts, text: `${service}@${ts}`, service, containerId, seq: counter, order: timeKey(ts) };
}

function merge(lines, cap = 100) {
  let held = [];
  let dropped = 0;
  for (const entry of lines) {
    const next = insertByTime(held, entry, cap);
    held = next.lines;
    dropped += next.dropped;
  }
  return { held, dropped };
}

test("der Schlüssel füllt den Bruchteil auf neun Stellen auf", () => {
  assert.equal(timeKey("2026-09-29T10:00:03Z"), "2026-09-29T10:00:03.000000000Z");
  assert.equal(timeKey("2026-09-29T10:00:03.5Z"), "2026-09-29T10:00:03.500000000Z");
  assert.equal(timeKey("2026-09-29T10:00:03.123456789Z"), "2026-09-29T10:00:03.123456789Z");
  // Was nicht passt, bleibt stehen und fällt nicht weg.
  assert.equal(timeKey("kaputt"), "kaputt");
});

test("die ganze Sekunde steht vor ihrem eigenen Bruchteil", () => {
  // ⚠️ Der Fall, an dem der rohe Zeichenkettenvergleich scheitert: `Z` ist
  // größer als `.`, und `…03Z` sortierte hinter `…03.1Z`.
  const { held } = merge([line("2026-09-29T10:00:03.1Z"), line("2026-09-29T10:00:03Z")]);
  assert.deepEqual(held.map((entry) => entry.ts), ["2026-09-29T10:00:03Z", "2026-09-29T10:00:03.1Z"]);
});

test("ungleich lange Bruchteile sortieren nach der Zeit", () => {
  const { held } = merge([line("2026-09-29T10:00:03.56Z"), line("2026-09-29T10:00:03.5Z")]);
  assert.deepEqual(held.map((entry) => entry.ts), ["2026-09-29T10:00:03.5Z", "2026-09-29T10:00:03.56Z"]);
});

test("zwei Ströme, die sich überlappen, ergeben einen sortierten", () => {
  const first = ["01", "03", "05", "07"].map((s) => line(`2026-09-29T10:00:${s}Z`, "a"));
  const second = ["02", "04", "06"].map((s) => line(`2026-09-29T10:00:${s}Z`, "b"));
  // Erst der ganze erste Strom, dann schiebt der zweite seine Vergangenheit
  // nach — so, wie ein später geöffneter Strom sie beim Öffnen liefert.
  const { held } = merge([...first, ...second]);
  assert.deepEqual(
    held.map((entry) => entry.service),
    ["a", "b", "a", "b", "a", "b", "a"]
  );
});

test("gleicher Zeitstempel: die Ankunft entscheidet", () => {
  const early = line("2026-09-29T10:00:03Z", "a");
  const late = line("2026-09-29T10:00:03Z", "b");
  const { held } = merge([early, late]);
  assert.deepEqual(held.map((entry) => entry.service), ["a", "b"]);
});

test("über dem Deckel fallen die ältesten Zeilen", () => {
  const lines = ["05", "01", "03", "04", "02"].map((s) => line(`2026-09-29T10:00:${s}Z`));
  const { held, dropped } = merge(lines, 3);
  assert.equal(dropped, 2);
  assert.deepEqual(held.map((entry) => entry.ts.slice(-3)), ["03Z", "04Z", "05Z"]);
});

test("die Vorauswahl nimmt alle, die laufenden zuerst", () => {
  const containers = [
    { id: "stopped-1", running: false },
    { id: "run-1", running: true },
    { id: "run-2", running: true },
    { id: "stopped-2", running: false }
  ];
  assert.deepEqual(initialSelection(containers), ["run-1", "run-2", "stopped-1", "stopped-2"]);
  assert.deepEqual(initialSelection([]), []);
});
