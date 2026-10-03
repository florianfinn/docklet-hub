import test from "node:test";
import assert from "node:assert/strict";

import { readTerminalSize } from "./terminal-size.js";

// ── Die Fenstergröße aus dem Anfragekörper ──────────────────────────────────

test("die übliche Größe kommt unverändert durch", () => {
  assert.deepEqual(readTerminalSize({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
});

test("ohne brauchbare Angabe gilt die Vorgabe des Agenten, 80 x 24", () => {
  assert.deepEqual(readTerminalSize({}), { cols: 80, rows: 24 });
  assert.deepEqual(readTerminalSize(undefined), { cols: 80, rows: 24 });
  assert.deepEqual(readTerminalSize(null), { cols: 80, rows: 24 });
  assert.deepEqual(readTerminalSize({ cols: null, rows: null }), { cols: 80, rows: 24 });
});

test("etwas, das keine Zahl ist, fällt auf die Vorgabe statt als null beim Agenten zu landen", () => {
  // ⚠️ Der eigentliche Befund aus dem Quellsystem: `Number("x")` ist NaN, und
  // `JSON.stringify` schreibt NaN als `null` in den Körper an den Agenten.
  assert.deepEqual(readTerminalSize({ cols: "x", rows: "y" }), { cols: 80, rows: 24 });
  // ⚠️ `Number([])` ist 0 und nicht NaN — ohne die Typprüfung VOR `Number`
  // ginge `{"rows":[]}` als eine Zeile durch.
  assert.deepEqual(readTerminalSize({ cols: {}, rows: [] as unknown }), { cols: 80, rows: 24 });
  assert.deepEqual(readTerminalSize({ cols: Infinity, rows: -Infinity }), { cols: 80, rows: 24 });
  assert.deepEqual(readTerminalSize({ cols: true, rows: false }), { cols: 80, rows: 24 });
});

test("eine Zahl als Zeichenkette bleibt brauchbar, Bruchteile werden abgeschnitten", () => {
  assert.deepEqual(readTerminalSize({ cols: "120", rows: "40" }), { cols: 120, rows: 40 });
  assert.deepEqual(readTerminalSize({ cols: 120.9, rows: 40.2 }), { cols: 120, rows: 40 });
});

test("zu klein und zu groß werden NICHT geklemmt — das tut der Agent", () => {
  // ⚠️ ABWEICHUNG VON DER QUELLE, mit Grund. Sie klemmte auf `1…1000`; dieser
  // Agent klemmt selbst auf 8…500 Spalten und 4…300 Zeilen. Eine zweite Klemme
  // hier wäre die zweite Wahrheit über eine fremde Grenze — und sie träfe
  // andere Zahlen als die, die tatsächlich gelten.
  assert.deepEqual(readTerminalSize({ cols: 0, rows: -5 }), { cols: 0, rows: -5 });
  assert.deepEqual(readTerminalSize({ cols: 1e9, rows: 1e9 }), { cols: 1e9, rows: 1e9 });
});
