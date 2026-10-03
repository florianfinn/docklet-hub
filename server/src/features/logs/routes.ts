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
import { relayAgentStream } from "../../platform/streams/agent-stream-relay.js";
import { HUB_STREAM_BROKEN } from "contract";
import { createLogsService } from "./service.js";
import { readLogSettings, writeLogSettings } from "./store.js";

// The HTTP side of the feature `logs` (#254): the container log as a running
// stream and the setting of how many lines it opens with. Only HTTP lives
// here (read parameters, set the status, write the answer); `service.ts`
// decides `tail` and the host.
//
// The two routes moved here from `api/routes/container-routes.ts` and
// `api/routes/settings-routes.ts`. `GET /settings` still reads the setting,
// through the door of this feature: it is the one answer of the settings
// feature (`features/settings/`), which `server/src/app/features.ts` hands the
// reader.
//
// Der folgende Abschnitt stand bis #254 über der Route in
// `container-routes.ts` und ist unverändert mitgezogen.
//
// ⚠️ SIE STEHT HINTER `withSession` UND NICHT HINTER `requireAdmin`, und das
// ist kein vergessener Wächter. Logs lesen ist eine Fähigkeit der Rolle User
// (docs/design/phase-5-write-access.md §4, Tabelle „Fähigkeit / Rolle"): sie
// liest, sie ändert nichts, und die Schwärzung des Agenten liegt davor.
//
// ⚠️ SIE STEHT TROTZDEM IN `GET_ROUTES_WITH_EFFECT` (Etappe B4b-K, #5), und
// das ist kein Widerspruch zum Absatz darüber. Jene Liste beantwortet die
// Frage der HERKUNFTSPRÜFUNG („darf eine fremde Seite das auslösen?"), nicht
// die der ROLLE („wer darf das?"). Diese Route ändert nichts und belegt
// trotzdem einen der gleichzeitigen Ströme des Arms und hinterlässt in
// dessen Audit-Log eine Spur unter dem Namen des angemeldeten Menschen —
// beides darf kein Fremder auslösen. `web/tests/api-read-only.test.mjs` führt
// sie deshalb in `SESSION_ONLY_GET_WITH_EFFECT` und prüft für sie
// `withSession` an genau der Stelle, an der die anderen Einträge jener Liste
// `requireAdmin` tragen.
//
// ⚠️ EINE DURCHREICHUNG, KEIN SAMMELN. Der Hub schreibt jede Zeile, sobald sie
// da ist. Wer den Strom erst vollständig liest und dann ein Feld ausliefert,
// hat aus einem laufenden Log eine Batchausgabe gemacht — und das fällt in
// einem Test mit drei Zeilen nicht auf, sondern erst an einem Container, der
// eine Stunde redet.
//
// ⚠️ DER STATUS STEHT FEST, SOBALD DIE ERSTE ZEILE DRAUSSEN IST. Alles, was
// dieser Handler an Fehlern übersetzen kann, übersetzt er DAVOR. Danach kann
// ein Fehler nur noch IM Strom stehen — eine Zeile `{"kind":"error",…}` und
// das Ende der Antwort. Ein `response.status(…)` an dieser Stelle wirft.

export type LogRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
};

export function registerLogRoutes(
  router: Router,
  { auth, pool, repository, agentSecret, probeHost }: LogRouteOptions
): void {
  const service = createLogsService({
    hosts: createHostAccess({ repository, pool, agentSecret }),
    probe: resolveProbeHost({ probeHost }),
    readSettings: () => readLogSettings(pool),
    writeSettings: (settings) => writeLogSettings(pool, settings)
  });

  router.get(
    "/hosts/:hostId/containers/:containerId/logs-stream",
    withSession(auth, async (request, response, user) => {
      const plan = await service.planContainerLog({
        hostId: String(request.params.hostId),
        containerId: String(request.params.containerId),
        tail: request.query.tail
      });
      if (!plan.ok && plan.error === "invalid-tail") {
        // A value the caller sent is the caller's error and not the hub's,
        // hence `400` and not `500`.
        failWith(
          response,
          400,
          "invalid-tail",
          "„tail“ ist eine ganze Zahl von 1 bis 2000. Der Wert „0“ ist beim Agenten ein anderer Strom " +
            "(nur neue Zeilen, keine Vergangenheit) und wird deshalb nie gesendet."
        );
        return;
      }
      if (!plan.ok && plan.error === "agent-outdated") {
        // The same key as the write lock of `container-access.ts`; the log
        // view names the step that ends it (`log-errors.ts`).
        failWith(
          response,
          409,
          "agent-outdated",
          "Der Agent dieses Arms spricht ein älteres Protokoll; sein Protokoll kommt erst nach dem Umstieg auf " +
            "die neue Fassung wieder an."
        );
        return;
      }
      if (!plan.ok) {
        response.status(404).json({ error: "host-unknown" });
        return;
      }

      // ⚠️ Open, data, failure, end and abort in both directions live in
      // `relayAgentStream` (#253): the browser leaving aborts the agent stream
      // and writes no line, the agent breaking after `open` writes
      // `HUB_STREAM_BROKEN`, and a failure before `open` is still a status
      // (`too-many-streams` among them).
      //
      // ⚠️ `open` runs AS SOON AS THE AGENT STREAM STANDS — not with the first
      // line. A container whose log opens slowly would otherwise look like a
      // request without an answer, and the tab would show a loading bar
      // instead of an empty, open log.
      await relayAgentStream(
        request,
        response,
        { brokenEvent: { kind: "error", reason: HUB_STREAM_BROKEN } },
        ({ signal, open, write }) =>
          plan.stream(
            {
              // ⚠️ The signed-in person and NEVER a fixed `system:hub`. The
              // caller is the one trace in the agent's audit log that leads
              // from this hub back to a person; a constant value would make
              // every look at a log an anonymous one.
              actor: { kind: "user", id: user.id },
              signal,
              onOpen: open,
              onStart: (start) => write({ kind: "start", containerName: start.containerName, tty: start.tty }),
              onFailure: (failure) => write({ kind: "error", reason: failure.reason })
            },
            (line) => write({ kind: "line", stream: line.stream, ts: line.ts, text: line.text })
          )
      );
    })
  );

  // How many lines of the past the log view shows on opening (#5, step G).
  //
  // ⚠️ `requireAdmin` like `PUT /settings/network` and `PUT /settings/theme`:
  // a global setting of the hub that an administrator sets and everyone reads
  // (#17).
  //
  // Body `{ logs: { tailLines } }`, under the same envelope as theme and
  // network. No way to "take it out again": unlike the external endpoint, one
  // of the four values is ALWAYS set here, never "none".
  router.put(
    "/settings/logs",
    requireAdmin(auth),
    guarded(async (request, response) => {
      const envelope = (request.body as { logs?: unknown } | null)?.logs;
      if (typeof envelope !== "object" || envelope === null) {
        failWith(response, 400, "invalid-input", "Erwartet wird ein Rumpf { logs: { tailLines } }.");
        return;
      }
      const result = await service.updateSettings((envelope as { tailLines?: unknown }).tailLines);
      if (!result.ok) {
        failWith(
          response,
          400,
          "invalid-input",
          "„tailLines“ ist eine der vier Zahlen 200, 500, 1000 oder 2000 — als Zahl, nicht als Zeichenkette."
        );
        return;
      }
      response.json({ logs: result.settings });
    })
  );
}
