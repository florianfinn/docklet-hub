import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContainerViewSettings, HostOverview } from "contract";

import { retainHostOverview } from "../../domain/hosts";
import { queryKeys } from "../../platform/query/query-keys";
import { fetchContainerViewSettings, fetchOverview } from "./api";

// The reads of the feature `containers` (#282): the overview of every arm and
// the switch that shows hub and agents. Before, each screen loaded them in its
// own `useEffect`; the overview, the container list and the tab "Hub &
// Agenten" now share one cache entry, and a mark assigned in one is on the
// others without a second request.

/**
 * Loads `GET /api/overview`; `data` is the list of arms, not the envelope.
 *
 * ⚠️ Every mount of a surface asks the arms again (stale time zero), and
 * nothing else does: no reload on window focus (`createQueryClient`). The
 * answer comes from the agents under the name of the caller, and the audit log
 * of an agent is the one trace that points from this hub to a person.
 */
export function useOverview() {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.containers.overview(),
    queryFn: async (): Promise<HostOverview[]> => {
      const next = (await fetchOverview()).hosts;
      const previous = client.getQueryData<HostOverview[]>(queryKeys.containers.overview());
      return next.map((entry) => retainHostOverview(entry, previous?.find((old) => old.host.id === entry.host.id)));
    }
  });
}

/**
 * Writes into the cached overview without asking the arms again.
 *
 * For writes whose answer already IS the new state: the marks of a container,
 * a stack hidden. A refetch after them would ask every arm a question whose
 * answer is on the screen.
 *
 * ⚠️ An overview that has not arrived yet stays absent: a write into an empty
 * cache would be dropped by the load arriving afterwards.
 */
export function useOverviewUpdate(): (update: (hosts: HostOverview[]) => HostOverview[]) => void {
  const client = useQueryClient();
  return useCallback(
    (update) => {
      client.setQueryData<HostOverview[]>(queryKeys.containers.overview(), (current) =>
        current === undefined ? current : update(current)
      );
    },
    [client]
  );
}

/**
 * Loads the container view of the hub (`GET /api/settings`, part `containers`).
 *
 * ⚠️ NO RETRY, unlike the default of `createQueryClient`. The lists wait for
 * this answer before they draw (`useShowSystemContainers` is `null` until it is
 * there), and a retry after a network failure would hold them for its delay
 * with nothing on the screen. A failed read falls back to the default at once,
 * as it did before the read became a query.
 */
export function useContainerViewSettings() {
  return useQuery({
    queryKey: queryKeys.settings.containerView(),
    queryFn: fetchContainerViewSettings,
    retry: false
  });
}

/** Writes the stored container view into the cache; the hub answers a write with it. */
export function useContainerViewUpdate(): (settings: ContainerViewSettings) => void {
  const client = useQueryClient();
  return useCallback(
    (settings) => {
      client.setQueryData<ContainerViewSettings>(queryKeys.settings.containerView(), settings);
    },
    [client]
  );
}

/**
 * Whether the lists show the containers of the hub itself — `null` while the
 * setting is not there yet.
 *
 * ⚠️ Scheitert der Abruf, gilt die Vorgabe (`false`, ausgeblendet) und die
 * Fläche zeichnet trotzdem. Eine Übersicht, die an einer Einstellung der
 * Darstellung hängen bliebe, verlöre ihre eigentliche Auskunft.
 */
export function useShowSystemContainers(): boolean | null {
  const view = useContainerViewSettings();
  if (view.isError) return false;
  return view.data === undefined ? null : view.data.showSystem === true;
}
