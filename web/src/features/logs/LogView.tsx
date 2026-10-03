import { useLayoutEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl";

import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { useStream } from "../../platform/streams/use-stream";
import { LogRow } from "./log-line/LogRow";
import { useStickToBottom } from "./log-line/stick-to-bottom";
import { logErrorKey, logFailureText } from "./log-errors";
import { containerLogKey, containerLogSource, HELD_LINE_CAP } from "./log-stream";

// Die Log-Ansicht: der laufende Log-Strom eines Containers (#5, Etappe H2).
//
// ⚠️ DIESES BAUTEIL IST NICHT DIE CONTAINER-DETAILSEITE. Es bekommt zwei
// Kennungen und zeigt einen Strom — mehr weiß es nicht. Die Seite, die es in
// ihren Reiter „Protokoll" hängt, baut Etappe H3; deshalb steht hier auch kein
// Rahmen (keine `Card`, keine Überschrift): der Rahmen gehört dem Ort, an dem
// das Bauteil hängt, und zwei Rahmen ineinander sind einer zu viel.
//
// ⚠️ KEINE EIGENSCHAFT FÜR DIE ZEILENZAHL, und das ist eine Entscheidung.
// `streamContainerLogs` kann ein `tail` senden; hier wird keins gesetzt. Dann
// nimmt der Server die globale Einstellung des Betreibers (Etappe G/H1,
// „Logansicht" in den Einstellungen). Eine Eigenschaft von oben wäre eine
// ZWEITE Quelle für dieselbe Frage: H3 müsste sich eine Zahl ausdenken, und
// die Einstellung, die der Betreiber genau dafür gepflegt hat, hätte plötzlich
// keine Wirkung mehr. Braucht später eine Fläche einen anderen Ausschnitt
// (etwa ein „mehr Vergangenheit"-Knopf), ist das ein eigener Baustein mit
// eigenem Bedienelement — nicht eine stille Eigenschaft, die niemand sieht.
//
// ⚠️ THE STREAM LIVES IN THE STREAM STORE since #258 (`useStream`,
// `web/src/platform/streams/`), not in an effect of this component. The store
// holds the capped lines, the phase and the attempt, opens one stream per
// container even under StrictMode and aborts it once nobody reads it. What
// stays here is the display. Loaded lazily through `LogView.lazy.tsx`.

export function LogView({ hostId, containerId }: { hostId: string; containerId: string }) {
  const t = useTranslations();
  // ⚠️ ONE STREAM PER CONTAINER, NOT PER ATTEMPT. The key names arm and
  // container; a reconnect is a new attempt of the same store, and a change
  // of container is another store, so the held lines of the previous one are
  // never shown here (#126).
  const stream = useStream(containerLogKey(hostId, containerId), containerLogSource(hostId, containerId), {
    cap: HELD_LINE_CAP
  });
  const [filter, setFilter] = useState("");
  // Klebt die Ansicht am unteren Rand? Die Regel steht in `stick-to-bottom.ts`.
  const { scrollRef, stuck, pinIfStuck, noteScroll, jumpToEnd, restick } = useStickToBottom();

  // The store says `closed` for a stream that ended by itself; this view has
  // always called it `ended` (`data-phase`, the status text), and so it stays.
  // The error before the first line becomes its text key here, the one place
  // that knows the table (`log-errors.ts`).
  const { phase, lines, dropped, error, failure } = stream;
  const view = useMemo(
    () => ({
      phase: phase === "closed" ? ("ended" as const) : phase,
      items: lines,
      dropped,
      errorKey: phase === "failed" && error !== null ? logErrorKey(error) : null,
      failure
    }),
    [phase, lines, dropped, error, failure]
  );

  // ⚠️ AM UNTEREN RAND KLEBEN, SOLANGE DER MENSCH DORT IST — und keinen Schritt
  // weiter. Wer nach oben gescrollt hat, um etwas zu lesen, darf von der
  // nächsten eintreffenden Zeile nicht wieder nach unten gerissen werden; das
  // ist der Unterschied zwischen einem Log, in dem man etwas findet, und einem,
  // das man anhalten muss, um es zu lesen. Der Weg zurück steht als Knopf da.
  // ⚠️ `useLayoutEffect` und nicht `useEffect` (#230): das Feld muss vor dem
  // nächsten `scroll`-Ereignis am Ende stehen, sonst löst der eigene Sprung
  // die Ansicht.
  useLayoutEffect(pinIfStuck, [view, filter, pinIfStuck]);

  // Ein neuer Versuch, und die Ansicht klebt dabei wieder unten: der frische
  // Strom bringt seinen eigenen Ausschnitt der Vergangenheit mit, und wer ihn
  // von oben herunterlesen müsste, säße vor einer Ansicht, die neben dem
  // gerade Gesagten steht. Wer sich davon wieder lösen will, scrollt — der
  // Weg zurück steht als Knopf da.
  const reconnect = () => {
    restick();
    stream.reconnect();
  };

  // ⚠️ DER FILTER FILTERT DIE ANZEIGE UND NICHT DEN STROM. Er läuft über die
  // gehaltenen Zeilen und schickt nichts an den Arm: der sendet weiter alles,
  // und eine heute versteckte Zeile ist morgen ohne neue Anfrage wieder da.
  // Als Anfrage am Arm gebaut wäre er das Gegenteil — jede Änderung des Textes
  // risse den Strom ab und öffnete einen neuen, und die Vergangenheit vor dem
  // Filter wäre weg.
  const needle = filter.trim().toLowerCase();
  const visible = needle === "" ? view.items : view.items.filter((line) => line.text.toLowerCase().includes(needle));

  // ⚠️ Der Weg zurück nach unten steht NUR da, wenn der Mensch sich gelöst
  // hat. Ein Knopf, der immer da ist, sagt nichts; dieser sagt: du bist gerade
  // nicht am Ende, und hier geht es hin. Bei leerer Ansicht braucht ihn
  // niemand — da ist unten auch oben.
  const showJumpToEnd = !stuck && view.items.length > 0;
  const showReconnect = view.phase === "failed";

  // Der Zustand in einem Satz. `null` heißt: es laufen Zeilen, und die sind
  // die Auskunft.
  const statusText =
    view.phase === "connecting"
      ? t("logConnecting")
      : view.phase === "ended"
        ? t("logEnded")
        : view.phase === "open" && view.items.length === 0
          ? t("logWaiting")
          : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="log-view" data-phase={view.phase}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] text-subtle-foreground" data-testid="log-status">
            {statusText}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="log-line-count">
            {t("logLineCount", { count: view.items.length })}
          </span>
        </div>

        <div className="ml-auto flex flex-col gap-1">
          <Label htmlFor="log-filter">{t("logFilterLabel")}</Label>
          <Input
            id="log-filter"
            className="w-[18rem]"
            value={filter}
            placeholder={t("logFilterPlaceholder")}
            aria-describedby="log-filter-hint"
            data-testid="log-filter"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>

      <p id="log-filter-hint" className="text-xs text-muted-foreground">
        {t("logFilterHint")}
      </p>

      {view.errorKey === null ? null : (
        <p role="alert" className="text-[13px] text-destructive" data-testid="log-error">
          {t(view.errorKey)}
        </p>
      )}

      {view.failure === null ? null : (
        <p role="alert" className="text-[13px] text-state-warn" data-testid="log-stream-failed">
          {logFailureText(t, view.failure.reason)}
        </p>
      )}

      {view.dropped === 0 ? null : (
        <p className="text-xs text-muted-foreground" data-testid="log-trimmed">
          {t("logTrimmed", { count: HELD_LINE_CAP })}
        </p>
      )}

      <div
        ref={scrollRef}
        onScroll={noteScroll}
        className="min-h-[12rem] flex-1 overflow-y-auto rounded-md border border-accent-line bg-body-face p-2 font-mono text-xs"
        data-testid="log-lines"
      >
        {visible.map((line, index) => (
          // Die laufende Nummer im Strom, nicht die Stelle im Feld: nach dem
          // ersten Verwerfen wäre der Index für jede Zeile ein anderer. Wie
          // die Zeile aussieht, steht in `log-line/LogRow.tsx`.
          <LogRow key={view.dropped + index} line={line} testId="log-line" />
        ))}

        {visible.length === 0 && view.items.length > 0 ? (
          <p className="text-[13px] text-muted-foreground" data-testid="log-filter-empty">
            {t("logFilterEmpty")}
          </p>
        ) : null}
      </div>

      {/* Die Fußzeile steht nur da, wenn sie etwas trägt: ein leeres Feld
          risse zwischen dem Strom und dem unteren Rand einen Abstand auf, der
          nichts bedeutet. */}
      {showJumpToEnd || showReconnect ? (
      <div className="flex flex-wrap items-center gap-2">
        {!showJumpToEnd ? null : (
          <Button type="button" variant="outline" size="sm" onClick={jumpToEnd} data-testid="log-jump-to-end">
            {t("logJumpToEnd")}
          </Button>
        )}

        {/* ⚠️ DER WEG ZURÜCK AUS DEM FEHLER, und er ist ein KNOPF und keine
            Schleife (#126). Bis hierher endete jeder Fehler — der Statuscode
            vor der ersten Zeile wie der `{"kind":"error"}` mitten im Strom —
            in einer Ansicht, die stehen blieb; der einzige Ausweg war ein
            Reiterwechsel, den nichts erklärte.

            ⚠️ AND IT DOES NOT RECONNECT BY ITSELF, for the same reason as the
            shell (`ShellView.tsx`): the arm holds a limited number of
            concurrent streams for all people together (`MAX_OPEN_STREAMS` in
            `contract/src/agent/limits.ts`, #234). A forgotten tab that knocks
            again every few seconds blocks the log for everyone else, and the
            429 ("the arm is full") is exactly the case in which a loop does the
            wrong thing. The person presses.

            ⚠️ NUR IM FEHLERZUSTAND. Ein `ended` ist kein Fehler: der Container
            redet nicht mehr, und ein neuer Strom brächte dieselbe Auskunft
            noch einmal. Bei laufendem Strom wäre der Knopf eine Einladung,
            die gehaltenen Zeilen wegzuwerfen und einen zweiten der acht
            Plätze zu belegen. */}
        {!showReconnect ? null : (
          <Button type="button" variant="outline" size="sm" onClick={reconnect} data-testid="log-reconnect">
            {t("logReconnect")}
          </Button>
        )}
      </div>
      ) : null}
    </div>
  );
}
