import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LINES, diffLines } from "../src/features/compose/text-diff.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Vergleich ist Eigenbau, und ein Vergleich ist die Art Code, die bei den
// zehn Beispielen stimmt, an die der Autor gedacht hat, und beim elften still
// falsch liegt. Deshalb stehen hier ZWEI EIGENSCHAFTEN über zufällige
// Eingaben und erst danach die benannten Fälle:
//
//   1. WIEDERHERSTELLBARKEIT. Nimmt man alle Zeilen ausser den hinzugefügten,
//      muss der ALTE Text herauskommen; nimmt man alle ausser den entfernten,
//      der NEUE. Ein Vergleich, der eine Zeile verliert oder erfindet, fällt
//      hier — und zwar bei JEDER Eingabe, nicht nur bei den bedachten.
//   2. DIE ZEILENNUMMERN ZÄHLEN LÜCKENLOS. Sie stehen in der Anzeige neben
//      jeder Zeile; eine, die springt, schickt den Betreiber an die falsche
//      Stelle seiner Datei.

/** Der alte Text, aus dem Vergleich zurückgewonnen. */
function rebuildOld(result) {
  return result.lines.filter((line) => line.kind !== "add").map((line) => line.text).join("\n");
}

/** Der neue Text, aus dem Vergleich zurückgewonnen. */
function rebuildNew(result) {
  return result.lines.filter((line) => line.kind !== "remove").map((line) => line.text).join("\n");
}

/** Ein einfacher, aussaatgesteuerter Zufall — damit ein Fehlschlag wiederholbar ist. */
function randomFrom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function randomText(random, lines, alphabet) {
  const out = [];
  for (let index = 0; index < lines; index += 1) {
    out.push(alphabet[Math.floor(random() * alphabet.length)]);
  }
  return out.join("\n");
}

test("was hineingeht, kommt wieder heraus — über 300 zufällige Paare", () => {
  const random = randomFrom(20260907);
  const alphabet = ["a", "b", "c", "  image: x", "  image: y", "", "services:", "\treingerückt"];
  for (let round = 0; round < 300; round += 1) {
    const before = randomText(random, Math.floor(random() * 25), alphabet);
    const after = randomText(random, Math.floor(random() * 25), alphabet);
    const result = diffLines(before, after);
    assert.equal(rebuildOld(result), before, `alter Stand verloren, Runde ${round}`);
    assert.equal(rebuildNew(result), after, `neuer Stand verloren, Runde ${round}`);
  }
});

test("die Zeilennummern zählen lückenlos, in beiden Ständen", () => {
  const random = randomFrom(4711);
  const alphabet = ["eins", "zwei", "drei", "vier", ""];
  for (let round = 0; round < 200; round += 1) {
    const before = randomText(random, Math.floor(random() * 20), alphabet);
    const after = randomText(random, Math.floor(random() * 20), alphabet);
    const result = diffLines(before, after);

    let expectedOld = 1;
    let expectedNew = 1;
    for (const line of result.lines) {
      if (line.kind !== "add") {
        assert.equal(line.oldLine, expectedOld, `alte Nummer springt, Runde ${round}`);
        expectedOld += 1;
      } else {
        assert.equal(line.oldLine, null, "eine hinzugefügte Zeile hat keine alte Nummer");
      }
      if (line.kind !== "remove") {
        assert.equal(line.newLine, expectedNew, `neue Nummer springt, Runde ${round}`);
        expectedNew += 1;
      } else {
        assert.equal(line.newLine, null, "eine entfernte Zeile hat keine neue Nummer");
      }
    }
  }
});

test("zwei gleiche Texte ergeben keinen Unterschied", () => {
  const text = "services:\n  sonarr:\n    image: sonarr:1\n";
  const result = diffLines(text, text);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.ok(result.lines.every((line) => line.kind === "equal"));
});

test("eine geänderte Zeile in der Mitte bleibt EINE geänderte Zeile", () => {
  // ⚠️ Der Fall, an dem sich ein Vergleich beweist. Ein schlechter meldet hier
  // „alles ab Zeile 3 ist neu" — richtig, aber unbrauchbar: der Betreiber
  // sucht dann in fünf Zeilen nach der einen, die er geändert hat.
  const before = "a\nb\nc\nd\ne\n";
  const after = "a\nb\nX\nd\ne\n";
  const result = diffLines(before, after);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual(
    result.lines.filter((line) => line.kind !== "equal").map((line) => line.text),
    ["c", "X"]
  );
});

test("ein Leerzeichen am Zeilenende ist ein Unterschied und wird nicht weggeputzt", () => {
  // ⚠️ Der Agent bildet den Hash über die BYTES. Ein Vergleich, der Leerraum
  // normalisiert, zeigte „keine Änderung" für eine Bearbeitung, die den Hash
  // ändert — und der Betreiber wendete an, ohne zu wissen, was.
  const result = diffLines("image: a\n", "image: a \n");
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
});

test("ein Zeilenende in Windows-Form ist eine andere Zeile", () => {
  const result = diffLines("a\nb\n", "a\r\nb\n");
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
});

test("ein leerer Stand gegen einen vollen ist nur Hinzufügen", () => {
  const result = diffLines("", "a\nb\n");
  assert.equal(result.removed, 0);
  assert.equal(rebuildNew(result), "a\nb\n");
});

test("über dem Deckel sagt der Vergleich, dass er keiner mehr ist", () => {
  // ⚠️ `capped` MUSS in der Anzeige ankommen. Ein Vergleich, der ohne Hinweis
  // behauptet, jede Zeile habe sich geändert, ist eine Falschaussage über die
  // Bearbeitung — der Betreiber sucht dann eine Änderung, die er nie gemacht
  // hat.
  const huge = Array.from({ length: MAX_LINES + 1 }, (_, index) => `Zeile ${index}`).join("\n");
  const result = diffLines(huge, `${huge}\nnoch eine`);
  assert.equal(result.capped, true);
  assert.equal(rebuildOld(result), huge);
});
