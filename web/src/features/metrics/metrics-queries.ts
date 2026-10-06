import { useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchContainerStats } from "./api";

// The stats of one container, polled while the surface is mounted (#283).
//
// ⚠️ THE CLOCK IS THE AGENT'S: ten seconds. Asking faster brings no new point,
// only one more request.
//
// ⚠️ NO RETRY. The next tick is the retry; a retry before it would add a
// request to a poll that already repeats, and show the failure later.
//
// ⚠️ NO POLL WHILE THE SURFACE IS NOT VISIBLE. The surface is mounted only on
// the tab that shows it, so a tab switch ends the query's observer and with it
// the interval; and TanStack Query pauses the interval itself while the browser
// tab is in the background (`refetchIntervalInBackground` stays off).
export const STATS_REFRESH_MS = 10_000;

export function useContainerStats(hostId: string, containerId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.metrics.containerStats(hostId, containerId),
    queryFn: async () => {
      const next = await fetchContainerStats(hostId, containerId);
      return next.stats === null ? client.getQueryData<Awaited<ReturnType<typeof fetchContainerStats>>>(queryKeys.metrics.containerStats(hostId, containerId)) ?? next : next;
    },
    refetchInterval: STATS_REFRESH_MS,
    retry: false
  });
}
