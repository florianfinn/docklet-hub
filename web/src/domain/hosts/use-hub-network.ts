import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchHubNetwork } from "./api";

/**
 * The network of the hub as a query (#271), read by the create dialog of the
 * feature `hosts` and the network panel of the settings. Until then each
 * loaded it in its own `useEffect`.
 *
 * ⚠️ NO RETRY, unlike the default of `createQueryClient`: both readers showed
 * a failed read at once before, and the create dialog goes on without it (the
 * server is the barrier against an unusable address, not this answer).
 */
export function useHubNetwork() {
  return useQuery({ queryKey: queryKeys.settings.hubNetwork(), queryFn: fetchHubNetwork, retry: false });
}
