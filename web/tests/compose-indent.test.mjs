import assert from "node:assert/strict";
import test from "node:test";

import { INDENT_WIDTH, indentEdit, outdentEdit } from "../src/features/compose/compose-indent.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Einrückung des Compose-Editors (#135) ist Rechnung an Zeichenpositionen,
// und ihre Fehler sind still: eine Zeile zu weit, ein Leerzeichen zu viel, der
// Cursor eine Stelle daneben. Nichts davon wirft, nichts davon färbt sich rot —
// es steht in der Datei, die als nächstes an `compose up` geht.
//
// Vier Fälle, jeder mit einem eigenen Grund:
//
//   1. DIE STUFE LIEGT AUF DER STUFE. Ein Tab in Spalte 3 rückt um EIN
//      Leerzeichen ein und nicht um zwei. Die feste Breite wäre die
//      naheliegende Bauart, und in YAML stünde die Datei nach dem dritten Tab
//      krumm.
//   2. DIE AUSWAHL AUF DEM UMBRUCH NIMMT DIE NÄCHSTE ZEILE NICHT MIT. Wer drei
//      Zeilen markiert, markiert bis zum Anfang der vierten — eine Rechnung
//      über `endOfLine(end)` rückte vier ein.
//   3. AUSRÜCKEN GIBT `null` ZURÜCK, WENN NICHTS DA IST. Daran hängt der Weg
//      rückwärts aus dem Feld: gäbe die Rechnung eine leere Ersetzung zurück,
//      schluckte das Bauteil die Taste und die Tastaturbedienung endete hier.
//   4. DER BEREICH IST EIN BEREICH UND KEIN GESAMTTEXT. Das Bauteil setzt ihn
//      über `insertText` ein und hält damit das Rückgängig des Browsers; eine
//      Ersetzung, die von 0 bis zum Textende ginge, wäre technisch richtig und
//      machte jeden Tastendruck zu einem Vollersatz im Rückgängig-Stapel.
//
// ⚠️ NICHT geprüft und bewusst so: WELCHE Taste die Rechnung auslöst und ob
// das Feld `preventDefault` ruft. Das ist Sache des Bauteils und steht in
// `compose-editor.test.tsx`.

/** Wendet eine Ersetzung an — die Gegenrechnung zu `insertText` im Bauteil. */
function applied(value, edit) {
  return value.slice(0, edit.from) + edit.text + value.slice(edit.to);
}

test("die Stufe ist zwei Leerzeichen breit", () => {
  assert.equal(INDENT_WIDTH, 2, "eine andere Breite als zwei — die Fälle unten rechnen mit zwei");
});

// ── 1. Tab ohne Auswahl ─────────────────────────────────────────────────────

test("Tab am Zeilenanfang setzt eine ganze Stufe", () => {
  const value = "services:\nweb:";
  const edit = indentEdit({ value, start: 10, end: 10 });
  assert.equal(applied(value, edit), "services:\n  web:");
  assert.equal(edit.start, 12, "der Cursor steht nicht hinter der Einrückung");
  assert.equal(edit.end, 12);
});

test("Tab in einer ungeraden Spalte füllt bis zur nächsten Stufe auf", () => {
  // Der Cursor steht hinter drei Leerzeichen, also in Spalte 3. Bis zur
  // nächsten Stufe (Spalte 4) fehlt EIN Leerzeichen.
  const value = "   web:";
  const edit = indentEdit({ value, start: 3, end: 3 });
  assert.equal(edit.text, " ", "die Einrückung springt auf eine feste Breite statt auf die nächste Stufe");
  assert.equal(applied(value, edit), "    web:");
  assert.equal(edit.start, 4);
});

test("Tab ersetzt eine Auswahl innerhalb einer Zeile", () => {
  const value = "image: nginx";
  // Der Cursor steht am Anfang der Auswahl in Spalte 7; bis zur nächsten Stufe
  // fehlt ein Leerzeichen, und `nginx` weicht ihm.
  const edit = indentEdit({ value, start: 7, end: 12 });
  assert.equal(applied(value, edit), "image:  ", "die Auswahl bleibt neben der Einrückung stehen");
  assert.equal(edit.start, 8);
});

// ── 2. Tab über mehrere Zeilen ──────────────────────────────────────────────

test("Tab rückt jede Zeile der Auswahl ein und markiert den Block", () => {
  const value = "web:\nimage: nginx\nports:";
  // Von der Mitte der ersten bis in die Mitte der zweiten Zeile.
  const edit = indentEdit({ value, start: 2, end: 8 });
  assert.equal(applied(value, edit), "  web:\n  image: nginx\nports:");
  assert.equal(edit.start, 0, "der Block ist nach dem Einrücken nicht markiert");
  assert.equal(edit.end, "  web:\n  image: nginx".length);
});

test("eine Auswahl, die auf dem Umbruch endet, nimmt die nächste Zeile nicht mit", () => {
  const value = "web:\nimage: nginx\nports:";
  // Genau die erste Zeile, Anfang bis Anfang der zweiten.
  const edit = indentEdit({ value, start: 0, end: 5 });
  assert.equal(applied(value, edit), "  web:\nimage: nginx\nports:");
});

test("eine leere Zeile im Block bleibt leer", () => {
  const value = "web:\n\nports:";
  const edit = indentEdit({ value, start: 0, end: value.length });
  assert.equal(
    applied(value, edit),
    "  web:\n\n  ports:",
    "die leere Zeile trägt jetzt unsichtbaren Weißraum am Ende"
  );
});

test("die Ersetzung deckt nur die berührten Zeilen", () => {
  const value = "a:\nb:\nc:\nd:";
  const edit = indentEdit({ value, start: 3, end: 7 });
  assert.equal(edit.from, 3, "die Ersetzung greift vor die erste berührte Zeile");
  assert.equal(edit.to, 8, "die Ersetzung greift über die letzte berührte Zeile hinaus");
});

// ── 3. Shift+Tab ────────────────────────────────────────────────────────────

test("Shift+Tab nimmt eine Stufe von der Zeile des Cursors", () => {
  const value = "web:\n    image: nginx";
  const edit = outdentEdit({ value, start: 12, end: 12 });
  assert.ok(edit !== null, "auf einer eingerückten Zeile gibt es nichts auszurücken");
  assert.equal(applied(value, edit), "web:\n  image: nginx");
  assert.equal(edit.start, 10, "der Cursor wandert nicht mit dem Text");
});

test("Shift+Tab nimmt nie mehr, als die Zeile vorn trägt", () => {
  const value = " web:";
  const edit = outdentEdit({ value, start: 5, end: 5 });
  assert.ok(edit !== null, "das eine Leerzeichen bleibt stehen");
  assert.equal(applied(value, edit), "web:");
});

test("Shift+Tab über mehrere Zeilen rückt jede einzeln aus", () => {
  const value = "  a:\n    b:\nc:";
  const edit = outdentEdit({ value, start: 0, end: value.length });
  assert.ok(edit !== null);
  assert.equal(applied(value, edit), "a:\n  b:\nc:", "eine Zeile ohne Einrückung wird mitgerechnet");
});

test("Shift+Tab ohne Einrückung gibt null — die Taste bleibt der Fokuswechsel", () => {
  const value = "web:\nports:";
  assert.equal(
    outdentEdit({ value, start: 0, end: 0 }),
    null,
    "das Feld schluckt Shift+Tab auch dort, wo es nichts zu tun gibt"
  );
  assert.equal(outdentEdit({ value, start: 0, end: value.length }), null);
});

// ── 4. Die Ränder des Textes ────────────────────────────────────────────────

test("ein Text, der mit einem Umbruch beginnt, verschiebt die erste Zeile nicht", () => {
  // ⚠️ Der Fall für `startOfLine`: `lastIndexOf` klemmt einen negativen
  // Startwert auf 0 und fände den Umbruch an Position 0.
  const value = "\nweb:";
  const edit = indentEdit({ value, start: 0, end: 0 });
  assert.equal(applied(value, edit), "  \nweb:");
  assert.equal(edit.start, 2);
});

test("Tab im leeren Feld setzt eine Stufe", () => {
  const edit = indentEdit({ value: "", start: 0, end: 0 });
  assert.equal(applied("", edit), "  ");
});
