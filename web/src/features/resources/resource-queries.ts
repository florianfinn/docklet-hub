import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchHostResources } from "./api";

// One read per opening of the page and on request. The agent sums every
// volume on disk for it, so neither a window focus nor a failure asks again by
// itself.
export function useHostResources(hostId: string) {
  return useQuery({
    queryKey: queryKeys.resources.host(hostId),
    queryFn: () => fetchHostResources(hostId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    refetchOnMount: "always"
  });
}
