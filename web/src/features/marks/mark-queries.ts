import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { MarkView } from "contract";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchMarks } from "./api";

// The reads of the feature `marks` (#268): the stock of the own marks of the
// hub. Three surfaces read it: the panel in the settings, the pick list on the
// stack page and the pick list in the container list. Before #268 each of them
// asked for itself; they share one cache entry now, and a mark created in the
// panel is in the pick list of the next page without a second request.

/**
 * The stock of the own marks, `GET /api/marks`.
 *
 * `enabled` is for the surfaces that show the pick list to an administrator
 * only: a request for a list nobody sees is a request without a reader
 * (`StackScreen`, `ContainerBrowser`). The panel in the settings loads it for
 * everybody, as the route stands behind `withSession` and not behind
 * `requireAdmin`.
 */
export function useMarks({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: queryKeys.marks.list(), queryFn: fetchMarks, enabled });
}

/**
 * Writes a changed stock into the cache. The hub answers a create, a change
 * and a remove with what it stored, so no second request is needed; the update
 * is skipped while the list was not loaded yet.
 */
export function useMarkListUpdate() {
  const queryClient = useQueryClient();
  return (update: (current: MarkView[]) => MarkView[]) => {
    queryClient.setQueryData<MarkView[]>(queryKeys.marks.list(), (current) =>
      current === undefined ? current : update(current)
    );
  };
}
