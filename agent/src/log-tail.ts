// Die eine Rechnung für jeden `tail`-Wert, der von außen an einen Log-Weg
// kommt (Vorgang #81).
//
// Vorher stand dieselbe Rechnung wörtlich an vier Stellen — src/index.ts
// zweimal (stdout-Strom, log-datei-Strom), src/engine.ts zweimal
// (`logs()`, `logsStream()`). Drei davon trugen den Nullfall, die vierte
// nicht. Der Unterschied war damit nicht entschieden, sondern an einer
// Stelle schlicht nicht mitgeschrieben worden: wer eine der vier Zeilen
// anfasste, konnte nicht sehen, dass es die anderen drei gibt.
//
// Deshalb hat der Nullfall hier KEINEN Vorgabewert. Jede Aufrufstelle nennt
// ihn ausdrücklich; ein vergessenes Argument ist ein Typfehler beim Bauen
// und nicht ein stiller Verhaltenswechsel an einem Log-Strom, den kein Test
// bemerkt.

import { DEFAULT_TAIL, MAX_TAIL } from "contract";

// Der Deckel. Mehr Zeilen als das holt kein Aufrufer, auch wenn er danach
// fragt — die Antwort der Engine landet sonst am Größendeckel
// (MAX_LOG_SNAPSHOT_BYTES) statt an einer Zeilenzahl.
export const MAX_LOG_TAIL_LINES = MAX_TAIL;

// Der Rückfall für alles, was kein brauchbarer Ausschnitt ist: NaN aus einem
// fehlenden oder unlesbaren Query-Parameter, negative Werte, Bruchzahlen.
export const DEFAULT_LOG_TAIL_LINES = DEFAULT_TAIL;

// Wie dieser Weg eine Null liest. Bewusst ein benanntes Feld und kein
// Positionsargument: an der Aufrufstelle steht damit lesbar, welches der
// beiden Verhalten gemeint ist.
export interface LogTailPolicy {
  // true — `tail=0` heißt "keine Vergangenheit, nur ab jetzt". Das ist der
  //   S15-Alarmstrom: er verbindet sich planmäßig neu und würde sonst bei
  //   jedem Reconnect dieselben alten Treffer ein zweites Mal melden. Nur ein
  //   Weg mit `follow=1` kann das leisten — er hängt nach den (null) alten
  //   Zeilen am laufenden Strom.
  //
  // false — `tail=0` fällt wie jeder andere unbrauchbare Wert auf
  //   DEFAULT_LOG_TAIL_LINES. Auf einem Weg OHNE `follow` wäre eine Null
  //   keine "nur ab jetzt"-Zusage, sondern eine leere Antwort: der Abzug ist
  //   nach den null alten Zeilen fertig.
  readonly zeroMeansNoHistory: boolean;
}

export function resolveLogTail(tail: number, policy: LogTailPolicy): number {
  if (policy.zeroMeansNoHistory && tail === 0) return 0;
  return Number.isInteger(tail) && tail > 0
    ? Math.min(tail, MAX_LOG_TAIL_LINES)
    : DEFAULT_LOG_TAIL_LINES;
}
