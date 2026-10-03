import type { Request, Response, Router } from "express";
import type { Pool } from "pg";

import {
  createHostAccess,
  openContainerAccess,
  openHostAccess,
  resolveProbeHost,
  type AgentHealth,
  type HostCycleOutcome,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import type { Actor, AgentError } from "../../platform/agent-transport/protocol.js";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { withSession } from "../../platform/auth/session.js";
import { respondWithFailure } from "../../platform/http/route-failure.js";
import { relayAgentStream } from "../../platform/streams/agent-stream-relay.js";
import { HUB_STREAM_BROKEN } from "contract";
import { describeComposeRejection } from "./reasons.js";
import { createComposeService, type ContainerRef } from "./service.js";
import { createProjectService } from "./project-service.js";

// The HTTP side of the feature `compose` (#264): the four routes, and nothing
// else. They read parameters, set the status and write the answer; the chain to
// the container, the lock against the hub's own stack, the fallbacks for old
// arms and the way applying runs are `service.ts`, the table of the agent's
// keys `reasons.ts`. Moved here from `api/routes/compose-routes.ts` (534
// lines); the comment below is unchanged from there where the move did not
// touch it, and still German.
//
// Die COMPOSE-Fläche eines Stacks (#35) — vier Routen: lesen, die `.env`
// lesen, Vorschau, anwenden.
//
// ⚠️ ALLE TRAGEN `requireAdmin` ALS ERSTE ZWISCHENSCHICHT, auch die
// lesenden. `docs/design/phase-5-write-access.md` §4: „Compose lesen | Admin |
// Beides nennt die Struktur des Hosts." Eine Compose-Datei nennt Pfade,
// Bind-Mounts und Ports eines fremden Rechners; sie zu lesen ist keine
// Auskunft, sondern eine Karte.
//
// ⚠️ DIE VORSCHAU IST EIN POST UND ÄNDERT NICHTS. Sie ist kein GET, weil der
// Entwurf im Rumpf steht und nicht in die Adresse passt — bis zu 256 KB. Für
// die Schreibsperre gegen einen zu alten Agenten zählt sie deshalb als
// `reads`: wer nicht schreiben darf, darf trotzdem sehen, was ein Entwurf
// bewirken würde.
//
// ⚠️ WARUM DIE VORSCHAU AUF DEM SERVER RECHNET UND NICHT IM BROWSER — und
// warum genau das sich jetzt ausgezahlt hat. Hier stand: „Bekommt der Agent
// einen Trockenlauf (`dashboard-docker-agent#85`), wird aus der Rechnung hier
// ein Aufruf dorthin — und die Oberfläche merkt davon nichts." Der Trockenlauf
// ist da (v0.21.0), der Wechsel ist vollzogen, und die Fläche hat sich um
// keine Zeile geändert. Im Browser gerechnet wäre derselbe Wechsel eine
// Änderung an der Fläche gewesen.
//
// ⚠️ DIE EIGENE RECHNUNG IST TROTZDEM NICHT WEG, sondern der Rückfall. Der
// Grund steht in `types.ts` bei `ComposeDryRun.source`: Arme unter
// v0.21.0 kennen die Route nicht und antworten `404`. Ohne Rückfall wäre der
// Compose-Reiter dort kaputt — mit einer `404`, die wie ein Fehler des Hubs
// aussieht. Welche der beiden Rechnungen geantwortet hat, steht in `source`
// und wird nicht verschwiegen.
//
// ⚠️ SEIT #130 STEHT `MIN_AGENT_VERSION` HOCH (seit #279 AUF `0.32.0`), und damit ist der
// Rückfall unerreichbar. Warum er trotzdem bleibt, steht an derselben Stelle
// in `types.ts`.
//
// ⚠️ DIE ANWENDE-ROUTE ANTWORTET MIT EINEM STROM, und `relayAgentStream`
// (#253) bindet ihn an die Antwort: der Browser geht, der Strom zum Arm wird
// gekappt; ein Fehler VOR der ersten Zeile ist ein Status, den die Tabelle in
// `reasons.ts` schreibt. Was nach der ersten Zeile schiefgeht, steht als
// `error`-Zeile im Strom — das entscheidet `service.ts`, nicht diese Datei.

export type ComposeRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
  resyncHost?: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;
};

/** The answer to a refusal of the agent on this surface — one table, `reasons.ts`. */
function writeRejection(error: AgentError, response: Response, selectionSupported?: boolean): void {
  const rejection = describeComposeRejection(error, selectionSupported);
  response.status(rejection.status).json(rejection.body);
}

/**
 * A refused create also says whether the agent removed the project directory
 * again; `false` means a container left data in it.
 */
function writeProjectRejection(error: AgentError, response: Response): void {
  const rejection = describeComposeRejection(error);
  const detail = error.detail;
  const removed =
    typeof detail === "object" && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>).projectDirRemoved
      : undefined;
  response
    .status(rejection.status)
    .json(typeof removed === "boolean" ? { ...rejection.body, projectDirRemoved: removed } : rejection.body);
}

export function registerComposeRoutes(router: Router, options: ComposeRouteOptions): void {
  const { auth, pool, repository, agentSecret, probeHost, resyncHost } = options;
  const hosts = createHostAccess({ repository, pool, agentSecret });
  const probe = resolveProbeHost({ probeHost });
  const service = createComposeService({
    openContainer: (request, writing) => openContainerAccess({ hosts, probe }, request, writing),
    ...(resyncHost === undefined ? {} : { resyncHost })
  });
  const projects = createProjectService({
    openHost: (request, writing) => openHostAccess({ hosts, probe }, request, writing),
    ...(resyncHost === undefined ? {} : { resyncHost })
  });

  // The container of the path and the person of the session — never the other
  // way round.
  const containerRef = (request: Request, userId: string): ContainerRef => ({
    hostId: String(request.params.hostId),
    containerId: String(request.params.containerId),
    userId
  });

  router.get(
    "/hosts/:hostId/containers/:containerId/compose",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.read(containerRef(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure, (error, answer) =>
          writeRejection(error, answer, result.selectionSupported)
        );
        return;
      }
      response.json({ compose: result.compose });
    })
  );

  // The selection by hand (#185): read the candidates, set one, clear it. The
  // locks in front of the agent are `service.ts`; the reading route carries
  // `no-store` like `/compose/env`, because its answer names paths of the host.
  router.get(
    "/hosts/:hostId/containers/:containerId/compose/candidates",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      response.setHeader("Cache-Control", "no-store");
      const result = await service.candidates(containerRef(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeRejection);
        return;
      }
      response.json({ selection: result.selection });
    })
  );

  router.put(
    "/hosts/:hostId/containers/:containerId/compose/selection",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.select(containerRef(request, user.id), request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeRejection);
        return;
      }
      response.json({ selectedFilePath: result.selectedFilePath });
    })
  );

  router.delete(
    "/hosts/:hostId/containers/:containerId/compose/selection",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.clearSelection(containerRef(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeRejection);
        return;
      }
      response.json({ selectedFilePath: null });
    })
  );

  router.get(
    "/hosts/:hostId/containers/:containerId/compose/env",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      response.setHeader("Cache-Control", "no-store");
      const result = await service.readEnv(containerRef(request, user.id), request.query.plaintext === "1");
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeRejection);
        return;
      }
      response.json({ env: result.env });
    })
  );

  router.post(
    "/hosts/:hostId/containers/:containerId/compose/preview",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.preview(containerRef(request, user.id), request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeRejection);
        return;
      }
      response.json({ preview: result.preview });
    })
  );

  router.post(
    "/hosts/:hostId/containers/:containerId/compose",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const plan = await service.planApply(containerRef(request, user.id), request.body);
      if (!plan.ok) {
        respondWithFailure(response, plan.failure, writeRejection);
        return;
      }

      // ⚠️ DIE LEBENSDAUER DES ZUHÖRENS HÄNGT AN DER VERBINDUNG DES BROWSERS —
      // am `close` der ANTWORT und nicht der Anfrage, und `relayAgentStream`
      // bindet genau das. Diese Route ist ein POST mit Rumpf, und
      // `express.json()` hat ihn gelesen, bevor der Handler läuft; der `close`
      // der Anfrage ist beim Eintritt hier schon gefallen und fällt kein zweites
      // Mal (`request.readableEnded === true`, gemessen am 2026-09-08, #112; die
      // Messung steht in `features/shell/service.ts` an derselben Stelle). Der
      // `close` der Antwort fällt genau dann, wenn die Verbindung endet.
      await relayAgentStream(
        request,
        response,
        {
          brokenEvent: { kind: "error", reason: HUB_STREAM_BROKEN },
          translateError: writeRejection
        },
        (stream) => plan.run(stream)
      );
    })
  );

  // A new hub-owned project (#3): dry run and create on a host. The create
  // answers synchronously under `outcome`; a question of the agent is a 200
  // with the list to confirm, like the line of the apply stream.
  router.post(
    "/hosts/:hostId/projects/preview",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      response.setHeader("Cache-Control", "no-store");
      const result = await projects.preview({ hostId: String(request.params.hostId), userId: user.id }, request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeRejection);
        return;
      }
      response.json({ preview: result.preview });
    })
  );

  router.post(
    "/hosts/:hostId/projects",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      // The answer names the project directory of the host.
      response.setHeader("Cache-Control", "no-store");
      const result = await projects.create({ hostId: String(request.params.hostId), userId: user.id }, request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure, writeProjectRejection);
        return;
      }
      response.json({ outcome: result.outcome });
    })
  );
}
