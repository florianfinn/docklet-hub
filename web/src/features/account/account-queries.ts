import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchUsers } from "./api";

// The read of the feature `account` (#269): the list of accounts.

/**
 * The accounts of the hub, `GET /api/users`.
 *
 * `enabled` is false for everybody but an administrator: the route stands
 * behind `requireAdmin`, and a request that is known to end in 403 is not
 * made (`api.ts`). Nothing is invalidated: the page asks again when it is
 * opened anew, and the whole cache is emptied when nobody is signed in
 * (`App.tsx`).
 */
export function useAccounts({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.account.users(),
    queryFn: async () => (await fetchUsers()).users,
    enabled
  });
}
