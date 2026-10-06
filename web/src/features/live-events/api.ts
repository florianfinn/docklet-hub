import { liveEventSchema, overviewSchema, readNdjson, type LiveEvent, type HostOverview } from "contract";
import { ApiError, parseResponse, request } from "../../platform/http/transport";

export async function fetchLiveHostOverview(hostId: string, signal: AbortSignal): Promise<HostOverview> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/overview`;
  const response = parseResponse(path, overviewSchema, await request(path, { signal }));
  if (response.hosts.length !== 1) throw new Error("host-overview-unavailable");
  return response.hosts[0];
}
export async function readLiveEvents(signal: AbortSignal, onEvent: (event: LiveEvent) => void): Promise<void> {
  const response = await fetch("/api/live-events", { credentials: "include", signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(response.status, "live-events-unavailable");
  }
  if (!response.body) throw new Error("live-events-unavailable");
  await readNdjson(response.body, { signal }, (raw) => {
    const parsed = liveEventSchema.safeParse(raw);
    if (parsed.success) onEvent(parsed.data);
  });
}
