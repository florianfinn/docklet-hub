// Am unteren Rand eines Log-Felds kleben, solange der Mensch dort ist — für
// `LogView` und `StackLogView` gemeinsam.
//
// ⚠️ DER EIGENE SPRUNG DARF DIE ANSICHT NICHT LÖSEN (#230). Bis hierher
// entschied jedes `scroll`-Ereignis allein über den Abstand zum Ende. Der
// Sprung nach unten löst selbst ein Ereignis aus, und das kommt erst einen
// Frame später an; sind dazwischen weitere Zeilen gerendert — beim Öffnen
// kommt die Vergangenheit als Schwall —, stand das Feld schon wieder mehr als
// `BOTTOM_SLACK` vom Ende weg, und die Ansicht löste sich, ohne dass jemand
// gerollt hatte. Gemessen am 2026-09-30 in drei von drei Ladevorgängen.
//
// Zwei Dinge schließen das: das Anheften läuft in `useLayoutEffect`, also vor
// dem nächsten Zeichnen und damit vor dem nächsten `scroll`-Ereignis; und
// gelöst wird nur, wenn das Feld OBERHALB der Stelle steht, an die es zuletzt
// geheftet wurde — nach oben rollt nur der Mensch.

import { useCallback, useRef, useState, type RefObject } from "react";

/**
 * Wie nah am unteren Rand noch als „unten" zählt, in Pixeln.
 *
 * Kein Vergleich auf 0: Zoomstufen und Teilpixel machen aus einem exakt unten
 * stehenden Feld regelmäßig einen Rest von ein bis zwei Pixeln, und die
 * Ansicht löste sich dann grundlos vom Rand.
 */
export const BOTTOM_SLACK = 24;

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Klebt die Ansicht nach diesem `scroll`-Ereignis noch am Rand?
 *
 * `pinnedTop` ist die Stelle, an die das Feld zuletzt geheftet wurde, oder
 * `null`, wenn es seit dem Lösen nicht mehr geheftet wurde.
 */
export function stuckAfterScroll(stuck: boolean, metrics: ScrollMetrics, pinnedTop: number | null): boolean {
  const distance = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  // Unten ist unten — auch für den, der sich gelöst hatte und selbst
  // zurückgerollt ist.
  if (distance <= BOTTOM_SLACK) return true;
  if (!stuck || pinnedTop === null) return false;
  // Weiter weg vom Ende, aber nicht höher als der eigene Sprung: der Inhalt
  // ist darunter gewachsen, der Mensch hat nichts getan.
  return metrics.scrollTop >= pinnedTop - BOTTOM_SLACK;
}

export interface StickToBottom {
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly stuck: boolean;
  /** Heftet das Feld ans Ende, wenn es klebt. Gehört in ein `useLayoutEffect`. */
  readonly pinIfStuck: () => void;
  /** Der `onScroll`-Empfänger des Felds. */
  readonly noteScroll: () => void;
  /** Der Weg zurück: wieder kleben und sofort ans Ende. */
  readonly jumpToEnd: () => void;
  /** Wieder kleben, ohne selbst zu springen — das nächste Anheften tut es. */
  readonly restick: () => void;
}

export function useStickToBottom(): StickToBottom {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedTop = useRef<number | null>(null);
  // Beim Öffnen ja — da ist unten auch oben.
  const [stuck, setStuck] = useState(true);

  const pin = (field: HTMLDivElement): void => {
    field.scrollTop = field.scrollHeight;
    pinnedTop.current = field.scrollTop;
  };

  const pinIfStuck = useCallback(() => {
    const field = scrollRef.current;
    if (field === null || !stuck) return;
    pin(field);
  }, [stuck]);

  const noteScroll = useCallback(() => {
    const field = scrollRef.current;
    if (field === null) return;
    const next = stuckAfterScroll(stuck, field, pinnedTop.current);
    if (!next) pinnedTop.current = null;
    setStuck(next);
  }, [stuck]);

  const jumpToEnd = useCallback(() => {
    const field = scrollRef.current;
    setStuck(true);
    if (field !== null) pin(field);
  }, []);

  const restick = useCallback(() => setStuck(true), []);

  return { scrollRef, stuck, pinIfStuck, noteScroll, jumpToEnd, restick };
}
