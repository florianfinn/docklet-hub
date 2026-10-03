import { useTranslations } from "use-intl";

import type { HostOverview } from "contract";

import { Card } from "../../platform/ui/shadcn/card";
import { hostDisplay, HostStatusBadge, HostStatusDot, summarize } from "../../domain/hosts";
import { ContainerList } from "./ContainerList";
import { allContainers, filterHost, type ContainerFilter } from "./container-filter";
import { StackSection } from "./StackSection";
import type { ContainerSlots } from "./slots";

// Ein Host im Deepdive: derselbe Kopf wie in der Übersicht
// (`HostGroup.tsx`), darunter aber jeder Container
// einzeln statt zugeklappter Stacks.
//
// ⚠️ Warum nicht dieselbe Komponente mit einem Schalter: der Unterschied ist
// nicht ein Zustand, sondern die Aufgabe. Die Übersicht zeigt Stacks und
// verbirgt Container, der Deepdive zeigt Container und ordnet sie nur nach
// Stacks. Ein `expanded`-Schalter an HostGroup wäre eine Komponente mit zwei
// Absichten — und der nächste Schalter träfe die falsche.
//
// GETEILT ist dagegen alles, was beide Flächen gleich beantworten: der Kopf
// (dieselben drei Attribute `data-host`, `data-hue`, `data-ink` und dieselben
// Zustandsmarken des Hosts), Suche und Filter (`filterHost`), die Zeile eines
// Containers und die Gruppe der fremdverwalteten (`ContainerList`).

type HostContainersProps = {
  // `hidden` ist freiwillig — siehe `ScopedHost` in `container-filter.ts`.
  entry: HostOverview & { hidden?: number };
  filter: ContainerFilter;
  query: string;
  /**
   * Die Plätze für Marken und Auslastung an den Zeilen DIESES Arms, aus `app/`.
   *
   * ⚠️ Freiwillig. Ob die Container-Zeilen einen Griff zum Zuordnen tragen,
   * entscheidet, was `app/` hier einsetzt; die Fläche selbst kennt weder die
   * Marken noch die Rolle.
   */
  slots?: ContainerSlots;
};

export function HostContainers({ entry, filter, query, slots }: HostContainersProps) {
  const t = useTranslations();
  // Aus der Ablage, nicht aus der Kennung (D7a).
  const display = hostDisplay(entry.host);
  const { stacks, loose, count } = filterHost(entry, filter, query);
  const total = entry.stacks.reduce((sum, stack) => sum + stack.containers.length, 0) + entry.loose.length;
  // ⚠️ Wie in der Übersicht: ein wartender Arm hat nichts zu zeigen — sein
  // Agent existiert noch nicht. Ohne diese Abfrage stünde unter seinem Kopf
  // ein leerer Streifen.
  const hasBody = entry.error !== null || entry.agent !== null;
  // Wie in der Übersicht, aber ohne die Zahl der Stacks: der Kopf des
  // Deepdives im Artboard nennt nur die Container (hub-palette.html Z. 569f.).
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
        {/* Die Meldung des Servers, wörtlich — sie ist die Auskunft des Arms
            über sich selbst und kein Text dieser Oberfläche. */}
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

        {stacks.map((stack) => (
          <StackSection key={stack.project} hostId={entry.host.id} stack={stack} slots={slots} />
        ))}

        {loose.length > 0 ? (
          <>
            {/* Die Überschrift steht nur da, wenn es auch Stacks gibt — sonst
                unterscheidet sie nichts von nichts. */}
            {stacks.length > 0 ? (
              <p className="px-2.5 pt-3 pb-1 text-[11px] tracking-wide text-subtle-foreground uppercase">
                {t("overviewWithoutStack")}
              </p>
            ) : null}
            <ContainerList containers={loose} hostId={entry.host.id} slots={slots} />
          </>
        ) : null}
      </div>
    </Card>
  );
}
