import { hostListSchema, hubNetworkResponseSchema, settingsSchema, type HubNetworkView } from "contract";

import { parseResponse, putJson, request } from "../../platform/http/transport";
import type { DockerHost } from "./host-types";

// The calls of the domain `hosts`: the list of arms, read by several features
// through `useHosts`, and the network of the hub. Until #271 the list stood in
// `web/src/api/client.ts` and the network in `hub-network.ts`; every module
// that calls the hub is named `api.ts` since then, so the rule against calls in
// `useEffect` can find them (`eslint-rules/no-api-call-in-effect.mjs`).

export type { HubNetworkView };

// Parsed at the transport boundary (#247): a response that misses a field is
// an error here and not an `undefined` three components further down.
export async function fetchHosts(): Promise<{ hosts: DockerHost[] }> {
  return parseResponse("/api/hosts", hostListSchema, await request("/api/hosts"));
}

// The network of the hub as the arms see it (#267): which address a new arm
// is given, and which one the operator stored for external arms. The create
// dialog of the feature `hosts` and the network panel of the settings both
// read and write it, so it sits here and not in either (server side the same
// is `server/src/domain/hosts/hub-network-store.ts`).

/**
 * `GET /api/settings`, parsed with the schema of the whole answer and cut to
 * its `network` part. The same route as the readers of the settings features:
 * one schema for the server's answer, no copy of it.
 */
export async function fetchHubNetwork(): Promise<HubNetworkView> {
  return parseResponse("/api/settings", settingsSchema, await request("/api/settings")).network;
}

/**
 * Die Adresse dieses Hubs von außen ablegen (Admin).
 *
 * Eine leere Zeichenkette nimmt sie wieder heraus — das ist kein Sonderweg,
 * sondern der Zustand „dieser Hub hat keinen externen Arm".
 */
export async function setHubExternalEndpoint(
  externalEndpoint: string | null
): Promise<{ network: { externalEndpoint: string | null } }> {
  const path = "/api/settings/network";
  return parseResponse(path, hubNetworkResponseSchema, await putJson(path, { network: { externalEndpoint } }));
}
