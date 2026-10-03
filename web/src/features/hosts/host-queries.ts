import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchAgentUpdateStatus } from "./api";

// The reads of the feature `hosts` that are not the list itself (#267). The
// list lives in `domain/hosts` (more than one screen shows it), the counters of
// an arm in `use-host-counters.ts`.

/**
 * The last run of the watcher on one arm, for the line "Letztes Agent-Update"
 * on its card (#205).
 *
 * The key sits below `hosts.all`, so "measure again" asks the arm again, and
 * so does the end of an agent update (`onAgentUpdated` of the card): after a
 * swap the card shows the new run without a second mechanism. The polling that
 * waits for the end of a swap stays in `AgentUpdate.tsx`: it has a deadline
 * and an arm that does not answer for minutes, which is not what a query
 * models.
 *
 * ⚠️ A failed read is an absent line, not an error: the route is `requireAdmin`
 * and an arm without an answer has no state (`LastAgentUpdate.tsx`). `data` is
 * `undefined` then.
 */
export function useAgentUpdateStatus(hostId: string) {
  return useQuery({
    queryKey: queryKeys.hosts.agentUpdate(hostId),
    queryFn: () => fetchAgentUpdateStatus(hostId)
  });
}
