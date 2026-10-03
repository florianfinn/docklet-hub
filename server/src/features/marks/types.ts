import type { IndentName, MarkView } from "contract";

// Was eine eigene Marke NACH DRAUSSEN ist, und was ein Arm an Marken und
// Gliederung mitbringt — Typen und sonst nichts.
//
// Eigene Datei und nicht im Store: die Übersicht (`features/containers/overview.ts`)
// braucht diese Typen und darf dafür nicht die Datei importieren, die den
// Verbindungspool anfasst. Dieselbe Trennung wie zwischen `host-record.ts` und
// `domain/hosts/host-store.ts`.

/**
 * Welche Art von Ziel eine Zuordnung meint.
 *
 * ⚠️ Wörtlich die Stufen aus `CHECK (target IN ('stack', 'container'))` in
 * `007-marks.sql`. Sie stehen hier ein zweites Mal, und das ist die eine
 * Abschrift, die dieses Paket nicht auflösen kann: `target` ist keine
 * Stellschraube, hat also keinen Platz in `THEME_KNOBS`, und ein Wächter
 * darüber wäre ein Wächter über zwei Wörter. `theme-schema.test.ts` führt die
 * Spalte deshalb namentlich in `NON_KNOB_CHECKS` — mit dem Grund daneben.
 */
export type MarkTarget = "stack" | "container";

/**
 * Was ein Arm an eigenen Angaben mitbringt: die Marken seiner Stacks und
 * Container und die Einrückung seiner Stacks.
 *
 * ⚠️ Der Schlüssel ist der NAME — das Compose-Projekt beziehungsweise der
 * Containername — und keine Kennung. Es gibt keine: ein Stack und ein
 * Container kommen flüchtig aus der Antwort des Agenten (007-marks.sql, Kopf).
 *
 * ⚠️ Zwei getrennte Abbildungen und nicht eine mit zusammengesetztem
 * Schlüssel. Ein Stack „nextcloud" und ein loser Container „nextcloud" sind
 * zwei Ziele; ein Schlüssel `"stack:nextcloud"` trüge dieselbe Unterscheidung
 * in einer Zeichenkette, die jeder Leser wieder aufteilen müsste — und der
 * erste, der einen Doppelpunkt im Containernamen zulässt, hätte sie kaputt.
 */
export type HostDecoration = {
  marksByStack: ReadonlyMap<string, MarkView[]>;
  marksByContainer: ReadonlyMap<string, MarkView[]>;
  indentByStack: ReadonlyMap<string, IndentName>;
  // Die Stacks, die der Betreiber auf der Übersicht ausgeblendet hat (015).
  hiddenStacks: ReadonlySet<string>;
};

/**
 * Ein Arm ohne jede eigene Angabe.
 *
 * Das ist der Normalfall und kein Sonderfall: eine Zeile entsteht erst, wenn
 * der Betreiber etwas vergibt. Er steht hier als Konstante, damit ein Aufrufer
 * ihn nicht jedes Mal neu baut — und damit ein Test dagegen prüfen kann,
 * statt drei leere Abbildungen hinzuschreiben.
 */
export const EMPTY_DECORATION: HostDecoration = {
  marksByStack: new Map(),
  marksByContainer: new Map(),
  indentByStack: new Map(),
  hiddenStacks: new Set()
};

/** Was beim Schreiben schiefgehen kann und der Aufrufer nach draußen meldet. */
export type MarkErrorReason = "name-taken" | "mark-unknown" | "host-unknown";

/**
 * Ein Fehler, dessen Text an einen MENSCHEN geht.
 *
 * Dieselbe Bauart wie `HostError` (domain/hosts/host-store.ts) und aus demselben Grund:
 * der Router reicht die Meldung genau dieser Klasse nach draußen und keine
 * beliebige. Die Meldung eines unbekannten Fehlers nennt Pfade, Spalten und
 * Verbindungszeichenketten.
 */
export class MarkError extends Error {
  constructor(
    readonly reason: MarkErrorReason,
    message: string
  ) {
    super(message);
    this.name = "MarkError";
  }
}
