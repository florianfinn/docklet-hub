// The call of the feature `resources` to the hub (#10): images, volumes and
// networks of one host. `web/tests/client-files.mjs` holds it against the
// routes of the server like every other `api.ts`.

import { hostResourcesResponseSchema, type HostResourcesView } from "contract";

import { parseResponse, request } from "../../platform/http/transport";

export async function fetchHostResources(hostId: string): Promise<{ resources: HostResourcesView }> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/resources`;
  return parseResponse(path, hostResourcesResponseSchema, await request(path));
}
