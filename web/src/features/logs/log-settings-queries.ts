import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { LogSettings } from "contract";

import { queryKeys } from "../../platform/query/query-keys";
import { fetchLogSettings } from "./api";

// The log settings of the hub as a query (#271). Until then the panel loaded
// them in its own `useEffect`; the rule `local/no-api-call-in-effect` closes
// that way.

/**
 * Loads the `logs` part of `GET /api/settings`.
 *
 * ⚠️ NO RETRY, unlike the default of `createQueryClient`: the panel showed a
 * failed read at once before it became a query, and a retry would hold an
 * empty field for its delay without saying why.
 */
export function useLogSettings() {
  return useQuery({ queryKey: queryKeys.settings.logs(), queryFn: fetchLogSettings, retry: false });
}

/** Writes the stored log settings into the cache; the hub answers a write with them. */
export function useLogSettingsUpdate(): (settings: LogSettings) => void {
  const client = useQueryClient();
  return useCallback((settings) => client.setQueryData<LogSettings>(queryKeys.settings.logs(), settings), [client]);
}
