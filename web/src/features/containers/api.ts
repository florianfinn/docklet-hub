// Container overview, settings and runtime actions, parsed at the hub boundary.

import {
  lifecycleWriteResultSchema, hubRuntimeContextSchema, type SelfHealingMaintenanceTarget, type StopIntentTarget,
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
  signal: AbortSignal, expectedApplyDefinition?: boolean): Promise<void> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/stacks/${encodeURIComponent(containerId)}/actions/${action}`;
  const response = await fetch(path, { method: "POST", credentials: "include", signal,
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({ expectedStack, ...(expectedApplyDefinition === undefined ? {} : { expectedApplyDefinition }) }) });
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

export async function fetchRuntimeContext(hostId: string, containerId: string, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/stacks/${encodeURIComponent(containerId)}/context`;
  return parseResponse(path, hubRuntimeContextSchema, await request(path, { signal }));
}
export async function setMaintenance(hostId: string, target: SelfHealingMaintenanceTarget, durationSeconds: number | null, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/self-healing/maintenance`;
  return parseResponse(path, lifecycleWriteResultSchema, await request(path, { method: "PUT", headers: { "content-type": "application/json" }, signal, body: JSON.stringify({ target, durationSeconds }) }));
}
export async function clearMaintenance(hostId: string, target: SelfHealingMaintenanceTarget, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/self-healing/maintenance`;
  return parseResponse(path, lifecycleWriteResultSchema, await request(path, { method: "DELETE", headers: { "content-type": "application/json" }, signal, body: JSON.stringify({ target }) }));
}
export async function acknowledgeIncident(hostId: string, target: StopIntentTarget, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/self-healing/incidents/acknowledge`;
  return parseResponse(path, lifecycleWriteResultSchema, await request(path, { method: "POST", headers: { "content-type": "application/json" }, signal, body: JSON.stringify({ target }) }));
}
export async function fetchLifecycleHost(hostId: string, signal?: AbortSignal): Promise<HostOverview> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/overview`;
  const result = parseResponse(path, overviewSchema, await request(path, { signal }));
  const host = result.hosts.find((entry) => entry.host.id === hostId);
  if (!host) throw new ApiError(404, JSON.stringify({ error: "host-unknown" }));
  return host;
}

import { agentJobsResponseSchema, updatePreviewResponseSchema, updateStartResponseSchema, updateCancelResponseSchema,
  updateContainerSettingsSchema, type UpdatePreviewRequest, type UpdateStartRequest, type UpdateTarget,
  type UpdateContainerSettings } from "contract";

export async function fetchUpdateJobs(hostId: string, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/jobs?kind=update`;
  return parseResponse(path, agentJobsResponseSchema, await request(path, { signal }));
}
export async function previewUpdate(hostId: string, body: UpdatePreviewRequest) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/update-previews`;
  return parseResponse(path, updatePreviewResponseSchema, await request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
}
export async function startUpdate(hostId: string, body: UpdateStartRequest) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/updates`;
  return parseResponse(path, updateStartResponseSchema, await request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
}
export async function cancelUpdate(hostId: string, id: string) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/jobs/${encodeURIComponent(id)}/cancel`;
  return parseResponse(path, updateCancelResponseSchema, await request(path, { method: "POST" }));
}
export async function fetchUpdateSetting(hostId: string, containerId: string, target: UpdateTarget, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/update-settings?target=${encodeURIComponent(JSON.stringify(target))}`;
  return parseResponse(path, updateContainerSettingsSchema, await request(path, { signal }));
}
export async function saveUpdateSetting(hostId: string, containerId: string, target: UpdateTarget, settings: UpdateContainerSettings) {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/update-settings`;
  return parseResponse(path, updateContainerSettingsSchema, await putJson(path, { target, settings }));
}

import { backupListResponseSchema, restorePreviewResponseSchema, restoreStartResponseSchema,
  fileSourcesResponseSchema, type RestorePreviewRequest, type RestoreStartRequest } from "contract";
export async function fetchBackups(host: string, id: string) {
  const path = `/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(id)}/backups`;
  return parseResponse(path, backupListResponseSchema, await request(path));
}
export async function fetchRestoreSources(host: string, id: string) {
  const path = `/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(id)}/file-sources`;
  return parseResponse(path, fileSourcesResponseSchema, await request(path));
}
export async function previewRestore(host: string, body: RestorePreviewRequest) {
  const path = `/api/hosts/${encodeURIComponent(host)}/restore-previews`;
  return parseResponse(path, restorePreviewResponseSchema, await request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
}
export async function startRestore(host: string, body: RestoreStartRequest) {
  const path = `/api/hosts/${encodeURIComponent(host)}/restores`;
  return parseResponse(path, restoreStartResponseSchema, await request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
}
export async function fetchRestoreJobs(host: string, signal?: AbortSignal) {
  const path = `/api/hosts/${encodeURIComponent(host)}/jobs?kind=restore`;
  return parseResponse(path, agentJobsResponseSchema, await request(path, { signal }));
}
