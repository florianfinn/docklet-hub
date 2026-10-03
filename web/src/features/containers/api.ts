// The calls of the feature `containers` to the hub (#282): the overview of all
// arms and the switch that shows hub and agents in the lists. Moved here from
// `web/src/api/client.ts`; a feature imports nothing from `web/src/api/`, so
// the calls moved along.
//
// ⚠️ THE MIRROR GUARD READS THIS FILE: `web/tests/client-files.mjs` collects
// every `api.ts` under `web/src/` next to `platform/http/`, so a
// call here is held against the routes of the server like any other.

import {
  containerViewSettingsResponseSchema,
  overviewSchema,
  settingsSchema,
  type ContainerViewSettings,
  type HostOverview
} from "contract";

import { parseResponse, putJson, request } from "../../platform/http/transport";

/**
 * Every arm with its stacks and the containers without one, in one answer.
 *
 * ⚠️ The hub contacts every arm under the name of the caller (#125), so this is
 * not a call to repeat on a timer or on window focus (`createQueryClient`).
 * Parsed at the transport boundary (#247): a response that misses a field is an
 * error here and not an `undefined` three components further down.
 */
export async function fetchOverview(): Promise<{ hosts: HostOverview[] }> {
  return parseResponse("/api/overview", overviewSchema, await request("/api/overview"));
}

/**
 * Whether the lists show the containers of the hub itself, read from
 * `GET /api/settings`.
 *
 * ⚠️ THE SAME ROUTE AS the other readers of `GET /api/settings` (until #271
 * `fetchSettings` in `web/src/api/client.ts`), parsed with the same schema;
 * the lists only need `containers`. A feature imports no other feature, and a
 * second route for one field would be a second truth on the server.
 */
export async function fetchContainerViewSettings(): Promise<ContainerViewSettings> {
  const settings = parseResponse("/api/settings", settingsSchema, await request("/api/settings"));
  return settings.containers;
}

/** Die Sichtbarkeit der Container des Leitstands ablegen (Admin). */
export async function setShowSystemContainers(showSystem: boolean): Promise<{ containers: ContainerViewSettings }> {
  const path = "/api/settings/containers";
  return parseResponse(path, containerViewSettingsResponseSchema, await putJson(path, { containers: { showSystem } }));
}
