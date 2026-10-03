import type { StreamSource } from "../../platform/streams/stream-store";
import { streamContainerLogs, type LogLine, type LogStreamFailure } from "./api";

// The log stream of one container as a source of the stream store (#257,
// #258). `LogView` reads it through `useStream`; the store holds the phase,
// the capped lines and the attempt, and aborts the stream once nobody reads.

/**
 * Wie viele Zeilen die Ansicht höchstens hält. Ältere fallen vorne weg.
 *
 * ⚠️ DER DECKEL IST PFLICHT UND KEINE VORSICHT. Der Strom ist unbegrenzt: bis
 * zu 2000 Zeilen Vergangenheit und danach alles, was der Container noch sagt,
 * ohne Ende. Ohne Deckel wächst das Feld im Speicher und der DOM-Baum
 * gleichermaßen, bis der Reiter steht — und zwar nicht bei einer Vorführung
 * mit drei Zeilen, sondern nach einer Stunde an einem gesprächigen Container.
 *
 * ⚠️ WARUM 5000 UND NICHT 2000. Der größtmögliche Ausschnitt der
 * Vergangenheit ist 2000 Zeilen (`MAX_TAIL`, der Agent deckelt dort hart). Ein
 * Deckel von 2000 würfe deshalb schon beim Öffnen die erste laufende Zeile
 * gegen die letzte historische — der Mensch sähe seinen eben erst geholten
 * Ausschnitt zerbröseln, ohne etwas getan zu haben. 5000 lässt den größten
 * Ausschnitt vollständig stehen und darüber noch 3000 Zeilen Gegenwart; das
 * ist reichlich für das, was jemand tatsächlich zurückliest, und klein genug,
 * dass der Browser es nicht merkt.
 */
export const HELD_LINE_CAP = 5_000;

/**
 * The key of the stream of one container.
 *
 * ⚠️ IT NAMES EVERYTHING THE SOURCE READS (arm and container). Two views of
 * the same container share one stream at the arm; the attempt is not part of
 * the key, the store counts it itself.
 */
export function containerLogKey(hostId: string, containerId: string): string {
  return JSON.stringify(["container-log", hostId, containerId]);
}

/**
 * The source for `useStream`. No `tail`: the server takes the operator's
 * setting (see the head of `LogView.tsx`).
 */
export function containerLogSource(hostId: string, containerId: string): StreamSource<LogLine, LogStreamFailure> {
  return (signal, sink) =>
    streamContainerLogs(hostId, containerId, { signal, onOpen: sink.open, onFailure: sink.fail }, sink.line);
}

/** What one log stream of the stack tab reports, in the order it can happen. */
export type ContainerLogEvents = {
  /** The hub answered `200`; lines may follow. */
  open: () => void;
  line: (line: LogLine) => void;
  /** A failure line IN the stream; reading goes on. */
  failure: (failure: LogStreamFailure) => void;
  /** The stream ended by itself. */
  ended: () => void;
  /** It failed before or while reading; never called for the abort itself. */
  error: (error: unknown) => void;
};

/**
 * Opens the log stream of one container and returns its abort (#271).
 *
 * For the stack tab (`StackLogView`), which merges the streams of several
 * containers into one buffer of its own, sorted by time; the stream store
 * holds one buffer per key and does not model that merge. Moving the tab onto
 * the store is open (#286). Until then the stream is a process outside React
 * that the view's effect starts and stops, and the effect calls nothing on the
 * hub itself (`local/no-api-call-in-effect`).
 *
 * ⚠️ NOTHING IS REPORTED AFTER THE ABORT. The abort is the normal end (the
 * container was deselected, the tab closed, React's StrictMode mounted twice),
 * not an error.
 */
export function openContainerLogStream(hostId: string, containerId: string, events: ContainerLogEvents): () => void {
  const controller = new AbortController();
  void streamContainerLogs(
    hostId,
    containerId,
    { signal: controller.signal, onOpen: events.open, onFailure: events.failure },
    events.line
  )
    .then(() => {
      if (!controller.signal.aborted) events.ended();
    })
    .catch((error: unknown) => {
      if (!controller.signal.aborted) events.error(error);
    });
  return () => controller.abort();
}
