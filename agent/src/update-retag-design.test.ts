import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("target design states host-wide retag semantics and later Compose behavior", () => {
  const design = fs.readFileSync(new URL("../../docs/design/update-and-rollback.md", import.meta.url), "utf8");
  for (const sentence of [
    "Dieser Tag gilt\nhostweit, auch für andere Container und Projekte mit derselben Referenz.",
    "Ein späteres `compose up` verwendet nach erfolgreichem Rückweg bei unveränderter Projektdefinition das alte Image, weil die ursprüngliche Referenz auf dessen Image-ID zeigt.",
    "Scheitert nach dem Retag das Erzeugen, zeigt die Referenz trotzdem auf das alte Image; ein späteres `compose up` versucht daher bei unveränderter Projektdefinition dieses alte Image zu erzeugen.",
    "Der dabei entstehende Vorfall nennt diesen Tag-Stand.",
    "Nach einem Pull ohne Austausch bleibt der Tag auf dem neuen Image; ein späteres `compose up` kann es deshalb entsprechend der Projektdefinition verwenden.",
    "Pull oder Retag die Referenz verändert.",
    "Es gibt keine Sperre je Image-Referenz.",
    "auf verschiedenen Zielen werden über die Image-ID-Prüfung nach dem Erzeugen\nsicher erkannt"
  ]) assert.equal(design.includes(sentence), true, sentence);
});
