import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";

import type { HostOverview } from "contract";

import { HOST_GRID_CLASS, HOST_SCREEN_CLASS } from "../../domain/hosts";
import type { Role } from "../../platform/session/session-user";
import { ContainerToolbar } from "./ContainerToolbar";
import { HostGroup } from "./HostGroup";
import { countContainers, scopeHosts, type ContainerFilter } from "./container-filter";
import { FILTER_KEYS } from "./filter-keys";
import { useOverview, useOverviewUpdate, useShowSystemContainers } from "./overview-queries";
import type { ContainerSlots } from "./slots";

// Die Übersicht — die Fläche, die nach der Anmeldung erscheint. Sie stand bis
// #282 als Rumpf in `app/screens/OverviewScreen.tsx`; der Bildschirm ist seitdem
// der Rahmen, der sie in die Navigation stellt.
//
// ⚠️ Sie führt STACKS und nicht Container: „Ein Stack ist die Einheit, in der
// ein Dienst betrieben wird; ein einzelner Container ist selten für sich
// interessant“ (docs/design/hub-color-and-structure.md §5). Gruppiert nach
// Host, die Container ohne Stack daneben. Die Liste jedes einzelnen Containers
// ist der Deepdive derselben Stelle — ein eigener Bildschirm, der mit seiner
// Fläche kommt und nicht hier.
//
// ⚠️ Bis D5 stand hier eine Tabelle mit Name, Image, Status, CPU und Speicher
// des ERSTEN Hosts, dazu eine Karte mit dem Zustand seines Agenten. Beides ist
// weg und nicht daneben: die Tabelle, weil sie einen Host zeigte, wo es
// mehrere gibt, und die Agent-Karte, weil ihre Angaben seit D5 auf der
// Host-Fläche stehen. CPU und Speicher gehören ans Container-Detail (Phase 5);
// in einer Liste von dreißig Zeilen wären es sechzig Zahlen, die niemand
// vergleicht.
//
// ⚠️ Die Zusammenfassung eines Stacks kommt FERTIG vom Server
// (`server/src/domain/containers/stacks.ts`). §5 nennt die Regel ausdrücklich Logik
// und keine Gestaltung — hier wird sie abgebildet und nicht gerechnet.
//
// ⚠️ Die Container des Leitstands selbst (Hub, Agenten) stehen hier nur, wenn
// die Einstellung es sagt — die Vorgabe blendet sie aus. Sie sind auf jedem
// Arm dieselben und beantworten „läuft mein Haus“ nicht; ihr Ort ist der
// Reiter „Hub & Agenten“ der Einstellungen.
//
// ⚠️ MARKEN UND AUSLASTUNG KOMMEN AUS `app/` (Regel 1): `slots` trägt, was die
// Zeilen an Marken und Messwerten zeichnen, und `setStackHidden` ist das
// Schreiben der Einstellung „Stack ausblenden“, das zu den Marken gehört. Ohne
// sie zeichnet die Übersicht Stacks und Container ohne beides.

/** Setzt `hidden` an genau einem Stack eines Hosts und lässt alles andere stehen. */
function withHidden(hosts: HostOverview[], hostId: string, project: string, hidden: boolean): HostOverview[] {
  return hosts.map((entry) =>
    entry.host.id !== hostId
      ? entry
      : {
          ...entry,
          stacks: entry.stacks.map((stack) => (stack.project === project ? { ...stack, hidden } : stack))
        }
  );
}

type OverviewViewProps = {
  role: Role;
  slots?: ContainerSlots;
  /** Writes `hidden` for one stack and answers with the stored state. Admin only. */
  setStackHidden?: (hostId: string, project: string, hidden: boolean) => Promise<boolean>;
};

export function OverviewView({ role, slots, setStackHidden }: OverviewViewProps) {
  const t = useTranslations();
  const overview = useOverview();
  const updateOverview = useOverviewUpdate();
  const showSystem = useShowSystemContainers();
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [query, setQuery] = useState("");

  const loaded = overview.data ?? null;
  const failed = overview.isError;
  // `null`, bis beides da ist: die Antwort und die Einstellung. Sonst stünde
  // kurz die falsche Menge da und spränge dann um.
  const hosts =
    loaded === null || showSystem === null ? null : scopeHosts(loaded, showSystem ? "all" : "workload");
  const counts = countContainers(hosts ?? [], query);

  // ⚠️ Erst schreiben, dann umstellen — und die Zeile nimmt den Stand aus der
  // ANTWORT, nicht den erbetenen. Ein Stack, der sofort nach unten rückte und
  // bei einem Fehler zurücksprang, wäre eine Bewegung, die der Betreiber für
  // gespeichert hält.
  const changeHidden =
    role === "admin" && setStackHidden !== undefined
      ? (hostId: string, project: string, hidden: boolean) => {
          void setStackHidden(hostId, project, hidden)
            .then((stored) => updateOverview((current) => withHidden(current, hostId, project, stored)))
            .catch(() => toast.error(t("stackHideFailed", { project })));
        }
      : undefined;

  // Die Schale liefert das `<main>` über `SidebarInset`; dieser Bildschirm
  // sitzt darin und trägt deshalb selbst keine zweite Landmarke.
  return (
    <div className={HOST_SCREEN_CLASS}>
      <div>
        <h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("overviewTitle")}</h1>
        <p className="mt-1 flex items-center gap-2 text-[13px] text-subtle-foreground">
          <span>{t("hostsCount", { count: hosts?.length ?? 0 })}</span>
          <span aria-hidden="true">·</span>
          <span>{t("hostContainersCount", { count: counts.all })}</span>
          <span aria-hidden="true">·</span>
          <span>{t("hostRunningCount", { count: counts.running })}</span>
        </p>
      </div>

      <ContainerToolbar
        filter={filter}
        onFilterChange={setFilter}
        labelKeys={FILTER_KEYS}
        counts={counts}
        query={query}
        onQueryChange={setQuery}
      />

      {failed ? <p className="text-sm text-destructive">{t("containersFailed")}</p> : null}
      {!failed && hosts === null ? <p className="text-muted-foreground">{t("loading")}</p> : null}
      {hosts !== null && hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("hostsEmpty")}</p>
      ) : null}

      <div className={HOST_GRID_CLASS}>
        {(hosts ?? []).map((entry) => (
          <HostGroup
            key={entry.host.id}
            entry={entry}
            filter={filter}
            query={query}
            slots={slots}
            onHiddenChange={
              changeHidden ? (project, hidden) => changeHidden(entry.host.id, project, hidden) : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
