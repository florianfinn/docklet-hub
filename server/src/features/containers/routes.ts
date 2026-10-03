import type { Router } from "express";
import type { Pool } from "pg";

import {
  createHostAccess,
  resolveProbeHost,
  type AgentHealth,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import type { HostDecoration } from "./decoration.js";
import { createContainersService } from "./service.js";
import { writeContainerViewSettings } from "./view-store.js";

// The HTTP side of the feature `containers` (#282): the overview after the
// sign-in (`GET /overview`) and the write of the container view
// (`PUT /settings/containers`). Only HTTP lives here (read parameters, set the
// status, write the answer); `service.ts` decides the rest.
//
// The two routes moved here from `api/routes/overview-routes.ts` and
// `api/routes/container-view-routes.ts`. `GET /settings` still reads the
// container view, through the door of this feature: it is the one answer of
// the settings feature (`features/settings/`), which `server/src/app/features.ts`
// hands the reader.

export type ContainersRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
  /** The marks and the display of one arm, handed in by `server/src/app/features.ts`. */
  decorationFor: (record: HostRecord) => Promise<HostDecoration>;
};

export function registerContainersRoutes(
  router: Router,
  { auth, pool, repository, agentSecret, probeHost, decorationFor }: ContainersRouteOptions
): void {
  // ⚠️ Resolved ONCE when the routes are registered and not per request: the
  // fall back to the own probe is a property of this router and not one that
  // changes between two requests.
  const service = createContainersService({
    hosts: createHostAccess({ repository, pool, agentSecret }),
    probe: resolveProbeHost({ probeHost }),
    decorationFor,
    writeViewSettings: (settings) => writeContainerViewSettings(pool, settings)
  });

  // Die Fläche nach der Anmeldung (D0 §5). Die Zusammenfassung eines Stacks —
  // schlechtester Container bestimmt die Farbe, daneben die Zahl der
  // laufenden — entsteht in `domain/containers/stacks.ts` und nicht im
  // Browser: §5 nennt sie ausdrücklich Logik und keine Gestaltung.
  //
  // ⚠️ Das Geheimnis kommt JE ARM aus seiner Zeile (`connect`,
  // domain/hosts) und nur für `kind = "local"` aus der Umgebung —
  // dieselbe Entscheidung wie in `GET /hosts/:hostId/containers`
  // (features/hosts/routes.ts, #77). Ein angebundener Arm ohne hinterlegtes
  // Secret liefert von dort einen `AgentError`; er steht in SEINER Zeile als
  // Meldung, und die Übersicht bleibt stehen, statt an einem Arm ganz
  // auszufallen.
  router.get(
    "/overview",
    withSession(auth, async (_request, response, user) => {
      response.json({ hosts: await service.overview({ userId: user.id }) });
    })
  );

  // Ob Übersicht und Container-Fläche die Container des Leitstands selbst
  // zeigen. `requireAdmin` wie die übrigen Einstellungen des Hubs (#17).
  //
  // Rumpf `{ containers: { showSystem } }` — unter demselben Umschlag wie
  // Thema, Netz und Logs.
  router.put(
    "/settings/containers",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const envelope = (request.body as { containers?: unknown } | null)?.containers;
      if (typeof envelope !== "object" || envelope === null) {
        failWith(response, 400, "invalid-input", "Erwartet wird ein Rumpf { containers: { showSystem } }.");
        return;
      }
      const result = await service.updateViewSettings((envelope as { showSystem?: unknown }).showSystem);
      if (!result.ok) {
        failWith(response, 400, "invalid-input", "„showSystem“ ist true oder false — als Wahrheitswert, nicht als Text.");
        return;
      }
      response.json({ containers: result.settings });
    })
  );
}
