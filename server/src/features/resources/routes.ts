import type { Router } from "express";
import type { Pool } from "pg";

import {
  createHostAccess,
  openHostAccess,
  resolveProbeHost,
  type AgentHealth,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { respondWithFailure } from "../../platform/http/route-failure.js";
import { createResourcesService } from "./service.js";

// The HTTP side of the feature `resources` (#10): one reading route. Admin
// only, like the host discovery: the answer names every image, volume and
// network of a host, also those of containers outside the allowlist.

export type ResourcesRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
};

export function registerResourcesRoutes(router: Router, options: ResourcesRouteOptions): void {
  const { auth, pool, repository, agentSecret, probeHost } = options;
  const hosts = createHostAccess({ repository, pool, agentSecret });
  const probe = resolveProbeHost({ probeHost });
  const service = createResourcesService({
    openHost: (request, writing) => openHostAccess({ hosts, probe }, request, writing)
  });

  router.get(
    "/hosts/:hostId/resources",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.read({ hostId: String(request.params.hostId), userId: user.id });
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.setHeader("cache-control", "no-store");
      response.json({ resources: result.resources });
    })
  );
}
