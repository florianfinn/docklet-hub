import type { Response, Router } from "express";
import type { Pool } from "pg";

import {
  createHostAccess,
  openContainerAccess,
  resolveProbeHost,
  type AgentHealth,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import type { Auth } from "../../platform/auth/auth.js";
import { requireAdmin } from "../../platform/auth/require-admin.js";
import { resolveSession, withSession } from "../../platform/auth/session.js";
import { respondWithFailure } from "../../platform/http/route-failure.js";
import { failWith } from "../../platform/http/route-responses.js";
import { relayAgentStream } from "../../platform/streams/agent-stream-relay.js";
import { HUB_STREAM_BROKEN } from "contract";
import { intervalSchedule, type Scheduler } from "./permission-watch.js";
import { describeSessionRejection, describeStartRejection, type Rejection } from "./rejections.js";
import { ExecSessionRegister } from "./session-register.js";
import { createShellService, type SessionCall } from "./service.js";

// The HTTP side of the feature `shell` (#260): the four routes, and nothing
// else. They read parameters, set the status and write the answer; the life of
// a session, its limits and its permission check are `service.ts`, the tables of
// the agent's refusals `rejections.ts`. Moved here from
// `api/routes/exec-routes.ts` (904 lines); the comment below is unchanged from
// there where the move did not touch it, and still German.
//
// Die SHELL-Fläche des Hubs (Paket B6, Etappe E3, #5) — die Routen, die der
// BROWSER ruft. Der Agent hat seine eigenen vier; die ruft der Client aus
// `agent-client.ts` (Etappe E2), und diese Datei baut keinen zweiten.
//
// ── DIE VIER PFADE UND WARUM SIE ALLE VIER SEGMENTE TRAGEN ──────────────────
//
//   POST /hosts/:hostId/containers/:containerId/exec                (Strom)
//   POST /hosts/:hostId/containers/:containerId/exec/:session/input
//   POST /hosts/:hostId/containers/:containerId/exec/:session/size
//   POST /hosts/:hostId/containers/:containerId/exec/:session/close
//
// ⚠️ DIE DREI KURZEN TRAGEN `hostId` UND `containerId` MIT, OBWOHL DIE SITZUNG
// SIE KENNT. `ExecSessionRegister.check(id, expected)` vergleicht die
// erwarteten Werte gegen den Eintrag; nähme man sie aus dem Eintrag selbst,
// verglich man ihn mit sich, und der Vergleich wäre grün und leer. Der Arm im
// Abgleich ist der Grund, aus dem E2 ihn eingebaut hat: ohne ihn tippt eine
// Shell auf Arm A in einen Container auf Arm B. Die beiden Werte kommen aus dem
// PFAD, `userId` kommt aus der SITZUNG — nie umgekehrt.
//
// ⚠️ `:session` IST DIE SITZUNGS-ID DES HUBS, NIE DIE DES AGENTEN. Die des
// Agenten verlässt den Server nie (`session-register.ts`, `clientViewOf`). Was
// diese Datei hinausgibt, baut ausschließlich `clientViewOf` — ein direkter
// Griff auf `session.agentSession` wäre hier möglich und von keinem Wächter
// gemeldet, und genau deshalb steht er nicht da.
//
// ── DER UMSCHLAG ZUM BROWSER IST DER DES HUBS ───────────────────────────────
//
//   `start`   `session` (Hub-Id), `containerName` — aus `clientViewOf`
//   `output`     `text`
//   `end`    `exitCode: number | null`
//   `error`  `reason`
//
// ⚠️ DER AGENT KENNT KEINE `error`-ZEILE — DER HUB SCHON, UND DAS IST RICHTIG.
// Der Exec-Strom des Agenten hat vier Ausgänge, zwei davon ohne letzte Zeile
// (`.remember/orchestration-b6/exec-protokoll.md` §2). Der Hub weiß dazu
// Dinge, die der Agent nicht weiß: dass ein Recht entzogen wurde, dass sein
// eigener Abbruch zugeschlagen hat. Das ist KEIN Widerspruch zu der
// Entscheidung in `agent-client.ts`, im Client keinen `onFailure`-Rückruf zu
// bauen: dort ging es um eine Zusage über die GEGENSEITE, hier um den eigenen
// Strom des Hubs.
//
// ── DIE FEHLERKENNUNGEN DES HUBS SIND ENGLISCH ──────────────────────────────
//
// So steht es im Bestand (`features/logs/routes.ts`, `domain/hosts/container-access.ts`)
// und ist begründet: eine durchgereichte fremde Kennung machte den Agenten zum
// Teil des Hub-Vertrags. Die Tabelle `AGENT_START_REJECTIONS` in
// `rejections.ts` übersetzt die Schlüssel des Agenten — auch dort, wo beide
// seit #278 dasselbe englische Wort tragen (`too-many-sessions`).
//
// ⚠️ THE SAME HOLDS FOR THE REASONS IN THE `error` LINE, and until #173 it
// did not: the stream carried `recht-entzogen` and `abgebrochen`, both made
// up by the hub, and `abgebrochen` was also the word the agent used up to
// v0.23.0 for the caller's abort. The three reasons now live in
// `contract/src/stream/hub-stream-reasons.ts`, together with the one of the log
// stream.

/** What this route group needs. */
export type ShellRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
  /**
   * The beat of the repeated permission check — injectable.
   *
   * ⚠️ WHY THIS SEAM EXISTS, and it is no mere convenience: the check runs
   * every 60 seconds. A test that had to wait for it on a running server would
   * take a minute per case, and a test nobody runs is none. Without the seam
   * the only way is to move the global clock of the process (`mock.timers`),
   * in the middle of a run with two real HTTP connections whose libraries hold
   * timers themselves. This one option steers exactly what matters.
   *
   * Absent, `intervalSchedule` applies: a real `setInterval`, with `unref()`
   * and its clearing in the service's `finally`.
   */
  schedule?: Scheduler;
};

function writeRejection(response: Response, rejection: Rejection): void {
  failWith(response, rejection.status, rejection.error, rejection.message);
}

export function registerShellRoutes(router: Router, options: ShellRouteOptions): void {
  const { auth, pool, repository, agentSecret, probeHost } = options;
  const hosts = createHostAccess({ repository, pool, agentSecret });
  const probe = resolveProbeHost({ probeHost });

  // ⚠️ THE SESSION REGISTER IS STATE IN MEMORY AND HAS TO BE ONE INSTANCE PER
  // ROUTER: the stream enters its session there, and the three short routes
  // look it up. It is created here, where the feature is registered, once per
  // `createApiRouter` (`features.ts` lists the feature once), so it lives
  // exactly as long as the router. Creating it per request, or in a place that
  // runs twice, gives two registers that never find each other's sessions, and
  // no test of a single route sees the difference.
  const service = createShellService({
    openContainer: (request) => openContainerAccess({ hosts, probe }, request, "writes"),
    hosts,
    register: new ExecSessionRegister(),
    schedule: options.schedule ?? intervalSchedule
  });

  // The calls on an open session carry the ids of the PATH; `userId` comes from
  // the session of the browser — never the other way round.
  const sessionCall = (request: { params: Record<string, unknown> }, userId: string): SessionCall => ({
    sessionId: String(request.params.session),
    userId,
    hostId: String(request.params.hostId),
    containerId: String(request.params.containerId)
  });

  // ── Der Strom ─────────────────────────────────────────────────────────────
  router.post(
    "/hosts/:hostId/containers/:containerId/exec",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const plan = await service.planSession({
        hostId: String(request.params.hostId),
        containerId: String(request.params.containerId),
        userId: user.id
      });
      if (!plan.ok) {
        respondWithFailure(response, plan.failure);
        return;
      }

      // ⚠️ THE LIFE OF THE SESSION HANGS ON THE `close` OF THE RESPONSE, and
      // `relayAgentStream` binds exactly that, measured on 2026-09-08 with a
      // throw-away server on Node v22.22.2 and Express 5.2.1: this route is a
      // POST WITH a body, `express.json()` has read it before the handler runs,
      // and `close` on the REQUEST has already fired by then and fires no
      // second time. A listener on the request would never run — the stream
      // would hang until the agent's maximum — and one bound early would tear
      // it down at once. The `close` of the response falls in both cases
      // exactly when the connection ends.
      //
      // Everything after the opening is decided by the service: the pre-open
      // refusals of the agent are a status here (`describeStartRejection`),
      // the end of the stream is a line in it.
      await relayAgentStream(
        request,
        response,
        {
          brokenEvent: { kind: "error", reason: HUB_STREAM_BROKEN },
          translateError: (error, target) => writeRejection(target, describeStartRejection(error))
        },
        (stream) =>
          plan.run({
            size: request.body,
            stream,
            // `resolveSession` and not `user`: the beat asks "is signed in",
            // not "was signed in" (`platform/auth/session.ts`).
            currentUser: async () => {
              const current = await resolveSession(auth, request);
              return current === null ? null : { id: current.id, role: current.role };
            }
          })
      );
    })
  );

  // ── Die Eingabe ───────────────────────────────────────────────────────────
  router.post(
    "/hosts/:hostId/containers/:containerId/exec/:session/input",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.sendInput(sessionCall(request, user.id), request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure, (error, target) =>
          writeRejection(target, describeSessionRejection(error))
        );
        return;
      }
      response.status(200).json({ ok: true });
    })
  );

  // ── Die Fenstergröße ──────────────────────────────────────────────────────
  router.post(
    "/hosts/:hostId/containers/:containerId/exec/:session/size",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.resize(sessionCall(request, user.id), request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure, (error, target) =>
          writeRejection(target, describeSessionRejection(error))
        );
        return;
      }
      response.status(200).json({ ok: true });
    })
  );

  // ── Das Schließen ─────────────────────────────────────────────────────────
  router.post(
    "/hosts/:hostId/containers/:containerId/exec/:session/close",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      // The service answers a refusal only for a session that is not the
      // caller's; everything after that check is an ok, even if the arm is gone.
      const result = await service.close(sessionCall(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.status(200).json({ ok: true });
    })
  );
}
