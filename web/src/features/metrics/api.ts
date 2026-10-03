// The call of the feature `metrics` to the hub (#283): the measurements of one
// container with their history. Moved here from `web/src/api/client.ts`
// unchanged.
//
// ⚠️ THE MIRROR GUARD READS THIS FILE: `web/tests/client-files.mjs` collects
// every `api.ts` under `web/src/` next to `platform/http/`, so the
// call here is held against the routes of the server like any other.

import { containerStatsResponseSchema, type ContainerStats } from "contract";

import { parseResponse, request } from "../../platform/http/transport";

// Die Messwerte EINES Containers samt Verlauf — für sein Detail (#213).
// Über die Kennung und nicht den Namen: der Agent führt seine Allowlist über
// Kennungen.
export async function fetchContainerStats(
  hostId: string,
  containerId: string
): Promise<{ stats: ContainerStats | null }> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/stats`;
  return parseResponse(path, containerStatsResponseSchema, await request(path));
}
