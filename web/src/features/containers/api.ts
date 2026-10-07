// Container overview, settings and runtime actions, parsed at the hub boundary.

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

export async function fetchOverview(): Promise<{ hosts: HostOverview[] }> {
  return parseResponse("/api/overview", overviewSchema, await request("/api/overview"));
}

export async function fetchContainerViewSettings(): Promise<ContainerViewSettings> {
  const settings = parseResponse("/api/settings", settingsSchema, await request("/api/settings"));
  return settings.containers;
}

/** Saves visibility of the hub containers (admin only). */
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

export function runtimeActionResultOf(error: unknown): HubContainerRuntimeResult | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = hubContainerRuntimeResultSchema.safeParse(JSON.parse(error.message));
    return parsed.success && !parsed.data.ok ? parsed.data : null;
  } catch { return null; }
}
