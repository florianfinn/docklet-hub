import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MARK_THEME, DEFAULT_STACK_DISPLAY, MARK_IDS_MAX, MARK_NAME_MAX, THEME_KNOBS } from "contract";

import { knobsInScope } from "../../platform/theme/knob-input.js";
import { MARK_KNOBS, STACK_KNOBS, parseMarkIds, parseMarkInput, parseStackDisplay } from "./input.js";

// The check of what the marks surface sends — no database, no router. The
// tests of the global theme and of the colour of an arm stand next to
// `features/appearance/input.ts` (#268).

// ⚠️ Dieselbe Bauart wie in `features/appearance/input.test.ts`: die gültigen Werte kommen aus `THEME_KNOBS` und
// stehen hier nicht abgeschrieben. Die roten Fälle stehen dagegen einzeln da —
// sie sind der Zweck der Datei, und jeder von ihnen ist ein Fehler, den
// jemand tatsächlich schicken kann.

/** Ein vollständiger, gültiger Rumpf für eine Marke. */
function fullMark(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Produktion", ...DEFAULT_MARK_THEME, ...overrides };
}

test("die Reichweiten der Marke und des Stacks sind ebenso abgeleitet", () => {
  assert.deepEqual([...MARK_KNOBS].sort(), Object.keys(DEFAULT_MARK_THEME).sort());
  assert.deepEqual([...STACK_KNOBS].sort(), Object.keys(DEFAULT_STACK_DISPLAY).sort());
  assert.equal(MARK_KNOBS.length, 2);
  assert.equal(STACK_KNOBS.length, 1);
  // ⚠️ Die eigentliche Aussage der Liste in `scope`: derselbe Eintrag `hue`
  // steht in beiden Reichweiten. Ginge das verloren, hätte die Marke keinen
  // Farbton mehr — und niemand merkte es, weil `HOST_KNOBS` weiter stimmte.
  assert.ok(knobsInScope("host").includes("hue"));
  assert.ok((MARK_KNOBS as readonly string[]).includes("hue"));
});

test("jede gültige Stufe jeder Stellschraube einer Marke kommt durch", () => {
  for (const knob of MARK_KNOBS) {
    for (const step of THEME_KNOBS[knob].steps as readonly { name: string }[]) {
      const parsed = parseMarkInput({ mark: fullMark({ [knob]: step.name }) });
      assert.ok(parsed.ok, `${knob} = ${step.name} wurde abgelehnt`);
      assert.equal((parsed.value as unknown as Record<string, string>)[knob], step.name);
    }
  }
});

test("eine vollständige Marke kommt mit gekürztem Namen heraus", () => {
  const parsed = parseMarkInput({ mark: { name: "  Backup nachts  ", hue: "teal", style: "fill" } });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { name: "Backup nachts", hue: "teal", style: "fill" });
});

test("ein leerer Name und ein Name aus Leerzeichen sind beide ein Fehler", () => {
  // ⚠️ Der zweite Fall ist der, den eine Prüfung ohne Kürzen durchließe: eine
  // Marke, die in der Liste als Lücke steht und sich nicht mehr benennen lässt.
  for (const name of ["", "   ", "\t\n"]) {
    const parsed = parseMarkInput({ mark: fullMark({ name }) });
    assert.equal(parsed.ok, false, `„${name}" wurde angenommen`);
  }
});

test("ein Name ohne Zeichenkette ist ein Fehler und wird nicht umgewandelt", () => {
  for (const name of [undefined, null, 42, ["a"], { a: 1 }]) {
    const parsed = parseMarkInput({ mark: fullMark({ name }) });
    assert.equal(parsed.ok, false, `${JSON.stringify(name)} wurde angenommen`);
  }
});

test("ein zu langer Name ist ein Fehler, genau ein Zeichen über der Schranke", () => {
  // Die Grenze wird von BEIDEN Seiten angefasst: eine Schranke, die nur von
  // der falschen Seite geprüft wird, kann um eins verschoben sein, ohne dass
  // ein Test es zeigt.
  const atLimit = parseMarkInput({ mark: fullMark({ name: "a".repeat(MARK_NAME_MAX) }) });
  assert.ok(atLimit.ok, `${MARK_NAME_MAX} Zeichen wurden abgelehnt`);

  const tooLong = parseMarkInput({ mark: fullMark({ name: "a".repeat(MARK_NAME_MAX + 1) }) });
  assert.equal(tooLong.ok, false);
  assert.ok(tooLong.ok === false && tooLong.message.includes(String(MARK_NAME_MAX)));
});

test("die Ränder werden vor der Längenprüfung gekürzt", () => {
  // Sonst wäre ein Name, der nur wegen seiner Leerzeichen zu lang ist, ein
  // 400 — und der Betreiber sähe eine Meldung über eine Länge, die er nicht
  // eingegeben hat.
  const parsed = parseMarkInput({ mark: fullMark({ name: `   ${"a".repeat(MARK_NAME_MAX)}   ` }) });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.name.length, MARK_NAME_MAX);
});

test("ein unbekannter Schlüssel und eine unbekannte Stufe der Marke sind Fehler", () => {
  const unknownKey = parseMarkInput({ mark: fullMark({ colour: "teal" }) });
  assert.equal(unknownKey.ok, false);
  assert.ok(unknownKey.ok === false && unknownKey.message.includes("colour"));

  const unknownStep = parseMarkInput({ mark: fullMark({ style: "ghost" }) });
  assert.equal(unknownStep.ok, false);
  assert.ok(unknownStep.ok === false && unknownStep.message.includes("ghost"));

  const unknownHue = parseMarkInput({ mark: fullMark({ hue: "gold" }) });
  assert.equal(unknownHue.ok, false);
});

test("eine halbe Marke ist ein Fehler und wird nicht mit der Vorgabe aufgefüllt", () => {
  const withoutStyle = parseMarkInput({ mark: { name: "Produktion", hue: "teal" } });
  assert.equal(withoutStyle.ok, false);

  const withoutName = parseMarkInput({ mark: { ...DEFAULT_MARK_THEME } });
  assert.equal(withoutName.ok, false);

  const withoutEnvelope = parseMarkInput(fullMark());
  assert.equal(withoutEnvelope.ok, false);
});

test("jede gültige Stufe der Einrückung kommt durch", () => {
  for (const step of THEME_KNOBS.indent.steps) {
    const parsed = parseStackDisplay({ display: { indent: step.name } });
    assert.ok(parsed.ok, `indent = ${step.name} wurde abgelehnt`);
    assert.deepEqual(parsed.value, { indent: step.name });
  }
});

test("eine unbekannte Einrückung, ein fremder Schlüssel und ein fehlender Umschlag sind Fehler", () => {
  assert.equal(parseStackDisplay({ display: { indent: "deep" } }).ok, false);
  assert.equal(parseStackDisplay({ display: { indent: "flat", hue: "teal" } }).ok, false);
  assert.equal(parseStackDisplay({ indent: "flat" }).ok, false);
  assert.equal(parseStackDisplay({ display: {} }).ok, false);
  assert.equal(parseStackDisplay(null).ok, false);
});

test("eine Liste von Marken kommt in ihrer Reihenfolge durch", () => {
  // ⚠️ Die Reihenfolge IST die Angabe. Ein Server, der sortiert, antwortete
  // mit einer anderen Liste, als er bekommen hat.
  const parsed = parseMarkIds({ markIds: ["m-3", "m-1", "m-2"] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, ["m-3", "m-1", "m-2"]);
});

test("die leere Liste ist gültig — sie zieht die letzte Marke ab", () => {
  const parsed = parseMarkIds({ markIds: [] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, []);
});

test("eine Dublette in der Liste ist ein Fehler und kein stilles Zusammenziehen", () => {
  const parsed = parseMarkIds({ markIds: ["m-1", "m-2", "m-1"] });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.ok === false && parsed.message.includes("m-1"));
});

test("zu viele Marken sind ein Fehler, genau ein Eintrag über der Schranke", () => {
  const ids = Array.from({ length: MARK_IDS_MAX }, (_value, index) => `m-${index}`);
  assert.ok(parseMarkIds({ markIds: ids }).ok, `${MARK_IDS_MAX} Marken wurden abgelehnt`);

  const tooMany = parseMarkIds({ markIds: [...ids, "m-mehr"] });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.ok === false && tooMany.message.includes(String(MARK_IDS_MAX)));
});

test("ein Eintrag, der keine nichtleere Zeichenkette ist, ist ein Fehler", () => {
  for (const entry of ["", 7, null, undefined, ["m-1"], { id: "m-1" }]) {
    const parsed = parseMarkIds({ markIds: ["m-1", entry] });
    assert.equal(parsed.ok, false, `${JSON.stringify(entry)} wurde angenommen`);
  }
});

test("ein Rumpf ohne markIds, mit fremdem Schlüssel oder ohne Feld ist ein Fehler", () => {
  assert.equal(parseMarkIds({}).ok, false);
  assert.equal(parseMarkIds({ marks: ["m-1"] }).ok, false);
  assert.equal(parseMarkIds({ markIds: "m-1" }).ok, false);
  assert.equal(parseMarkIds({ markIds: ["m-1"], hostId: "h-1" }).ok, false);
  assert.equal(parseMarkIds(["m-1"]).ok, false);
  assert.equal(parseMarkIds(null).ok, false);
});
