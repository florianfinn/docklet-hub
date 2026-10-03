import assert from "node:assert/strict";
import test from "node:test";

import { BOTTOM_SLACK, stuckAfterScroll } from "../src/features/logs/log-line/stick-to-bottom.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Logansichten lösten sich beim Öffnen selbst vom unteren Rand (#230):
// das `scroll`-Ereignis des eigenen Sprungs kam an, als schon neue Zeilen
// darunter standen, und der Abstand zum Ende allein entschied. Ob ein Feld
// wirklich rollt, kann happy-dom nicht zeigen (kein Layout, #96 A2) — die
// Entscheidung aus den drei Maßen aber schon, und sie ist der Fehler gewesen.

const HEIGHT = 700;

/** Ein Feld, das bei `top` steht und `content` Pixel Inhalt hat. */
function at(top, content) {
  return { scrollTop: top, scrollHeight: content, clientHeight: HEIGHT };
}

test("der eigene Sprung löst die Ansicht nicht, auch wenn darunter Zeilen dazugekommen sind", () => {
  // Geheftet bei 9.300 (Inhalt 10.000), das Ereignis kommt bei 12.000 Inhalt an.
  const pinned = 10_000 - HEIGHT;
  assert.equal(stuckAfterScroll(true, at(pinned, 12_000), pinned), true);
});

test("genau dieser Fall löste die Ansicht vor #230", () => {
  // Die alte Regel: nur der Abstand zum Ende. Der Testfall hält fest, dass der
  // Abstand hier tatsächlich über der Toleranz liegt — sonst prüfte der Fall
  // davor nichts.
  const metrics = at(10_000 - HEIGHT, 12_000);
  assert.ok(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight > BOTTOM_SLACK);
});

test("wer nach oben rollt, löst die Ansicht", () => {
  const pinned = 10_000 - HEIGHT;
  assert.equal(stuckAfterScroll(true, at(pinned - 200, 10_000), pinned), false);
});

test("ein Ruck innerhalb der Toleranz löst nicht", () => {
  const pinned = 10_000 - HEIGHT;
  assert.equal(stuckAfterScroll(true, at(pinned - BOTTOM_SLACK, 10_400), pinned), true);
  assert.equal(stuckAfterScroll(true, at(pinned - BOTTOM_SLACK - 1, 10_400), pinned), false);
});

test("wer sich gelöst hat und selbst bis ans Ende rollt, klebt wieder", () => {
  assert.equal(stuckAfterScroll(false, at(10_000 - HEIGHT - 10, 10_000), null), true);
});

test("wer sich gelöst hat und irgendwo liest, bleibt gelöst — auch unterhalb der alten Heftstelle", () => {
  assert.equal(stuckAfterScroll(false, at(5_000, 10_000), 4_000), false);
  assert.equal(stuckAfterScroll(false, at(5_000, 10_000), null), false);
});

test("ohne Heftstelle entscheidet der Abstand allein", () => {
  assert.equal(stuckAfterScroll(true, at(5_000, 10_000), null), false);
  assert.equal(stuckAfterScroll(true, at(10_000 - HEIGHT, 10_000), null), true);
});
