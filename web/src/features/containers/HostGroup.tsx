import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import type { HostOverview } from "contract";

import { cn } from "../../platform/ui/lib/cn";
import { Card } from "../../platform/ui/shadcn/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../platform/ui/shadcn/collapsible";
import { hostDisplay, HostStatusBadge, HostStatusDot, summarize } from "../../domain/hosts";
import { allContainers, filterHost, normalizeQuery, type ContainerFilter } from "./container-filter";
import { ContainerList } from "./ContainerList";
import { StackRow } from "./StackRow";
import type { ContainerSlots } from "./slots";

// Ein Host als Gruppe: Kopf mit Name und Zustand, darunter seine Stacks und
// die Container ohne Stack. Die Reihenfolge folgt
// docs/design/hub-color-and-structure.md §5 („Übersicht führt Stacks,
// gruppiert nach Host, dazu die Container ohne Stack“).
//
// ⚠️ Dieselben drei Attribute wie an der Host-Karte aus D5 — `data-host`,
// `data-hue`, `data-ink`. Die Ableitungsregel in web/src/platform/theme/palette.css
// rechnet daraus die Palette DIESES Teilbaums; eine Variable löst dort auf, wo
// sie deklariert ist. Ohne sie käme hier der Grundton des Hauses an, und die
// Achse aus D0 wäre auf der Fläche, für die sie gedacht ist, unsichtbar.
//
// ⚠️ Die Gruppe bleibt STEHEN, auch wenn nach Suche und Filter nichts von ihr
// übrig ist. Ein Host, der aus der Liste verschwindet, sieht aus wie ein Host,
// den es nicht mehr gibt — und genau in dem Moment, in dem der Betreiber nach
// etwas sucht, wäre das die falsche Auskunft.
//
// ⚠️ Ein AUSGEBLENDETER Stack (Kontextmenü an der Stack-Zeile) verschwindet
// aus demselben Grund nicht: er rückt ganz nach unten, unter die Container
// ohne Stack, in einen Abschnitt, der zugeklappt anfängt. Suche und Filter
// gelten für ihn wie für jeden anderen Stack.

type HostGroupProps = {
  // `hidden` ist freiwillig: wer keinen Umfang wählt, blendet nichts aus.
  entry: HostOverview & { hidden?: number };
  filter: ContainerFilter;
  query: string;
  /** Nur mit Adminrolle — ohne ihn fehlt „Ausblenden" im Kontextmenü. */
  onHiddenChange?: (project: string, hidden: boolean) => void;
  slots?: ContainerSlots;
};

export function HostGroup({ entry, filter, query, onHiddenChange, slots }: HostGroupProps) {
  const t = useTranslations();
  // Aus der Ablage, nicht aus der Kennung (D7a).
  const display = hostDisplay(entry.host);
  const { stacks, loose, count } = filterHost(entry, filter, query);
  const total = entry.stacks.reduce((sum, stack) => sum + stack.containers.length, 0) + entry.loose.length;
  const searching = normalizeQuery(query) !== "";
  const shown = stacks.filter((stack) => !stack.hidden);
  const hiddenStacks = stacks.filter((stack) => stack.hidden);
  const hiddenChange = (project: string) =>
    onHiddenChange ? (next: boolean) => onHiddenChange(project, next) : undefined;
  const row = (stack: (typeof stacks)[number]) => (
    // Bei einer Suche steht der Treffer offen: ihn erst suchen und dann
    // aufklappen zu müssen wäre eine Suche, die nur den Ort des Fundes
    // verrät.
    //
    // ⚠️ Der Suchzustand steht IM SCHLÜSSEL. `StackRow` hält sein
    // Auf und Zu selbst — wer aufklappt, will es aufgeklappt haben —,
    // und ein Anfangswert, der sich später ändert, erreicht die
    // Komponente sonst nie: React behält den Zustand einer Zeile, die an
    // derselben Stelle steht. Mit dem Schlüssel wird sie beim Umschalten
    // zwischen „Suche“ und „keine Suche“ neu aufgebaut, und der neue
    // Anfangswert gilt. Gemessen am 2026-09-06: ohne diesen Zusatz blieb
    // der einzige Treffer einer Suche zugeklappt.
    <StackRow
      key={`${stack.project}:${searching ? "found" : "all"}`}
      hostId={entry.host.id}
      stack={stack}
      open={searching}
      onHiddenChange={hiddenChange(stack.project)}
      slots={slots}
    />
  );
  // ⚠️ Ein wartender Arm hat NICHTS zu zeigen — keine Container, keine
  // Meldung, keinen Hinweis auf eine leere Allowlist (sein Agent existiert
  // noch nicht, es ist niemand da, der eine hätte). Ohne diese Abfrage stünde
  // unter seinem Kopf ein leerer Streifen: eine Fläche, die etwas ankündigt,
  // das nicht kommt. Gemessen am 2026-09-06 in der Vorschau.
  const hasBody = entry.error !== null || entry.agent !== null;
  // Die Zähler im Kopf: „3 Stacks · 21 Container" am Namen, „18 laufen" am
  // rechten Rand (docs/design/mockup/hub-palette.html Z. 489–491) — dieselbe
  // Zählweise wie an der Host-Karte (`hosts/host-summary.ts`): ein kranker
  // Container läuft.
  //
  // ⚠️ Nur, wenn der Arm geantwortet hat. Bei einem wartenden Arm gibt es
  // keinen Agenten, bei einem Fehler keine Liste; eine „0" sagte dort etwas
  // über den Bestand, das niemand gemessen hat.
  const answered = entry.error === null && entry.agent !== null;
  const running = summarize(allContainers([entry])).running;

  return (
    <Card
      data-host={entry.host.id}
      data-hue={display.hue}
      data-ink={display.ink}
      className="gap-0 overflow-hidden border-card-line bg-body-face py-0"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <HostStatusDot status={entry.host.status} className="size-[9px]" />
        <span className="font-mono text-sm font-medium">{entry.host.name}</span>
        <HostStatusBadge status={entry.host.status} />
        {answered ? (
          <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-subtle-foreground">
            <span>{t("hostStacksCount", { count: entry.stacks.length })}</span>
            <span aria-hidden="true">·</span>
            <span>{t("hostContainersCount", { count: total })}</span>
          </span>
        ) : null}
        {answered ? (
          <span className="ml-auto font-mono text-[11.5px] text-subtle-foreground">
            {t("hostRunningCount", { count: running })}
          </span>
        ) : null}
      </div>

      <div className={hasBody ? "p-2" : "hidden"}>
        {/* Die Meldung des Servers, wörtlich. Sie ist kein Text dieser
            Oberfläche, sondern die Auskunft des Arms über sich selbst — und
            beantwortet die Frage, die eine leere Liste sonst offenließe. */}
        {entry.error ? <p className="px-2.5 py-1.5 text-[13px] text-destructive">{entry.error}</p> : null}

        {entry.error === null && total === 0 && (entry.hidden ?? 0) === 0 && entry.agent !== null ? (
          <div className="px-2.5 py-2">
            <p className="text-[13px] font-medium">{t("containersEmptyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("containersEmptyBody")}</p>
          </div>
        ) : null}

        {/* Alles auf diesem Arm gehört zum Leitstand selbst und ist
            ausgeblendet (Einstellungen › Container). Ohne diese Zeile stünde
            hier „Kein Container freigegeben“ — eine falsche Auskunft über
            die Allowlist. */}
        {entry.error === null && total === 0 && (entry.hidden ?? 0) > 0 ? (
          <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">
            {t("containersOnlySystem", { count: entry.hidden ?? 0 })}
          </p>
        ) : null}

        {total > 0 && count === 0 ? (
          <p className="px-2.5 py-1.5 text-[13px] text-muted-foreground">{t("overviewNoMatches")}</p>
        ) : null}

        {shown.map(row)}

        {loose.length > 0 ? (
          <>
            {/* Die Überschrift steht nur da, wenn es auch Stacks gibt —
                sonst unterscheidet sie nichts von nichts. */}
            {shown.length > 0 ? (
              <p className="px-2.5 pt-3 pb-1 text-[11px] tracking-wide text-subtle-foreground uppercase">
                {t("overviewWithoutStack")}
              </p>
            ) : null}
            <ContainerList containers={loose} hostId={entry.host.id} slots={slots} />
          </>
        ) : null}

        {hiddenStacks.length > 0 ? (
          // ⚠️ Der Suchzustand steht auch hier IM SCHLÜSSEL, aus demselben
          // Grund wie an `StackRow`: eine Suche, deren Treffer in einem
          // zugeklappten Abschnitt läge, fände ihn nicht sichtbar.
          <HiddenStackSection key={searching ? "found" : "all"} count={hiddenStacks.length} open={searching}>
            {hiddenStacks.map(row)}
          </HiddenStackSection>
        ) : null}
      </div>
    </Card>
  );
}

/** Der zugeklappte Abschnitt am Ende eines Hosts mit den ausgeblendeten Stacks. */
function HiddenStackSection({ count, open, children }: { count: number; open: boolean; children: ReactNode }) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(open);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} data-testid="hidden-stacks">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2.5 pt-3 pb-1 text-left text-[11px] tracking-wide text-subtle-foreground uppercase hover:text-foreground">
        <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        {t("overviewHiddenStacks", { count })}
      </CollapsibleTrigger>
      <CollapsibleContent className="opacity-70">{children}</CollapsibleContent>
    </Collapsible>
  );
}
