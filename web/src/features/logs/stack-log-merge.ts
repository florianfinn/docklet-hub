import type { LogLine } from "./api";

// Das Mischen mehrerer Container-Ströme zu EINEM, nach Zeit sortiert (#183).
//
// Das Artboard beschreibt den Reiter „Protokoll" der Stack-Seite als „alle
// Container in einem Strom, nach Zeit sortiert" (hub-palette.html Z. 707).
// Der Agent kennt aber nur einen Strom JE CONTAINER; das Mischen geschieht
// deshalb hier, im Browser, über die Zeilen, die schon da sind.
//
// ⚠️ REIN UND OHNE DOM, und das ist Absicht: die Reihenfolge ist die eine
// Zusage dieses Reiters, und sie wird hier ohne React geprüft
// (`web/tests/stack-log-merge.test.mjs`).

/** Eine Zeile des gemischten Stroms: die Zeile des Arms plus ihre Herkunft. */
export type StackLogLine = LogLine & {
  /** Der Container, aus dem die Zeile kommt — damit sein Abwählen seine Zeilen mitnimmt. */
  containerId: string;
  /** Der Dienst, aus dem die Zeile kommt — das, was der Mensch liest. */
  service: string;
  /**
   * Die laufende Nummer über ALLE Ströme, in Ankunftsreihenfolge.
   *
   * ⚠️ Sie ist der Schlüssel für React UND der Gleichstandsbrecher: zwei
   * Zeilen mit demselben Zeitstempel bleiben in der Reihenfolge, in der sie
   * ankamen. Ohne sie tauschten zwei gleichzeitige Zeilen eines Containers
   * bei jedem Einfügen die Plätze.
   */
  seq: number;
  /** Der Sortierschlüssel aus `ts`, einmal gerechnet (`timeKey`). */
  order: string;
};

/**
 * Ein Zeitstempel als Schlüssel, dessen Zeichenkettenordnung die zeitliche ist.
 *
 * ⚠️ DER ROHE STEMPEL TAUGT DAFÜR NICHT. Die Engine schickt RFC 3339 mit
 * Bruchteilen, aber nicht zwingend mit fester Stellenzahl. `…03.5Z` gegen
 * `…03.56Z` vergleicht an der dritten Stelle `Z` mit `6`, und `Z` gewinnt:
 * die frühere Zeile sortierte hinter die spätere. `…03Z` gegen `…03.1Z`
 * vergleicht `Z` mit `.` — die ganze Sekunde landete hinter ihrem eigenen
 * Bruchteil. Aufgefüllt auf neun Stellen verschwinden beide Fälle.
 *
 * ⚠️ KEIN `Date.parse`. Es verlöre die Nanosekunden und machte aus zwei
 * Zeilen derselben Millisekunde einen Gleichstand, der keiner ist.
 *
 * Ein Stempel, der nicht in diese Form passt, bleibt wie er ist — er sortiert
 * dann eben so gut, wie seine Zeichenkette es hergibt, und fällt nicht weg.
 */
export function timeKey(ts: string): string {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(ts);
  if (match === null) return ts;
  const [, seconds, fraction = "", zone] = match;
  return `${seconds}.${fraction.padEnd(9, "0")}${zone}`;
}

/**
 * Sortiert `line` in `held` ein und deckelt das Ergebnis bei `cap` Zeilen.
 *
 * ⚠️ VON HINTEN GESUCHT. Fast jede Zeile ist die neueste; der Normalfall
 * kostet damit einen Vergleich und nicht eine Suche über fünftausend. Nur die
 * Vergangenheit, die ein zweiter Strom beim Öffnen nachliefert, landet weiter
 * vorn — und das ist ein einmaliger Stoß, kein Dauerzustand.
 *
 * ⚠️ Bei gleichem Schlüssel bleibt die neue Zeile HINTER der gehaltenen: die
 * Ankunftsreihenfolge bricht den Gleichstand.
 *
 * ⚠️ WAS VORN ÜBER DEN DECKEL FÄLLT, SIND DIE ÄLTESTEN ZEILEN — auch wenn die
 * neue Zeile selbst älter ist als alles Gehaltene. Dann fällt eben sie.
 */
export function insertByTime(
  held: StackLogLine[],
  line: StackLogLine,
  cap: number
): { lines: StackLogLine[]; dropped: number } {
  let index = held.length;
  while (index > 0 && held[index - 1].order > line.order) index -= 1;
  const lines = [...held.slice(0, index), line, ...held.slice(index)];
  if (lines.length <= cap) return { lines, dropped: 0 };
  const excess = lines.length - cap;
  return { lines: lines.slice(excess), dropped: excess };
}

/**
 * Welche Container beim Öffnen des Reiters gewählt sind.
 *
 * ⚠️ ALLE, DIE LAUFENDEN ZUERST, dann die übrigen, jeweils in der Reihenfolge
 * des Stacks. Die Reihenfolge bestimmt, welche Ströme zuerst aufgehen — an
 * einem Arm vor v0.29.1 bekommen nur die ersten acht einen Platz, und dann
 * sollen es die sein, die GERADE etwas sagen. Bis zum 2026-09-29 stand hier
 * zusätzlich eine Obergrenze von vier.
 */
export function initialSelection(
  containers: { id: string; running: boolean }[]
): string[] {
  const running = containers.filter((container) => container.running);
  const stopped = containers.filter((container) => !container.running);
  return [...running, ...stopped].map((container) => container.id);
}
