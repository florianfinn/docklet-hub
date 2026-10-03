import type { Router } from "express";
import type { Pool } from "pg";

import { createHostAccess, type HostRepository } from "../../domain/hosts/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { Auth } from "../../platform/auth/auth.js";
// Der Grund des Hubs für einen abgerissenen Rumpf, samt Begründung (#130).
import { translateAgentError } from "../../platform/http/agent-error-translation.js";
import { withSession } from "../../platform/auth/session.js";
import { createMetricsService } from "./service.js";

// The HTTP side of the feature `metrics` (#283): the stats of one container.
// Only HTTP lives here (read parameters, set the status, write the answer);
// `service.ts` decides which host is meant. The route moved here from
// `api/routes/container-routes.ts`, where it stood alone since #254 took the
// container log out; it keeps its place in the feature list.
//
// The load of an arm by its containers (`container-load.ts`) is the other half
// of the feature: `server/src/app/features.ts` hands it to `hosts`.

export type MetricsRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
};

export function registerMetricsRoutes(
  router: Router,
  { auth, pool, repository, agentSecret }: MetricsRouteOptions
): void {
  const service = createMetricsService({ hosts: createHostAccess({ repository, pool, agentSecret }) });

  // Die Messwerte EINES Containers samt Verlauf — für sein Detail (#213).
  //
  // ⚠️ EINE EIGENE ROUTE, weil die Übersicht den Verlauf nicht trägt (Messung
  // in `features/metrics/container-load.ts`). Sie liefert nur die Messwerte und
  // keine zweite Zusammenfassung des Containers: Name, Zustand und Marken
  // kommen weiter aus `GET /overview`.
  //
  // ⚠️ `withSession` und nicht `requireAdmin`: sie liest, wie die Übersicht.
  // In `GET_ROUTES_WITH_EFFECT` steht sie trotzdem — die Einzelansicht des
  // Agenten schreibt bei einer Ablehnung einen Audit-Eintrag unter dem
  // Aufrufer, und das darf keine fremde Seite auslösen.
  router.get(
    "/hosts/:hostId/containers/:containerId/stats",
    withSession(auth, async (request, response, user) => {
      try {
        const result = await service.containerStats({
          hostId: String(request.params.hostId),
          containerId: String(request.params.containerId),
          actorId: user.id
        });
        if (!result.ok) {
          response.status(404).json({ error: result.error });
          return;
        }
        response.json({ stats: result.stats });
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        translateAgentError(error, response);
      }
    })
  );
}
