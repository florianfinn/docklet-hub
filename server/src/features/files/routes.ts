import type { Request, Router } from "express";
import type { Pool } from "pg";

import { readShare, removeShare, setShare } from "../../domain/containers/index.js";
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
import { withSession } from "../../platform/auth/session.js";
import { respondWithFailure } from "../../platform/http/route-failure.js";
import { relayAgentBytes } from "../../platform/streams/agent-bytes-relay.js";
import { baseName, fileDisposition } from "./download-headers.js";
import { isJsonBody, readBytes } from "./request-body.js";
import { createFilesService, type ContainerRef } from "./service.js";

// The HTTP side of the feature `files` (#262): which directory of a container
// is shared (four routes) and the work inside it (six). Only HTTP lives here —
// read parameters, set the status, write the answer; `service.ts` decides what
// a request comes to and which refusal it is.
//
// The ten routes moved here from `api/routes/share-routes.ts` and
// `api/routes/file-routes.ts` and keep their order: first the choice of the
// share, then the access to its files. The two groups answer two questions.
// The choice is about which directory may be visible at all, an operator
// decision; the access is about the work inside it.
//
// Der folgende Abschnitt stand bis #262 über den Routen der Dateien und der
// Freigaben und ist unverändert mitgezogen.
//
// ⚠️ ALLE ZEHN TRAGEN `requireAdmin` ALS ERSTE ZWISCHENSCHICHT, auch die
// lesenden. docs/design/phase-5-write-access.md §4, Tabelle „Fähigkeit /
// Rolle": „Dateien lesen und schreiben | Admin | Schreibend ohnehin; lesend,
// weil eine Freigabe eine Betreiberentscheidung ist." Anders als beim
// Log-Strom gibt es hier keine Ausnahme und keinen Eintrag in
// `SESSION_ONLY_WRITE` oder `SESSION_ONLY_GET_WITH_EFFECT`.
//
// ⚠️ DIE LESENDEN STEHEN TROTZDEM IN `GET_ROUTES_WITH_EFFECT`
// (`platform/http/request-origin.ts`), und das ist kein Widerspruch: jene Liste
// beantwortet die Frage der HERKUNFTSPRÜFUNG und nicht die der Rolle. Der Agent
// schreibt für jede von ihnen einen Audit-Eintrag mit `outcome: "allowed"`
// unter dem Wert aus `x-docker-agent-actor` — eine Spur unter fremdem Namen ist
// Wirkung, auch wenn sich nichts ändert. Das gilt für `share-candidates` und
// `share` ebenso: beide fragen den Arm nach seiner Container-Liste.
//
// ⚠️ `share-candidates` names the container's bind mounts, i.e. the host's
// layout. Same role and chain as the other file routes, but it is not the
// more harmless one.
//
// ⚠️ DER DOWNLOAD IST EINE DURCHREICHUNG, KEIN SAMMELN. Der Agent deckelt
// diese Richtung nicht; wer den Strom vollständig liest und dann ausliefert,
// hält die ganze Datei im Speicher des Hubs. `relayAgentBytes` schreibt jeden
// Block, sobald er da ist, und wartet auf den Gegendruck.
//
// ⚠️ DER UPLOAD SAMMELT, UND ZWAR NOTGEDRUNGEN. `uploadFile` nimmt ein
// `Uint8Array`, weil der Agent den Rumpf als tar-Paket erwartet und dessen
// Kopf die Länge vorne braucht. Der Rumpf reist als BYTES weiter und nicht als
// Text oder Base64 — was hier eine Umkodierung wäre, käme beim Agenten als
// kaputte Datei an.

export type FileRouteOptions = {
  auth: Auth;
  pool: Pool;
  repository: HostRepository;
  agentSecret: string;
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
};

export function registerFileRoutes(
  router: Router,
  { auth, pool, repository, agentSecret, probeHost }: FileRouteOptions
): void {
  const hosts = createHostAccess({ repository, pool, agentSecret });
  const probe = resolveProbeHost({ probeHost });
  const service = createFilesService({
    openContainer: (request, writing) => openContainerAccess({ hosts, probe }, request, writing),
    shares: {
      read: (hostId, containerName) => readShare(pool, hostId, containerName),
      set: (hostId, containerName, path) => setShare(pool, hostId, containerName, path),
      remove: (hostId, containerName) => removeShare(pool, hostId, containerName)
    }
  });

  // The container of the path and the person of the session — never the other
  // way round.
  const containerRef = (request: Request, userId: string): ContainerRef => ({
    hostId: String(request.params.hostId),
    containerId: String(request.params.containerId),
    userId
  });

  // ── Die Wahl der Freigabe ─────────────────────────────────────────────────

  // Welche Bind-Mounts dieses Containers als Freigabe taugen.
  router.get(
    "/hosts/:hostId/containers/:containerId/share-candidates",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.listCandidates(containerRef(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ candidates: result.candidates });
    })
  );

  // Welche Freigabe für diesen Container GEWÄHLT ist — oder keine. `null` ist
  // eine Antwort und kein Fehler; der Arm muss dennoch erreichbar sein (der
  // Grund steht in `service.ts` bei `readShare`).
  router.get(
    "/hosts/:hostId/containers/:containerId/share",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.readShare(containerRef(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ share: result.share });
    })
  );

  // Die Wahl des Betreibers speichern; gegen die Kandidatenliste geprüft.
  router.put(
    "/hosts/:hostId/containers/:containerId/share",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.chooseShare(containerRef(request, user.id), request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ share: result.share });
    })
  );

  // Die Wahl zurücknehmen. Idempotent — kein Fehler, wenn keine bestand.
  router.delete(
    "/hosts/:hostId/containers/:containerId/share",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.removeShare(containerRef(request, user.id));
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.status(204).end();
    })
  );

  // ── Der Zugriff auf die Dateien ───────────────────────────────────────────

  // Ein Verzeichnis der Freigabe auflisten. `path` leer heißt ihre Wurzel.
  router.get(
    "/hosts/:hostId/containers/:containerId/files",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.list(containerRef(request, user.id), { path: request.query.path });
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      // `truncated` und `diagnostics` gehen MIT hinaus. Eine Liste, die bei
      // `MAX_ENTRIES` endet, sieht sonst vollständig aus, und eine Fläche ohne
      // die Diagnose verspricht ein Löschen, das am Recht scheitert.
      response.json({ listing: result.listing, maxUploadBytes: result.maxUploadBytes });
    })
  );

  // Eine Datei herunterladen — durchgereicht, nicht gesammelt.
  router.get(
    "/hosts/:hostId/containers/:containerId/file",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const plan = await service.planDownload(containerRef(request, user.id), { path: request.query.path });
      if (!plan.ok) {
        respondWithFailure(response, plan.failure);
        return;
      }
      // The life of the transfer hangs on the browser's connection: without it
      // the hub keeps loading the whole file when the tab is long closed. How
      // large it gets is not known beforehand — the agent does not cap this
      // direction.
      await relayAgentBytes(
        response,
        {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
            "content-disposition": fileDisposition(baseName(plan.path))
          }
        },
        (signal) => plan.start(signal)
      );
    })
  );

  // Eine Textdatei zum Bearbeiten holen. Der `hash` geht beim Speichern zurück.
  router.get(
    "/hosts/:hostId/containers/:containerId/file-text",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.readText(containerRef(request, user.id), { path: request.query.path });
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ text: result.text });
    })
  );

  // Eine Datei hochladen. `path` ist das ZIELVERZEICHNIS, `name` der Dateiname.
  router.put(
    "/hosts/:hostId/containers/:containerId/file",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const plan = await service.planUpload(containerRef(request, user.id), {
        path: request.query.path,
        name: request.query.name,
        jsonBody: isJsonBody(request)
      });
      if (!plan.ok) {
        respondWithFailure(response, plan.failure);
        return;
      }
      const content = await readBytes(request, plan.maxBytes);
      if (content === null) {
        respondWithFailure(response, plan.tooLarge);
        return;
      }
      const result = await plan.send(content);
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ uploaded: result.uploaded });
    })
  );

  // Eine Textdatei speichern — mit dem Hash, unter dem sie geladen wurde.
  router.put(
    "/hosts/:hostId/containers/:containerId/file-text",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const plan = await service.planTextSave(containerRef(request, user.id), {
        path: request.query.path,
        expectedHash: request.query.expectedHash,
        jsonBody: isJsonBody(request)
      });
      if (!plan.ok) {
        respondWithFailure(response, plan.failure);
        return;
      }
      const content = await readBytes(request, plan.maxBytes);
      if (content === null) {
        respondWithFailure(response, plan.tooLarge);
        return;
      }
      const result = await plan.send(content);
      if ("conflict" in result) {
        // ⚠️ DER HASH IST DIE EIGENTLICHE AUSKUNFT DIESES `409` und wird nicht
        // weggeworfen. Er sagt, was JETZT in der Datei steht; ohne ihn könnte
        // der Editor dem Betreiber nur „ging nicht" sagen und ihn seine
        // Änderung neu tippen lassen. Der Grund des Agenten reist als `reason`
        // mit, wie bei jeder anderen Ablehnung (`translateAgentError`); die
        // Kennung ist die englische des Hubs.
        response.status(409).json({
          error: "file-changed",
          message:
            "Die Datei hat sich seit dem Laden geändert. Der beigelegte Hash ist ihr jetziger Stand — " +
            `der Agent nennt den Grund „${result.conflict.reason}".`,
          reason: result.conflict.reason,
          hash: result.conflict.hash
        });
        return;
      }
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ hash: result.hash });
    })
  );

  // Anlegen, umbenennen, entfernen — die eine Route dieser Fläche, die eine
  // ANWEISUNG trägt statt eines Inhalts, und deshalb `POST` und nicht `PUT`.
  router.post(
    "/hosts/:hostId/containers/:containerId/files",
    requireAdmin(auth),
    withSession(auth, async (request, response, user) => {
      const result = await service.applyAction(containerRef(request, user.id), request.body);
      if (!result.ok) {
        respondWithFailure(response, result.failure);
        return;
      }
      response.json({ done: result.done });
    })
  );
}
