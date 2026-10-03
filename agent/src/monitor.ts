import type { RawInspect } from "./engine.js";

// Watch-only monitor (Docker monitoring D1). The reduced data surface of the
// watch-only class (guardrail W2): ONLY running/since-when/health/status.
//
// Deliberately NOT included and not derivable either: container name, image ref,
// env keys, mounts/ports/networks, hardening findings. This is not a filtered
// ContainerSummary but a separate, smaller shape — a filter eventually forgets a
// newly added field, a separate structure does not
// (docs/docker-ueberwachung.md, W2). The display name comes from the main API's
// DB, never from the container.

export type MonitorStatus = {
  id: string;
  running: boolean;
  startedAt: string | null;
  health: string | null;
  status: string;
};

export function toMonitorStatus(raw: RawInspect): MonitorStatus {
  return {
    id: raw.Id,
    running: raw.State?.Running === true,
    startedAt: raw.State?.StartedAt ?? null,
    health: raw.State?.Health?.Status ?? null,
    status: raw.State?.Status ?? "unknown"
  };
}
