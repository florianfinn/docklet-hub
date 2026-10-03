import type { CSSProperties, ReactNode } from "react";

import type { HueName, MarkStyleName } from "contract";
import { cn } from "../lib/cn";

// Eine EIGENE Marke, wie der Betreiber sie sieht (D7b, #62).
//
// ⚠️ SIE IST NICHT DIE SYSTEMMARKE. docs/design/hub-color-and-structure.md §3
// trennt beide: eine Systemmarke („Update", „neu", „zu alt") vergibt der Hub
// aus der Antwort des Agenten und sie ist GEFÜLLT, weil sie eine Handlung
// nahelegt; eine eigene Marke vergibt der Betreiber, sie läuft auf halber
// Sättigung und ORDNET NUR. Der Unterschied gehört laut §3 ins Bauteil und
// nicht allein in die Farbe — deshalb dieses eigene Bauteil neben `Badge`
// (`web/src/platform/ui/shadcn/badge.tsx`), das die Systemmarken trägt.
//
// ⚠️ WARUM DIESER ORDNER UND NICHT `web/src/platform/ui/shadcn/`. Dort liegen
// ÜBERNOMMENE Bausteine, jeder mit Herkunftskopf und Eintrag im sha256-Register
// (`web/tests/vendored-origin.test.mjs`). Dieser hier ist selbst geschrieben;
// er liegt deshalb wie `web/src/platform/ui/dot-wave/` in einem eigenen Ordner mit einer
// `index.ts` als einziger Tür.
//
// ⚠️ WARUM NICHT UNTER `web/src/app/screens/`. Zwei Gründe, der zweite gemessen:
//   1. Etappe C benutzt ihn auf der Stack-Seite, in der Container-Zeile und in
//      der Übersicht. Ein Bauteil, das in einer Tafel der Einstellungen steckt,
//      wäre dort dreimal nachgebaut.
//   2. `web/tests/host-palette.test.mjs` (Prüfung 2) verlangt für jedes
//      `data-hue` unter `web/src/app/screens/`, dass sein Wert über
//      `hostDisplay(…)` aus der Ablage kommt. Das ist der Ausdruck für die
//      Farbe eines ARMS; eine Marke holt ihren Ton aus `GET /api/marks`, also
//      ebenfalls aus der Ablage, aber über einen anderen Weg. Der Wächter
//      bleibt damit unangetastet scharf, und `MarksPanel.tsx` schreibt selbst
//      kein einziges `data-hue`.

/**
 * Was eine Marke zum Zeichnen braucht.
 *
 * ⚠️ NICHT `MarkView`, obwohl `MarkView` hier hineinpasst. Der Grund ist die
 * VORSCHAU: die Auswahllisten im Editor zeigen einen Ton und eine Darstellung,
 * die noch keine Marke trägt — es gibt für sie also keine Kennung, und ein
 * `id: ""` wäre eine erfundene. `id` ist deshalb freiwillig, und `MarkView` ist
 * dieser Form gegenüber zuweisungskompatibel.
 */
export type MarkChipMark = {
  readonly id?: string;
  readonly name: string;
  readonly hue: HueName;
  readonly style: MarkStyleName;
};

export type MarkChipProps = {
  mark: MarkChipMark;
  /** Zusätzliche Klassen der Aufrufstelle — Abstände, Breiten, sonst nichts. */
  className?: string;
  /** Was rechts vom Namen steht, etwa ein Knopf zum Abziehen (Etappe C). */
  children?: ReactNode;
  style?: CSSProperties;
};

/**
 * Die Marke selbst.
 *
 * ⚠️ DIE DREI ATTRIBUTE STEHEN AUF DEMSELBEN ELEMENT WIE DIE DREI KLASSEN, UND
 * DAS IST DER GANZE PUNKT DIESES BAUTEILS. Eine CSS-Variable löst dort auf, wo
 * sie DEKLARIERT ist, nicht wo sie benutzt wird (hub-color-and-structure.md §8).
 * `--mark-face`, `--mark-ink` und `--mark-line` werden in `palette.css` auf der
 * Selektorliste `:root, [data-hue], [data-host], [data-area], [data-mark]`
 * deklariert und danach von `[data-mark-style="…"]` überschrieben. Ein Wrapper
 * mit `data-hue` und ein Kind mit `data-mark` ergäben: das Kind deklariert die
 * Ableitung mit dem `--h` seines eigenen Elements — und das trägt keinen Ton,
 * weil `data-hue` eine Ebene höher steht. Ergebnis wäre der Grundton des
 * Hauses statt der gewählten Farbe, ohne dass irgendetwas rot würde.
 * `web/tests/marks-editor.test.tsx` prüft genau das am gerenderten Baum, und
 * die Mutationsprobe ist gemacht: zieht man `data-hue` auf ein umschließendes
 * `<span>`, wird dieser Test rot, während `pnpm run lint` (Exit 0) und alle 128
 * Wächter über Dateitexte grün bleiben (gemessen am 2026-09-06).
 *
 * ⚠️ Der NAME ist ein Text des Betreibers und kommt aus den Daten. Er steht
 * deshalb nicht in `web/src/platform/i18n/messages/` — er ist so wenig übersetzbar wie
 * der Name eines Arms.
 */
export function MarkChip({ mark, className, children, style }: MarkChipProps) {
  return (
    <span
      // `data-mark` trägt die Kennung, wenn es eine gibt, und sonst den leeren
      // Wert. Für das Stylesheet zählt allein, DASS das Attribut da ist
      // (`[data-mark]` ist ein Existenzselektor); die Kennung steht darin, weil
      // sie beim Nachsehen im Browser die Frage „welche Marke ist das"
      // beantwortet, ohne dass jemand den Namen mit der Liste vergleichen muss.
      data-mark={mark.id ?? ""}
      data-hue={mark.hue}
      data-mark-style={mark.style}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-mark-line bg-mark-face",
        "px-2 py-0.5 text-[12px] leading-[1.35] text-mark-ink",
        className
      )}
      style={style}
    >
      <span className="truncate">{mark.name}</span>
      {children}
    </span>
  );
}
