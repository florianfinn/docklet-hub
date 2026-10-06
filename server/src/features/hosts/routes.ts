import type { Router } from "express";
import type { Pool } from "pg";

import {
  createHostAccess,
  markHostSeen,
  resolveProbeHost,
  toHostView,
  type AgentHealth,
  type HostInfo,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { translateAgentError } from "../../platform/http/agent-error-translation.js";
import { failWith, guarded } from "../../platform/http/route-responses.js";
import type { Enrollment } from "./enrollment.js";
import { contentDisposition, handleHostError } from "./host-errors.js";
import { createHostsService, type HostLoadOf } from "./service.js";

// The HTTP side of the feature `hosts` (#266): the seven routes, and nothing
// else. They read parameters, set the status and write the answer; what a
// request comes to is `service.ts`, creating an arm, its archive and removing
// it are `enrollment.ts`. Moved here from `api/routes/host-routes.ts`; the
// German comments below are unchanged from there where the move did not touch
// them.
//
// Der Bestand der Arme: sie auflisten, ihre Container lesen, einen Arm
// anlegen, sein Archiv holen, ihn entfernen (§4) — und seit #7 das Update
// seines Agenten über den Watcher anstoßen und dessen Stand lesen.
//
// Diese Datei entsteht mit der Aufteilung von `server/src/app/router.ts`
// (Etappe B4a-A2, #5). Der Schnitt folgt der FACHLICHKEIT dessen, was eine
// Route ändert, und nicht ihrem Pfad-Präfix: `PUT /hosts/:hostId/display`
// beginnt zwar mit `/hosts`, schreibt aber die DARSTELLUNG eines Arms und
// keinen Datensatz des Bestands — sie steht deshalb in `features/appearance/routes.ts`
// und nicht hier. Ebenso `GET /overview`: sie liest zwar den Bestand mit,
// gehört aber der Übersichtsfläche und steht in `features/containers/routes.ts`.
//
// ⚠️ Fünf der sieben Routen hier tragen `requireAdmin` als ERSTE
// Zwischenschicht: `POST /hosts`, beide Routen unter
// `/hosts/:hostId/agent-update`, `GET /hosts/:hostId/archive` (ein GET, das
// trotzdem den ZUSTAND ändert — er rotiert bei jedem Aufruf Schlüssel,
// Secret und Token, §4, und steht deshalb in `GET_ROUTES_WITH_EFFECT`,
// `server/src/platform/http/request-origin.ts`) und `DELETE /hosts/:hostId`. Die zwei
// lesenden Routen (`GET /hosts`, `GET /hosts/:hostId/containers`) stehen
// hinter `withSession`: nach #17 schreibt ein Administrator, lesen alle.
//
// ⚠️ Jene Liste steht im SERVER und nicht mehr im Wächter. Bis Etappe B1 (#5)
// hieß sie `ADMIN_ONLY_GET` und war eine Konstante in
// `web/tests/api-read-only.test.mjs`; dieser Absatz nannte sie seither unter
// dem alten Namen am alten Ort. Der Wächter IMPORTIERT sie heute von dort, und
// die Herkunftsprüfung liest dieselbe Liste (`hasEffect`) — sie zweimal zu
// pflegen war die Bauart, aus der Befund S1 des Agenten entstand
// (docs/design/phase-5-write-access.md §1).

export type HostRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  enrollment: Enrollment;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
  readHostInfo?: (hostId: string) => HostInfo | null;
  /** The load by containers (#214). `features.ts` hands it in; why there, it says. */
  hostLoad: HostLoadOf;
  liveEvents?: { removeHost: (hostId: string) => void };
};

export function registerHostRoutes(
  router: Router,
  { auth, pool, repository, enrollment, agentSecret, probeHost, readHostInfo = () => null, hostLoad, liveEvents }: HostRouteOptions
): void {
  // Resolved once at registration; see `resolveProbeHost` in
  // `domain/hosts/health.ts`.
  const probe = resolveProbeHost({ probeHost });
  const service = createHostsService({
    hosts: createHostAccess({ repository, pool, agentSecret }),
    probe,
    markSeen: (hostId) => markHostSeen(pool, hostId),
    readHostInfo,
    hostLoad
  });

  router.get(
    "/hosts",
    withSession(auth, async (_request, response) => {
      response.json({ hosts: await service.listHosts() });
    })
  );

  router.get(
    "/hosts/:hostId/containers",
    withSession(auth, async (request, response, user) => {
      const result = await service.readHostContainers(String(request.params.hostId), user.id);
      if (result.kind === "host-unknown") {
        response.status(404).json({ error: "host-unknown" });
        return;
      }
      const { kind: _kind, ...answer } = result;
      response.json(answer);
    })
  );

  // Einen Arm anlegen: Datensatz, Peer-Liste, Archiv (§4).
  //
  // Die Antwort trägt KEIN Geheimnis — weder Token noch Agent-Secret noch den
  // privaten Schlüssel. Die kommen im Archiv und nur dort.
  router.post(
    "/hosts",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const parsed = service.parseNewHost(request.body);
      if (parsed.kind === "invalid-input") {
        failWith(response, 400, parsed.error, parsed.message);
        return;
      }
      try {
        const { record } = await enrollment.enrollHost(parsed.input);
        // Ein frisch angelegter Arm ist `pending`: sein Agent existiert noch
        // nicht, und befragt wird er deshalb nicht.
        response.status(201).json({ host: toHostView(record, null) });
      } catch (error) {
        if (!handleHostError(error, response)) throw error;
      }
    })
  );

  // Das Archiv — und mit jedem Aufruf ein neues.
  //
  // ⚠️ Der Aufruf ROTIERT (§4): Schlüsselpaar, Agent-Secret und Token werden
  // neu erzeugt, der Datensatz geht auf `pending` zurück, der Fehlzähler auf
  // null. Der Grund ist die Bauart der Speicherung — der private Schlüssel
  // liegt nur im Archiv, der Hub hat ihn nicht und kann dasselbe Paket kein
  // zweites Mal ausliefern. „Noch einmal herunterladen“ gibt es damit nicht;
  // es gibt nur ein neues. Das ist zugleich der einzige Weg zurück aus der
  // Sperre nach zwölf Fehlversuchen.
  router.get(
    "/hosts/:hostId/archive",
    requireAdmin(auth),
    guarded(async (request, response) => {
      try {
        const { record, archive } = await enrollment.regenerateArchive(String(request.params.hostId));
        response.status(200);
        response.setHeader("content-type", "application/gzip");
        response.setHeader("content-disposition", contentDisposition(record.name));
        // ⚠️ In diesem Strom stehen drei Geheimnisse. Er gehört in keinen
        // Zwischenspeicher — weder im Browser noch in einem Proxy dazwischen.
        response.setHeader("cache-control", "no-store");
        response.end(archive);
      } catch (error) {
        if (!handleHostError(error, response)) throw error;
      }
    })
  );

  // Einen Arm entfernen. Idempotent: 204 beim ersten Mal, 404 danach.
  //
  // Die Peer-Liste des Sidecars wird danach neu geschrieben (SECURITY.md,
  // Grundsatz 5). Der Agent auf dem entfernten Host läuft weiter und erreicht
  // niemanden mehr.
  router.delete(
    "/hosts/:hostId",
    requireAdmin(auth),
    guarded(async (request, response) => {
      try {
        await enrollment.removeHost(String(request.params.hostId));
        liveEvents?.removeHost(String(request.params.hostId));
        response.status(204).end();
      } catch (error) {
        if (!handleHostError(error, response)) throw error;
      }
    })
  );

  // The agent update of an arm through its watcher; why the target comes from
  // the hub, `service.ts` says at `startAgentUpdate`.
  router.post(
    "/hosts/:hostId/agent-update",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.startAgentUpdate(String(request.params.hostId), user.id);
      switch (result.kind) {
        case "host-unknown":
          response.status(404).json({ error: "host-unknown" });
          return;
        case "host-is-local":
          failWith(
            response,
            409,
            "host-is-local",
            "Der lokale Agent steht im Compose-Stack des Hubs und zieht mit dessen Pin nach, nicht über einen Watcher."
          );
          return;
        case "agent-update-unavailable":
          response.status(409).json({
            error: "agent-update-unavailable",
            state: result.state,
            message: "Für diesen Arm steht kein Update über den Watcher an."
          });
          return;
        case "agent-error":
          translateAgentError(result.error, response);
          return;
        case "accepted":
          // 202 like the agent: accepted, not done.
          response.status(202).json({ jobId: result.jobId, targetVersion: result.targetVersion });
          return;
      }
    })
  );

  // The state of the job; while the arm swaps, it is `502 agent-unreachable`
  // (`service.ts`, `readAgentUpdate`).
  router.get(
    "/hosts/:hostId/agent-update",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.readAgentUpdate(String(request.params.hostId), user.id);
      switch (result.kind) {
        case "host-unknown":
          response.status(404).json({ error: "host-unknown" });
          return;
        case "agent-error":
          translateAgentError(result.error, response);
          return;
        case "ok":
          response.json({ running: result.running, version: result.version, last: result.last });
          return;
      }
    })
  );
}
