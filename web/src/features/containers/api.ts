// The calls of the feature `containers` to the hub (#282): the overview of all
// arms and the switch that shows hub and agents in the lists. Moved here from
// `web/src/api/client.ts`; a feature imports nothing from `web/src/api/`, so
// the calls moved along.
//
// ⚠️ THE MIRROR GUARD READS THIS FILE: `web/tests/client-files.mjs` collects
// every `api.ts` under `web/src/` next to `platform/http/`, so a
// call here is held against the routes of the server like any other.

import {
  hubContainerRuntimeResultSchema, hubStackRuntimeResultSchema, hubStackActionStreamLineSchema,
  hubRuntimeErrorSchema, readNdjson, type RuntimeAction, type ExpectedContainer, type ExpectedStack,
  type HubContainerRuntimeResult, type HubStackActionStreamLine, type HubRuntimeError,
  containerViewSettingsResponseSchema,
  overviewSchema,
  settingsSchema,
  type ContainerViewSettings,
  type HostOverview
} from "contract";

import { ApiError, errorCode, parseResponse, putJson, request, readErrorDetail } from "../../platform/http/transport";

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



export async function runContainerAction(hostId: string, containerId: string, action: RuntimeAction,
  expectedContainer: ExpectedContainer, signal?: AbortSignal): Promise<HubContainerRuntimeResult> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/${action}`;
  return parseResponse(path, hubContainerRuntimeResultSchema, await request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedContainer }), signal
  }));
}

export async function runStackAction(hostId: string, containerId: string, action: RuntimeAction,
  expectedStack: ExpectedStack, onEvent: (event: HubStackActionStreamLine) => void | Promise<void>,
  signal: AbortSignal): Promise<void> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/stacks/${encodeURIComponent(containerId)}/actions/${action}`;
  const response = await fetch(path, { method: "POST", credentials: "include", signal,
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({ expectedStack }) });
  if (!response.ok) throw new ApiError(response.status, await readErrorDetail(response));
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    await onEvent({ kind: "result", status: response.status,
      body: parseResponse(path, hubStackRuntimeResultSchema, await response.json()) });
    return;
  }
  if (!response.body) throw new ApiError(502, JSON.stringify({ error: "runtime-stream-broken" }));
  let terminal = false;
  await readNdjson(response.body, { signal }, async (raw) => {
    const event = parseResponse(path, hubStackActionStreamLineSchema, raw);
    if (terminal) throw new ApiError(502, JSON.stringify({ error: "runtime-stream-broken" }));
    terminal = event.kind === "result" || event.kind === "error";
    await onEvent(event);
  });
  if (!terminal && !signal.aborted) throw new ApiError(502, JSON.stringify({ error: "runtime-stream-broken" }));
}

export function runtimeActionErrorOf(error: unknown): HubRuntimeError | null {
  const parsed = hubRuntimeErrorSchema.safeParse(errorCode(error));
  return parsed.success ? parsed.data : null;
}
