// Was Tab und Shift+Tab im Compose-Editor am Text tun — als reine Rechnung,
// ohne DOM und ohne React (#135).
//
// ⚠️ WARUM DAS HIER UND NICHT IM BAUTEIL STEHT. Die Rechnung hängt an
// Zeichenpositionen: wo die Zeile anfängt, welche Spalte der Cursor hält, wie
// viele Leerzeichen eine Zeile vorn schon trägt. Im Bauteil stünde sie
// zwischen `setSelectionRange` und einem Tastenereignis und wäre nur über
// einen DOM-Prüfstand zu prüfen; hier ist sie eine Funktion mit einem Test
// daneben (`web/tests/compose-indent.test.mjs`).
//
// ⚠️ EINE EINRÜCKUNG SIND LEERZEICHEN UND NIE EIN TABULATORZEICHEN. YAML
// verbietet den Tabulator als Einrückung — ein Feld, das die Taste wörtlich
// einsetzte, schriebe eine Datei, die `compose up` mit einem Parserfehler
// zurückweist. Die Taste rückt hier ein, sie fügt nicht ihr Zeichen ein.

/** Eine Stufe: zwei Leerzeichen, die übliche Einrückung in Compose-Dateien. */
export const INDENT_WIDTH = 2;

/** Der Stand des Feldes: sein Text und die Auswahl darin. */
export type Caret = {
  value: string;
  /** Anfang der Auswahl; bei einem bloßen Cursor gleich `end`. */
  start: number;
  end: number;
};

/**
 * Eine Ersetzung im Text — und wo die Auswahl danach steht.
 *
 * ⚠️ EIN BEREICH UND NICHT DER GANZE NEUE TEXT. Das Bauteil setzt die
 * Ersetzung über `insertText` ein, und dieser Weg hält den Rückgängig-Stapel
 * des Browsers (siehe `ComposeEditor.tsx`). Ein fertiger Gesamttext ließe
 * sich nur noch zuweisen, und die Zuweisung ist genau das, was den Stapel
 * verliert.
 */
export type IndentEdit = {
  /** Anfang des ersetzten Bereichs im alten Text. */
  from: number;
  /** Ende des ersetzten Bereichs im alten Text. */
  to: number;
  /** Was an seine Stelle tritt. */
  text: string;
  /** Die Auswahl danach, gemessen im NEUEN Text. */
  start: number;
  end: number;
};

/** Der Index, an dem die Zeile beginnt, in der `index` liegt. */
function startOfLine(value: string, index: number): number {
  // ⚠️ Der Sonderfall `index === 0` ist keine Bequemlichkeit. `lastIndexOf`
  // klemmt einen negativen Startwert auf 0 und findet dann einen Umbruch an
  // Position 0 — bei einem Text, der mit einem Umbruch beginnt, käme 1 heraus
  // statt 0, und die erste Zeile wäre um ein Zeichen verschoben.
  if (index <= 0) return 0;
  return value.lastIndexOf("\n", index - 1) + 1;
}

/** Der Index des Umbruchs nach `index`, oder das Textende. */
function endOfLine(value: string, index: number): number {
  const next = value.indexOf("\n", index);
  return next === -1 ? value.length : next;
}

/**
 * Der Block ganzer Zeilen, den eine Auswahl berührt.
 *
 * ⚠️ EINE AUSWAHL, DIE AUF EINEM UMBRUCH ENDET, NIMMT DIE FOLGENDE ZEILE NICHT
 * MIT. Wer drei Zeilen von Anfang bis Anfang der vierten markiert, meint drei
 * Zeilen — die vierte mit einzurücken wäre eine Änderung an einer Zeile, die
 * der Betreiber nie angefasst hat.
 */
function blockOf(caret: Caret): { from: number; to: number } {
  const { value, start, end } = caret;
  const last = end > start && end === startOfLine(value, end) ? end - 1 : end;
  return { from: startOfLine(value, start), to: endOfLine(value, last) };
}

/** Wie viele Leerzeichen die Zeile vorn trägt. */
function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

/**
 * Was Tab tut.
 *
 * Zwei Fälle, und der Unterschied ist, ob die Auswahl einen Umbruch enthält:
 *
 *   * OHNE Umbruch — ein bloßer Cursor oder eine Auswahl innerhalb einer
 *     Zeile — rückt bis zur nächsten Stufe vor. Steht der Cursor in Spalte 3,
 *     ist das EIN Leerzeichen und nicht zwei: die Stufen sollen aufeinander
 *     liegen, sonst steht die Datei nach dem dritten Tab krumm.
 *   * MIT Umbruch rückt jede berührte Zeile um eine Stufe ein. Die Auswahl
 *     danach umfasst die ganzen Zeilen — was eingerückt wurde, ist markiert,
 *     und ein zweites Tab wiederholt denselben Block.
 *
 * Leere Zeilen bleiben leer. Eine Einrückung auf einer leeren Zeile ist
 * unsichtbarer Weißraum am Zeilenende, den kein Mensch je wieder entfernt.
 */
export function indentEdit(caret: Caret): IndentEdit {
  const { value, start, end } = caret;

  if (!value.slice(start, end).includes("\n")) {
    const column = start - startOfLine(value, start);
    const width = INDENT_WIDTH - (column % INDENT_WIDTH);
    const text = " ".repeat(width);
    return { from: start, to: end, text, start: start + width, end: start + width };
  }

  const block = blockOf(caret);
  const text = value
    .slice(block.from, block.to)
    .split("\n")
    .map((line) => (line === "" ? line : " ".repeat(INDENT_WIDTH) + line))
    .join("\n");
  return { from: block.from, to: block.to, text, start: block.from, end: block.from + text.length };
}

/**
 * Was Shift+Tab tut: bis zu einer Stufe von jeder berührten Zeile weg.
 *
 * ⚠️ `null`, WENN ES NICHTS ZU ENTFERNEN GIBT — und das Bauteil lässt die
 * Taste dann an den Browser durch. Auf einer nicht eingerückten Zeile führt
 * Shift+Tab damit rückwärts aus dem Feld heraus, so wie überall sonst auf der
 * Seite. Ein Feld, das die Taste in jedem Fall schluckt, wäre eine Falle für
 * die Tastaturbedienung.
 */
export function outdentEdit(caret: Caret): IndentEdit | null {
  const { value, start, end } = caret;
  const block = blockOf(caret);
  const lines = value.slice(block.from, block.to).split("\n");
  const removedPerLine = lines.map((line) => Math.min(leadingSpaces(line), INDENT_WIDTH));
  const removed = removedPerLine.reduce((sum, count) => sum + count, 0);
  if (removed === 0) return null;

  const text = lines.map((line, index) => line.slice(removedPerLine[index])).join("\n");

  // Ein bloßer Cursor bleibt, wo er steht — um das gekürzt, was VOR ihm auf
  // seiner Zeile weggefallen ist. Ihn auf den Zeilenanfang zu setzen, hieße
  // beim Ausrücken eines Blocks jedes Mal die Schreibstelle zu verlieren.
  if (start === end) {
    const place = Math.max(startOfLine(value, start), start - removedPerLine[0]);
    return { from: block.from, to: block.to, text, start: place, end: place };
  }

  return { from: block.from, to: block.to, text, start: block.from, end: block.from + text.length };
}
