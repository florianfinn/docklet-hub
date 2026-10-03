import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import { HOST_GRID_CLASS } from "../../domain/hosts";
import { ContainerToolbar } from "./ContainerToolbar";
import { HostContainers } from "./HostContainers";
import { countContainers, scopeHosts, type ContainerFilter, type ContainerScope } from "./container-filter";
import { FILTER_KEYS } from "./filter-keys";
import { useOverview } from "./overview-queries";
import type { ContainerSlots } from "./slots";

// Der Deepdive als Baustein: Leiste, Zähler und jeder Container einzeln,
// nach Host geordnet. Er stand bis zum Reiter „Hub & Agenten" als Rumpf in
// `ContainersScreen` und ist herausgelöst, damit dieser Reiter ALLE
// Funktionen der Fläche bekommt — Suche, Filter, Marken, die Wege zu Logs,
// Shell und Dateien — und nicht eine zweite, ärmere Liste. Die Begründungen
// zu Marken, Endpunkt und fehlenden Chips stehen weiter in
// `app/screens/ContainersScreen.tsx`.
//
// ⚠️ `scope` schränkt VOR Suche und Filter ein (`scopeHosts`). `null` heißt:
// noch nicht bekannt — die Fläche wartet dann mit „wird geladen", statt kurz
// die falsche Menge zu zeigen und dann umzuspringen.
//
// ⚠️ DIE MARKEN UND IHR GRIFF KOMMEN AUS `app/` (#282, Regel 1): `slots` trägt
// sie herein. Dass ein Zuordnen den gehaltenen Stand fortschreibt, geschieht
// dort über `useOverviewUpdate()`, am selben Eintrag im Zwischenspeicher, aus
// dem diese Liste liest.

type ContainerBrowserProps = {
  scope: ContainerScope | null;
  // Die Überschrift der Fläche. Sie kommt von außen: auf der eigenen Seite
  // ist sie ein `h1`, im Reiter der Einstellungen steht sie unter dessen `h1`.
  heading: ReactNode;
  slots?: ContainerSlots;
};

export function ContainerBrowser({ scope, heading, slots }: ContainerBrowserProps) {
  const t = useTranslations();
  const overview = useOverview();
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [query, setQuery] = useState("");

  const loaded = overview.data ?? null;
  const failed = overview.isError;
  const hosts = loaded === null || scope === null ? null : scopeHosts(loaded, scope);
  const counts = countContainers(hosts ?? [], query);

  return (
    <>
      <div>
        {heading}
        <p className="mt-1 flex items-center gap-2 text-[13px] text-subtle-foreground">
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
          <HostContainers
            key={entry.host.id}
            entry={entry}
            filter={filter}
            query={query}
            slots={slots}
          />
        ))}
      </div>
    </>
  );
}
