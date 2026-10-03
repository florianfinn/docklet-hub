import type { ContainerStats } from "contract";

import { fetchContainerStats } from "../../domain/containers/index.js";
import type { HostAccess } from "../../domain/hosts/index.js";

// The service of the feature `metrics` (#283): everything between the HTTP
// route and the agent for the stats of one container. The route reads the
// parameters, sets the status and writes the answer; which host is meant is
// decided here, and the tests decide it without Express (`service.test.ts`).

export type MetricsServiceDeps = {
  hosts: Pick<HostAccess, "find" | "connect">;
};

export type MetricsService = {
  /**
   * The measurements of one container with their history. `host-unknown`
   * before the agent is asked; an `AgentError` of the agent passes through,
   * because the route translates it into a status.
   */
  containerStats: (request: {
    hostId: string;
    containerId: string;
    actorId: string;
  }) => Promise<{ ok: true; stats: ContainerStats | null } | { ok: false; error: "host-unknown" }>;
};

export function createMetricsService({ hosts }: MetricsServiceDeps): MetricsService {
  return {
    containerStats: async ({ hostId, containerId, actorId }) => {
      const host = await hosts.find(hostId);
      if (!host) return { ok: false, error: "host-unknown" };
      const stats = await fetchContainerStats(await hosts.connect(host), containerId, {
        actor: { kind: "user", id: actorId }
      });
      return { ok: true, stats };
    }
  };
}
