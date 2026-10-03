import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import {
  HOST_GRID_CLASS,
  HOST_SCREEN_CLASS,
  total,
  useHostListUpdate,
  useHosts,
  type DockerHost,
  type HostCounters,
  type HostSummary
} from "../../domain/hosts";
import { formatClock } from "../../platform/i18n/time-format";
import { queryKeys } from "../../platform/query/query-keys";
import { Button } from "../../platform/ui/shadcn/button";
import { HostCard, type HostRole, type RenderHostActions, type RenderHostLoad } from "./HostCard";
import { HostCreateDialog } from "./HostCreateDialog";
import { useHostCounters } from "./use-host-counters";

// Die Host-Verwaltung als eigene Fläche (D5, #62).
//
// ⚠️ Sie stand bis D4 als Abschnitt UNTER der Container-Tabelle im
// `OverviewScreen`. Das war richtig, solange es einen Bildschirm gab; mit D6
// wird die Übersicht laut docs/design/hub-color-and-structure.md §5 zur
// Stack-Übersicht, und ein Anhang mit Anlegen, Archiv und Entfernen hätte
// darin keinen Platz mehr. Er steht deshalb ab hier für sich, mit einem
// eigenen Eintrag in der Seitenleiste — und ist damit auch über ⌘K zu finden.
//
// Since #256 it loads through TanStack Query: the list through `useHosts()`
// (shared with the colour panel in the settings), the counters through one
// query per arm (`use-host-counters.ts`). Which arms are asked at all is
// explained there.

function summariesOf(hosts: DockerHost[], counters: Record<string, HostCounters>): HostSummary[] {
  // `flatMap` und nicht `filter` + `map`: ein `filter` mit einer Bedingung
  // verengt den Typ seines Ergebnisses nicht, und der `map` dahinter griffe
  // auf `summary` eines Wertes zu, den TypeScript weiterhin für „vielleicht
  // gar nicht geladen" hält.
  return hosts.flatMap((host) => {
    const entry = counters[host.id];
    return entry !== undefined && entry.state === "ready" ? [entry.summary] : [];
  });
}

export function HostsView({
  role,
  renderLoad,
  renderActions
}: {
  role: HostRole;
  renderLoad?: RenderHostLoad;
  renderActions?: RenderHostActions;
}) {
  const t = useTranslations();
  const language = useLocale();
  const queryClient = useQueryClient();
  const hostsQuery = useHosts();
  const updateHosts = useHostListUpdate();
  const hosts = hostsQuery.data ?? null;
  const { counters, updatedAt } = useHostCounters(hosts ?? []);
  const fetching = useIsFetching({ queryKey: queryKeys.hosts.all }) > 0;

  // A failed load shows its line even when an older list is still there; the
  // next successful load takes it back, because the query clears its error.
  const failed = hostsQuery.isError;
  const newest = Math.max(hostsQuery.dataUpdatedAt, updatedAt);
  const measuredAt = newest === 0 ? null : new Date(newest);

  // Measure again, on request.
  //
  // ⚠️ WHY THIS BUTTON MUST EXIST. State and counters come from `probeAgent`
  // and a question to the agent — both are MEASUREMENTS from the time of
  // loading, not facts that correct themselves. The screen has no connection
  // over which anyone reports a change; without this button it shows truth of
  // any age. Measured case: an arm that was `pending` when created and
  // `online` after its agent started stayed `pending` until the page was
  // reloaded.
  //
  // Invalidating `hosts.all` reloads the list and every arm's counters in one
  // call. What is already shown stays shown until something better arrives —
  // a query keeps its data while it refetches, so the list does not vanish for
  // the duration of the slowest arm.
  //
  // ⚠️ The guard stays although the button is disabled meanwhile: `disabled`
  // is a statement of the interface, not of the flow, and a second
  // invalidation would cancel the running measurement and start it over.
  const refreshing = fetching && hosts !== null;
  const refresh = () => {
    if (fetching) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.hosts.all });
  };

  // ⚠️ A newly created arm gets NO counter request: it is `pending`, its agent
  // does not exist yet. Its card therefore shows "unreachable" from the start
  // instead of a load that never ends (`use-host-counters.ts`).
  const addHost = (host: DockerHost) => {
    updateHosts((current) => [...current, host]);
  };

  const removeHost = (hostId: string) => {
    updateHosts((current) => current.filter((host) => host.id !== hostId));
    queryClient.removeQueries({ queryKey: queryKeys.hosts.containers(hostId) });
  };

  // Über NULL Karten summiert ergibt sich EMPTY_SUMMARY — deshalb steht die
  // Fallunterscheidung innen und nicht außen: außen wäre der eine Zweig eine
  // leere Liste und der andere eine Summe, und beides zusammen hätte keinen
  // gemeinsamen Typ.
  const sums = total(hosts === null ? [] : summariesOf(hosts, counters));

  // Die Schale liefert das `<main>` über `SidebarInset`; dieser Bildschirm
  // sitzt darin und trägt deshalb selbst keine zweite Landmarke.
  return (
    <div className={HOST_SCREEN_CLASS}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div>
          <h1 className="text-[20px] font-medium tracking-[-0.022em]">{t("hostsTitle")}</h1>
          {/* Die Zusammenfassung des Artboards: „3 Hosts · 34 verwaltet · 31
              laufen" (container-module.html Z. 137). Die Mehrzahl steckt in
              der Sprachdatei und nicht hier — siehe die Begründung dort. */}
          <p className="mt-1 flex items-center gap-2 text-[13px] text-subtle-foreground">
            <span>{t("hostsCount", { count: hosts?.length ?? 0 })}</span>
            <span aria-hidden="true">·</span>
            <span>{t("hostsManagedCount", { count: sums.containers })}</span>
            <span aria-hidden="true">·</span>
            <span>{t("hostRunningCount", { count: sums.running })}</span>
            {/* Wann die Liste gemessen wurde (#205): der Bildschirm berichtigt
                sich nicht von selbst, siehe `refresh`. */}
            {measuredAt === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="hosts-measured-at">
                  {t("hostsMeasuredAt", { at: formatClock(language, measuredAt) })}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Erneut messen darf JEDER, der die Fläche sehen darf: gelesen wird
              dabei nur, was ohnehin schon auf dem Bildschirm steht. Der Knopf
              hängt deshalb nicht an der Rolle — anders als das Anlegen. */}
          <Button
            type="button"
            variant="outline"
            onClick={refresh}
            disabled={refreshing}
            data-testid="hosts-refresh"
          >
            <RotateCw aria-hidden="true" />
            {refreshing ? t("hostsRefreshBusy") : t("hostsRefresh")}
          </Button>
          {/* Anlegen ist eine `requireAdmin`-Route; für alle anderen erscheint
              der Knopf gar nicht erst. */}
          {role === "admin" ? <HostCreateDialog onCreated={addHost} /> : null}
        </div>
      </div>

      {failed ? (
        <p className="text-sm text-destructive" data-testid="hosts-failed">
          {t("hostsFailed")}
        </p>
      ) : null}
      {!failed && hosts === null ? <p className="text-muted-foreground">{t("loading")}</p> : null}
      {hosts !== null && hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("hostsEmpty")}</p>
      ) : null}

      <div className={HOST_GRID_CLASS}>
        {(hosts ?? []).map((host) => (
          <HostCard
            key={host.id}
            host={host}
            role={role}
            counters={counters[host.id] ?? { state: "loading" }}
            onRemoved={removeHost}
            onAgentUpdated={refresh}
            renderLoad={renderLoad}
            renderActions={renderActions}
          />
        ))}
      </div>
    </div>
  );
}
