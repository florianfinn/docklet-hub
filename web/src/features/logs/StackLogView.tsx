import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OverviewContainer } from "contract";
import { useTranslations } from "use-intl";

import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { cn } from "../../platform/ui/lib/cn";
import type { LogLine } from "./api";
import { logErrorKey, logFailureText } from "./log-errors";
import { HELD_LINE_CAP, openContainerLogStream } from "./log-stream";
import { LogRow } from "./log-line/LogRow";
import { useStickToBottom } from "./log-line/stick-to-bottom";
import { initialSelection, insertByTime, timeKey, type StackLogLine } from "./stack-log-merge";
import { serviceColor } from "./service-colors";

// Der Reiter „Protokoll" der Stack-Seite (#183): die Log-Ströme mehrerer
// Container des Stacks, zu EINEM gemischt und nach Zeit sortiert — so, wie
// das Artboard ihn beschreibt (hub-palette.html Z. 707).
//
// ⚠️ DER MENSCH WÄHLT, WELCHE CONTAINER IM STROM STEHEN (Entscheidung des
// Betreibers vom 2026-09-29), und vorgewählt sind alle lesbaren. Bis hierher
// deckelte der Reiter auf vier: der Agent führte acht Ströme für alle Menschen
// zusammen. Seit v0.29.1 sind es 32 (`MAX_OPEN_STREAMS`, seit #272 in
// `contract/src/agent/limits.ts`), und der
// Betreiber wollte die Grenze je Stack am selben Tag weg haben. Ein Arm auf
// einer älteren Fassung antwortet dem neunten Strom mit `429`; das steht dann
// als Satz beim Dienst, wie jeder andere Fehler eines Stroms.
//
// ⚠️ JEDER GEWÄHLTE CONTAINER IST EIN EIGENES, UNSICHTBARES BAUTEIL
// (`StackLogSource`) mit eigenem Effekt und eigenem Abbruch. Ein einziger
// Effekt über die ganze Auswahl risse beim An- oder Abwählen EINES Containers
// alle Ströme ab und öffnete sie neu — die Vergangenheit aller wäre weg, und
// für einen Augenblick stünden doppelt so viele Ströme offen.
//
// ⚠️ KEINE EIGENE ZEILENZAHL, aus demselben Grund wie in `LogView`: die Zahl
// entscheidet der Server aus der Einstellung des Betreibers.

type SourcePhase = "connecting" | "open" | "ended" | "failed";

type SourceState = {
  phase: SourcePhase;
  errorKey: ReturnType<typeof logErrorKey> | null;
  failure: { reason: string | null } | null;
};

/** Die Kennung EINES Stroms: Container und Versuch — derselbe Weg wie in `LogView`. */
function sourceKey(containerId: string, attempt: number): string {
  return `${containerId}#${attempt}`;
}

/** Der Name, der in der Zeile steht: der Dienst, wo es einen gibt. */
function serviceOf(container: OverviewContainer): string {
  return container.compose?.service ?? container.name;
}

type SourceEvents = {
  onLine: (containerId: string, service: string, line: LogLine) => void;
  onState: (key: string, edit: (current: SourceState) => SourceState) => void;
};

/**
 * Ein offener Strom, ohne eigene Anzeige.
 *
 * ⚠️ DIE AUFRÄUMFUNKTION IST DER ABBRUCH, und er ist Pflicht: React führt
 * einen Effekt in der Entwicklung zweimal aus, und ohne Abbruch stünden nach
 * jedem Einhängen zwei Ströme offen. Derselbe Abbruch trägt den Normalfall —
 * der Container wird abgewählt oder der Reiter geschlossen.
 */
function StackLogSource({
  hostId,
  containerId,
  service,
  attempt,
  events
}: {
  hostId: string;
  containerId: string;
  service: string;
  attempt: number;
  events: SourceEvents;
}) {
  const { onLine, onState } = events;
  useEffect(() => {
    const key = sourceKey(containerId, attempt);
    return openContainerLogStream(hostId, containerId, {
      open: () => onState(key, (current) => ({ ...current, phase: "open" })),
      line: (line) => onLine(containerId, service, line),
      failure: (failure) =>
        onState(key, (current) => ({ ...current, phase: "failed", failure: { reason: failure.reason } })),
      ended: () => onState(key, (current) => (current.phase === "failed" ? current : { ...current, phase: "ended" })),
      error: (error) => onState(key, (current) => ({ ...current, phase: "failed", errorKey: logErrorKey(error) }))
    });
  }, [hostId, containerId, service, attempt, onLine, onState]);
  return null;
}

const FRESH_SOURCE: SourceState = { phase: "connecting", errorKey: null, failure: null };

/**
 * ⚠️ `stateDot` COMES FROM THE PAGE (#258). The state dot of a container
 * (`ContainerStateDot`) belongs to the container surfaces, and a feature
 * imports no other part of the app; the stack page that hangs this tab in
 * passes it down. What two surfaces show together is put together above both
 * (`docs/design/feature-architecture.md`, rule 1).
 */
export function StackLogView({
  hostId,
  containers,
  stateDot
}: {
  hostId: string;
  containers: OverviewContainer[];
  stateDot?: (container: OverviewContainer) => ReactNode;
}) {
  const t = useTranslations();
  // Seit #124 steht auch ein fremdverwalteter Container in der Allowlist des
  // Arms (`externallyManaged`); sein Log ist lesbar wie jedes andere.
  const [selected, setSelected] = useState<string[]>(() => initialSelection(containers));
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const [merged, setMerged] = useState<{ lines: StackLogLine[]; dropped: number }>({ lines: [], dropped: 0 });
  const [filter, setFilter] = useState("");
  // Klebt die Ansicht am unteren Rand? Die Regel steht in `stick-to-bottom.ts`.
  const { scrollRef, stuck, pinIfStuck, noteScroll, jumpToEnd, restick } = useStickToBottom();
  // ⚠️ AUSSERHALB DER ZUSTANDSFUNKTION GEZÄHLT. React ruft eine solche
  // Funktion in der Entwicklung zweimal auf; ein Zähler darin vergäbe jede
  // Nummer doppelt.
  const seq = useRef(0);

  // ⚠️ STABILE RÜCKRUFE, und das ist keine Feinheit: sie stehen in den
  // Abhängigkeiten jedes `StackLogSource`. Ein neuer Rückruf je Zeichnung risse
  // bei jeder eintreffenden Zeile ALLE Ströme ab und öffnete sie neu.
  const onLine = useCallback((containerId: string, service: string, line: LogLine) => {
    seq.current += 1;
    const entry: StackLogLine = { ...line, containerId, service, seq: seq.current, order: timeKey(line.ts) };
    setMerged((current) => {
      const next = insertByTime(current.lines, entry, HELD_LINE_CAP);
      return { lines: next.lines, dropped: current.dropped + next.dropped };
    });
  }, []);
  const onState = useCallback((key: string, edit: (current: SourceState) => SourceState) => {
    setSources((current) => ({ ...current, [key]: edit(current[key] ?? FRESH_SOURCE) }));
  }, []);
  const events = useMemo<SourceEvents>(() => ({ onLine, onState }), [onLine, onState]);

  const attemptOf = (containerId: string) => attempts[containerId] ?? 0;
  const stateOf = (containerId: string) => sources[sourceKey(containerId, attemptOf(containerId))] ?? FRESH_SOURCE;

  // ⚠️ ABWÄHLEN NIMMT DIE ZEILEN DIESES CONTAINERS MIT. Blieben sie stehen,
  // brächte ein erneutes Wählen seine Vergangenheit ein zweites Mal — der
  // frische Strom liefert sie ohnehin mit.
  const dropLinesOf = (containerIds: string[]) =>
    setMerged((current) => ({
      ...current,
      lines: current.lines.filter((line) => !containerIds.includes(line.containerId))
    }));

  const toggle = (containerId: string) => {
    if (selected.includes(containerId)) {
      setSelected((current) => current.filter((id) => id !== containerId));
      dropLinesOf([containerId]);
      return;
    }
    restick();
    setSelected((current) => [...current, containerId]);
  };

  // ⚠️ EIN KNOPF UND KEINE SCHLEIFE, aus demselben Grund wie in `LogView`
  // (#126): ein vergessener Reiter, der von selbst neu anklopft, sperrte das
  // Log des Arms für alle anderen. Neu verbunden werden nur die gescheiterten
  // Ströme — ein laufender behält seine Zeilen und seinen Platz.
  const failed = selected.filter((containerId) => stateOf(containerId).phase === "failed");
  const reconnect = () => {
    restick();
    dropLinesOf(failed);
    setAttempts((current) => {
      const next = { ...current };
      for (const containerId of failed) next[containerId] = (next[containerId] ?? 0) + 1;
      return next;
    });
  };

  // Wie in `LogView`: `useLayoutEffect`, damit das Feld vor dem nächsten
  // `scroll`-Ereignis am Ende steht (#230).
  useLayoutEffect(pinIfStuck, [merged, filter, pinIfStuck]);

  // Der Filter filtert die Anzeige und nicht die Ströme — siehe `LogView`.
  // Er trifft auch den Dienst: „sonarr" zeigt alles, was sonarr sagt.
  const needle = filter.trim().toLowerCase();
  const visible =
    needle === ""
      ? merged.lines
      : merged.lines.filter(
          (line) => line.text.toLowerCase().includes(needle) || line.service.toLowerCase().includes(needle)
        );

  const open = selected.some((containerId) => stateOf(containerId).phase === "open");
  const connecting = selected.some((containerId) => stateOf(containerId).phase === "connecting");
  const statusText =
    containers.length === 0
      ? t("stackLogsNoContainers")
      : selected.length === 0
        ? t("stackLogsNoneSelected")
        : connecting && !open
          ? t("logConnecting")
          : open && merged.lines.length === 0
            ? t("stackLogsWaiting")
            : null;

  const byId = new Map(containers.map((container) => [container.id, container]));
  // Die Farbe hängt an der Stelle in der Liste des Stacks — siehe `service-colors.ts`.
  const positionOf = new Map(containers.map((container, index) => [container.id, index]));
  const colorOf = (containerId: string) => serviceColor(positionOf.get(containerId) ?? 0);

  return (
    <Card className="min-h-0 flex-1 gap-3 overflow-hidden border-card-line bg-body-face p-3" data-testid="stack-log-view">
      {selected.map((containerId) => {
        const container = byId.get(containerId);
        if (container === undefined) return null;
        const attempt = attemptOf(containerId);
        return (
          <StackLogSource
            key={sourceKey(containerId, attempt)}
            hostId={hostId}
            containerId={containerId}
            service={serviceOf(container)}
            attempt={attempt}
            events={events}
          />
        );
      })}

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium" id="stack-log-pick-label">
          {t("stackLogsPickLabel")}
        </span>
        {/* ⚠️ KNÖPFE MIT `aria-pressed` UND KEINE KÄSTCHEN. Sie tragen den
            Zustandspunkt des Containers daneben, so wie die Chips im Artboard,
            und brauchen keinen neuen Baustein. */}
        <div role="group" aria-labelledby="stack-log-pick-label" className="flex flex-wrap gap-1.5">
          {containers.map((container) => {
            const isSelected = selected.includes(container.id);
            return (
              <button
                key={container.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(container.id)}
                data-testid={`stack-log-pick-${container.name}`}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs",
                  isSelected
                    ? "border-accent-line bg-accent text-accent-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
              >
                {stateDot?.(container)}
                {/* Dieselbe Farbe wie der Name in den Zeilen darunter. */}
                <span style={isSelected ? { color: colorOf(container.id) } : undefined}>{serviceOf(container)}</span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("stackLogsPickHint")}
        </p>
      </div>

      {/* Je Strom ein Satz, mit dem Dienst davor. */}
      {selected.map((containerId) => {
        const container = byId.get(containerId);
        const state = stateOf(containerId);
        if (container === undefined) return null;
        const service = serviceOf(container);
        if (state.errorKey !== null) {
          return (
            <p key={containerId} role="alert" className="text-[13px] text-destructive" data-testid="stack-log-error">
              {t("stackLogsSourceProblem", { service, message: t(state.errorKey) })}
            </p>
          );
        }
        if (state.failure !== null) {
          return (
            <p key={containerId} role="alert" className="text-[13px] text-state-warn" data-testid="stack-log-error">
              {t("stackLogsSourceProblem", { service, message: logFailureText(t, state.failure.reason) })}
            </p>
          );
        }
        if (state.phase === "ended") {
          return (
            <p key={containerId} className="text-[13px] text-subtle-foreground">
              {t("stackLogsSourceEnded", { service })}
            </p>
          );
        }
        return null;
      })}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13px] text-subtle-foreground" data-testid="stack-log-status">
            {statusText}
          </span>
          <span className="text-xs text-muted-foreground">{t("logLineCount", { count: merged.lines.length })}</span>
        </div>
        <div className="ml-auto flex flex-col gap-1">
          <Label htmlFor="stack-log-filter">{t("logFilterLabel")}</Label>
          <Input
            id="stack-log-filter"
            className="w-[18rem]"
            value={filter}
            placeholder={t("logFilterPlaceholder")}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>

      {merged.dropped === 0 ? null : (
        <p className="text-xs text-muted-foreground">{t("logTrimmed", { count: HELD_LINE_CAP })}</p>
      )}

      <div
        ref={scrollRef}
        onScroll={noteScroll}
        role="log"
        aria-label={t("stackLogsLinesLabel")}
        className="min-h-[12rem] flex-1 overflow-y-auto rounded-md border border-accent-line bg-body-face p-2 font-mono text-xs"
        data-testid="stack-log-lines"
      >
        {visible.map((line) => (
          <LogRow
            key={line.seq}
            line={line}
            testId="stack-log-line"
            service={line.service}
            serviceColor={colorOf(line.containerId)}
          />
        ))}
        {visible.length === 0 && merged.lines.length > 0 ? (
          <p className="text-[13px] text-muted-foreground">{t("logFilterEmpty")}</p>
        ) : null}
      </div>

      {(!stuck && merged.lines.length > 0) || failed.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {!stuck && merged.lines.length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={jumpToEnd}>
              {t("logJumpToEnd")}
            </Button>
          ) : null}
          {failed.length > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={reconnect} data-testid="stack-log-reconnect">
              {t("logReconnect")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
