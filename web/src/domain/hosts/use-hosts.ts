import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { fetchHosts } from "./api";
import type { DockerHost } from "./host-types";
import { queryKeys } from "../../platform/query/query-keys";

// The list of arms, loaded once for every screen that shows it (#256).
//
// The hosts screen and the colour panel in the settings both read
// `GET /api/hosts`. Through this hook they share one cache entry: two screens,
// one request, and a colour chosen in the settings is on the host cards
// without a second round trip.
//
// It sits in `domain/` and not in a feature for the reason the server has
// `domain/hosts` (docs/design/feature-architecture.md, section 4): more than
// one feature needs the list, and a feature imports no other feature.

/** Loads `GET /api/hosts`; `data` is the list itself, not the envelope. */
export function useHosts() {
  return useQuery({
    queryKey: queryKeys.hosts.list(),
    queryFn: async (): Promise<DockerHost[]> => (await fetchHosts()).hosts
  });
}

/**
 * Writes into the cached list without asking the hub again.
 *
 * For writes whose answer already IS the new state: a created host, a removed
 * one, a saved colour. A refetch after them would ask a question whose answer
 * is already on the screen.
 *
 * ⚠️ A list that has not arrived yet stays absent. Writing `[host]` into an
 * empty cache would show a list of one while the real list is still loading,
 * and the load arriving afterwards would silently drop that write.
 */
export function useHostListUpdate(): (update: (hosts: DockerHost[]) => DockerHost[]) => void {
  const client = useQueryClient();
  return useCallback(
    (update) => {
      client.setQueryData<DockerHost[]>(queryKeys.hosts.list(), (current) =>
        current === undefined ? current : update(current)
      );
    },
    [client]
  );
}
