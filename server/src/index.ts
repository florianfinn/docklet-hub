import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import { toNodeHandler } from "better-auth/node";
import express from "express";

import {
  createHostAccess,
  createObservedProbe,
  createPoolRepository,
  ensureLocalHost,
  probeAgent,
  readHubNetwork,
  staleAfterMs,
  startHostCycleService
} from "./domain/hosts/index.js";
import { startLiveEvents } from "./domain/live-events/index.js";
import { createApiRouter } from "./app/router.js";
import { createRuntimeSettingsSync } from "./app/runtime-settings.js";
import { writeRuntimeSettings } from "./features/settings/index.js";
import { createAuth } from "./platform/auth/auth.js";
import { ConfigError, loadConfig } from "./platform/config/config.js";
import { runMigrations } from "./platform/db/migrate.js";
import { createPool, waitForDatabase } from "./platform/db/pool.js";
import { createEnrollment, createRegistrationApp, createRegistrationDeps } from "./features/hosts/index.js";
import { createContentSecurityPolicyHeader } from "./platform/http/content-security-policy-header.js";
import { createNoStoreHeader, createSecurityHeaders } from "./platform/http/response-headers.js";
import { createIndexFallback } from "./platform/http/index-fallback.js";

// Start des Hubs.
//
// Die Reihenfolge ist der Inhalt dieser Datei: Konfiguration prüfen, auf die
// Datenbank warten, Migrationen anwenden, erst dann lauschen. Ein Hub, der
// bereits antwortet, während sein Schema noch entsteht, beantwortet die ersten
// Anfragen falsch statt gar nicht — und „gar nicht" ist hier die bessere
// Antwort, weil Compose sie am Healthcheck sieht.

// Die gebaute Weboberfläche. Derselbe relative Pfad trägt in der Arbeitskopie
// (server/src → web/dist) wie im Image (server/dist → web/dist); das
// Dockerfile legt sie deshalb genau so ab.
const WEB_ROOT = new URL("../../web/dist/", import.meta.url);

/**
 * Auf welcher Adresse der Anmeldeweg lauscht.
 *
 * ⚠️ `0.0.0.0` und nicht `10.254.0.1`, und das ist eine Entscheidung und keine
 * Nachlässigkeit (docs/design/phase-4-bootstrap-and-registration.md §6):
 *
 *   * Die Tunneladresse des Hubs gibt es erst, wenn `wg-quick up` gelaufen
 *     ist. Das passiert im Sidecar, und der wartet auf die `wg0.conf`, die
 *     dieser Prozess gleich schreibt. Ein Bind auf `10.254.0.1` beim Start
 *     ergäbe deshalb im Regelfall EADDRNOTAVAIL — der Hub stürbe oder liefe
 *     ohne Anmeldeweg weiter, und das zweite fiele erst dem Betreiber auf,
 *     der Stunden später einen Arm anbindet.
 *   * Eine Bindung mit Wiederholung wäre dieselbe Zusage mit einem Zeitfenster
 *     davor: bis der Tunnel steht, gibt es keinen Anmeldeweg, und ob die
 *     Wiederholung je greift, sagt nur ein Logeintrag.
 *
 * Was den Port stattdessen deckt: er wird NICHT veröffentlicht (die
 * docker-compose.yml führt für den Hub kein `ports`, veröffentlicht wird beim
 * Sidecar, und dort steht dieser Port nicht). Erreichbar ist er damit aus dem
 * Tunnel und aus dem Compose-Netz. Und was von dort kommt, trägt die
 * Bedingungsliste aus §1: eine Quelladresse, die keine vergebene
 * Tunneladresse ist, wird mit 403 abgewiesen, bevor irgendein Geheimnis
 * gelesen wird (Bedingungen 3 und 4).
 */
const REGISTRATION_BIND_ADDRESS = "0.0.0.0";

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);

  console.log("Warte auf die Datenbank …");
  await waitForDatabase(pool, {
    onRetry: (attempt, error) => {
      // Nur jeden fünften Versuch melden: sonst besteht das Log eines
      // normalen Starts aus dreißig identischen Zeilen, und die eine Meldung,
      // auf die es ankommt, geht darin unter.
      if (attempt % 5 === 1) {
        console.log(`Datenbank noch nicht bereit (Versuch ${attempt}): ${error.message}`);
      }
    }
  });

  const client = await pool.connect();
  let migrationsApplied: string[];
  try {
    const result = await runMigrations(client);
    migrationsApplied = result.applied;
    if (result.applied.length === 0) {
      console.log(`Schema aktuell (${result.alreadyApplied} Migrationen bereits angewandt).`);
    } else {
      console.log(`Migrationen angewandt: ${result.applied.join(", ")}`);
    }
  } finally {
    client.release();
  }

  // Der lokale Host wird EINGETRAGEN, nicht registriert: seine Adresse steht
  // in der Umgebung. Der Abgleich läuft bei jedem Start, damit die `.env` der
  // eine Ort der Wahrheit bleibt und die Zeile in der Datenbank ihr folgt.
  const localHost = await ensureLocalHost(pool, {
    name: config.localHostName,
    agentUrl: config.agentBaseUrl
  });
  console.log(`Lokaler Host: ${localHost.name} → ${localHost.agentUrl}`);

  // Der Bestand hinter einer Schnittstelle: dieselbe, gegen die der
  // Speicher in `app/enrollment-integration.test.ts` läuft.
  const repository = createPoolRepository(pool, config.tunnel);
  const enrollment = createEnrollment({
    repository,
    config,
    // Bei jeder Archiverzeugung frisch gelesen — siehe die Begründung an
    // `EnrollmentOptions.readExternalEndpoint`.
    readExternalEndpoint: async () => (await readHubNetwork(pool)).externalEndpoint
  });

  // ⚠️ Die Peer-Liste wird bei JEDEM Start geschrieben, auch mit null Armen.
  // Der Sidecar meldet sich ohne `wg0.conf` als „unhealthy“, und ohne diese
  // Zeile wäre das der Normalzustand eines Betriebs ohne Arme (§6). Der
  // Renderer erzeugt für null Arme eine vollständige `[Interface]`-Sektion,
  // genau dafür.
  //
  // Kein Abbruch, wenn es nicht klappt: ein fehlendes Schlüsselpaar oder ein
  // nicht beschreibbares Volume nimmt dem Hub den Tunnel, nicht den lokalen
  // Host — und der Hub teilt sich den Namensraum des Sidecars, ein Absturz
  // hier nähme beide mit. Die Meldung ist laut, und beim Anlegen des ersten
  // Arms kommt derselbe Fehler als Antwort auf die Anfrage zurück.
  try {
    await enrollment.writeHubWireGuardConfig();
    console.log(`Peer-Liste des Tunnels geschrieben: ${config.wireguardConfigPath}`);
  } catch (error) {
    console.error(
      `Die Peer-Liste des Tunnels (${config.wireguardConfigPath}) konnte nicht geschrieben werden. ` +
        "Bis das behoben ist, bleibt der WireGuard-Sidecar ohne Konfiguration und kein Arm erreicht diesen Hub:",
      error instanceof ConfigError ? error.message : error
    );
  }

  // Live connections and their health probes deliver the current configuration.
  const selfHealingSync = createRuntimeSettingsSync({ pool, repository, agentSecret: config.agentSecret });
  const hostCycle = startHostCycleService({
    pool,
    repository,
    agentSecret: config.agentSecret,
    intervalSeconds: config.hostCycleIntervalSeconds,
    onInventoryChanged: async (hostId) => {
      await liveEvents.refresh(hostId, { host: true }, { resync: false }).catch(() => undefined);
    },
    log: (message) => console.log(message),
    logError: (message, error) => console.error(message, error)
  });

  const liveEvents = startLiveEvents({
    hosts: createHostAccess({ pool, repository, agentSecret: config.agentSecret }),
    resync: async (hostId) => {
      const record = await repository.find(hostId);
      if (!record) throw new Error("host-unknown");
      const outcome = await hostCycle.syncHost(record, { kind: "system", name: "hub" });
      if (outcome.status !== "synced" && outcome.status !== "unchanged") throw new Error("host-resync-failed");
    },
    onConnected: async (hostId) => {
      const record = await repository.find(hostId);
      if (record) await selfHealingSync.syncHost(record, true);
    },
    onHostReachable: async (record) => { await selfHealingSync.syncHost(record); },
    onError: (error) => console.error("Live-Ereignisse:", error)
  });
  liveEvents.start();

  const auth = createAuth({
    pool,
    secret: config.authSecret,
    baseUrl: config.authBaseUrl,
    writeSetupRuntime: (runtime) => writeRuntimeSettings(pool, runtime).then(() => undefined)
  });

  const app = express();

  // ⚠️ Die Content-Security-Policy als ERSTE Zwischenschicht, app-weit.
  //
  // Tragen muss sie die Auslieferung des Dokuments (`express.static` und
  // `createIndexFallback` weiter unten) — nur dort gibt es ein Dokument, auf
  // das ein Browser die Direktiven anwendet. Dass sie zusätzlich auf `/api`,
  // dem Anmeldeweg und `/health` liegt, ist Absicht: ein Kopf auf einer
  // JSON-Antwort schadet nicht, `frame-ancestors 'none'` wirkt auch dort, und
  // eine Schicht, die überall liegt, kann beim nächsten neuen
  // Auslieferungsweg nicht vergessen werden. Läge sie nur im
  // `if (existsSync(webRoot))`-Zweig, hinge die ganze Zusage an einem
  // Verzeichnis, das im Entwicklungsbetrieb regelmässig fehlt.
  //
  // Hier und nicht weiter unten, weil ein `setHeader` an der Antwort bleibt:
  // vor `app.all("/api/auth/*splat", …)` gehängt trägt auch dessen Antwort den
  // Kopf. Die Liste selbst steht in `platform/http/content-security-policy.ts`,
  // mitsamt der einen Lockerung aus #28 und ihrem Grund.
  app.use(createContentSecurityPolicyHeader());

  // Die übrigen Sicherheitsköpfe app-weit und `no-store` für `/api` — beide
  // VOR dem Anmeldeweg, damit auch dessen Antworten sie tragen (#133). Werte
  // und Gründe in `platform/http/response-headers.ts`.
  app.use(createSecurityHeaders());
  app.use("/api", createNoStoreHeader());

  // ⚠️ Der Anmelde-Handler steht VOR express.json(). better-auth liest den
  // Rumpf selbst; ein Parser davor hätte ihn bereits verbraucht, und die
  // Anmeldung liefe in eine Zeitüberschreitung statt in eine Fehlermeldung.
  // Das ist der am häufigsten gemeldete Fehler bei dieser Einbindung, und er
  // sieht nach einem Netzproblem aus.
  app.all("/api/auth/*splat", toNodeHandler(auth));

  // ⚠️ DIE COMPOSE-FLÄCHE BRAUCHT MEHR ALS 64 kB, UND ZWAR NUR SIE. Ihr Rumpf
  // trägt eine ganze Datei: der Agent lässt für `content` 256 KB zu
  // (`MAX_COMPOSE_BYTES`), und in JSON kommt die Maskierung obendrauf. Der
  // Deckel darunter griffe also mitten in einer erlaubten Datei — mit einem
  // `413`, das nach einem Fehler des Betreibers aussieht.
  //
  // Der Parser steht deshalb VOR dem allgemeinen und nur auf diesem Pfad: wer
  // zuerst liest, setzt `req.body`, und der zweite lässt eine bereits gelesene
  // Anfrage unberührt. Die Alternative — die allgemeine Grenze anheben — träfe
  // jede Route des Hubs, und die 64 kB stehen dort aus gutem Grund.
  app.use("/api/hosts/:hostId/containers/:containerId/compose", express.json({ limit: "512kb" }));

  app.use(express.json({ limit: "64kb" }));

  app.use(
    "/api",
    createApiRouter({
      selfHealingSync,
      auth,
      pool,
      repository,
      enrollment,
      liveEvents,
      agentSecret: config.agentSecret,
      config,
      // Fresh observations avoid probing every host on each API request.
      probeHost: createObservedProbe({
        store: hostCycle.observations,
        staleAfterMs: staleAfterMs(hostCycle.intervalMs),
        now: () => Date.now(),
        probe: (record) => probeAgent(record.agentUrl, { timeoutMs: 3_000 })
      }),
      // ⚠️ Ohne diese Zeile trägt ein Arm nach einem angewandten
      // Compose-Entwurf bis zum nächsten Takt die alte Allowlist — mit den
      // Container-Ids von VOR dem `compose up`. Jede weitere Aktion an diesem
      // Stack lehnt der Agent dann ab, und die Ablehnung sieht aus wie ein
      // Rechteproblem (#35).
      resyncHost: hostCycle.syncHost,
      // Die Ausstattung je Arm aus dem Halter des Laufs — der Nenner der Last
      // durch Container auf der Host-Karte (#214).
      readHostInfo: (hostId) => hostCycle.observations.read(hostId)?.hostInfo ?? null
    })
  );

  // /health ist die Stelle, an der das Abnahmekriterium dieser Phase sichtbar
  // wird: läuft der Hub, steht das Schema, und erreicht er den Agenten.
  app.get("/health", async (_request, response) => {
    const [database, agent] = await Promise.all([
      pool
        .query("SELECT 1")
        .then(() => ({ reachable: true as const }))
        .catch((error: unknown) => ({
          reachable: false as const,
          error: error instanceof Error ? error.message : String(error)
        })),
      probeAgent(config.agentBaseUrl, { timeoutMs: 3_000 })
    ]);

    // ⚠️ Der Statuscode hängt an der Datenbank, NICHT am Agenten. Der
    // Healthcheck von Compose liest ihn, und ein Hub, der sich wegen eines
    // stehenden Agenten selbst für krank erklärt, würde neu gestartet — was
    // dem Agenten nicht hilft und die eigentliche Ursache verdeckt. Der Zustand
    // des Agenten steht deshalb in der Antwort, nicht im Code.
    response.status(database.reachable ? 200 : 503).json({
      status: database.reachable ? "ok" : "degraded",
      service: "docklet-hub",
      database: { ...database, migrationsAppliedAtStart: migrationsApplied },
      agent
    });
  });

  const webRoot = fileURLToPath(WEB_ROOT);
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot));
    // ⚠️ HINTER `express.static` und nur in diesem Zweig: erst wenn keine
    // Datei passt, meint die Anfrage die Anwendung. Seit D6b hat die
    // Oberfläche einen eigenen Router, und ein Neuladen unter `/containers`
    // bekäme sonst 404 statt der Anwendung. Was der Rückfall auslässt und
    // warum, steht in platform/http/index-fallback.ts.
    app.use(createIndexFallback(webRoot));
  } else {
    // Kein Abbruch: der Server allein ist im Entwicklungsbetrieb brauchbar,
    // dort liefert Vite die Oberfläche. Im Image ist der Fall ein Baufehler
    // und soll auffallen — deshalb die Meldung.
    console.warn(`Keine gebaute Weboberfläche unter ${webRoot} — es wird nur die API ausgeliefert.`);
  }

  // Der Anmeldeweg — eine EIGENE Anwendung auf einem EIGENEN Port
  // (SECURITY.md, Grundsatz 2). Nicht als Route der API und nicht als Ausnahme
  // in einer Filterliste: eine Filterliste müsste bei jeder neuen Route von
  // Hand nachgepflegt werden und öffnet beim Vergessen still.
  //
  // Hier laufen beide Seiten zusammen, und nur hier: die App kennt den Pool
  // nicht, der Pool die App nicht.
  const registrationApp = createRegistrationApp(
    createRegistrationDeps({
      repository,
      log: (message) => console.log(message)
    })
  );
  const registrationServer = createServer(registrationApp);

  await new Promise<void>((resolve, reject) => {
    registrationServer.once("error", reject);
    registrationServer.listen(config.tunnelPort, REGISTRATION_BIND_ADDRESS, () => {
      registrationServer.removeListener("error", reject);
      console.log(
        `Anmeldeweg lauscht auf ${REGISTRATION_BIND_ADDRESS}:${config.tunnelPort} ` +
          `(im Tunnel: ${config.tunnel.hubAddress}:${config.tunnelPort}).`
      );
      resolve();
    });
  });

  const server = app.listen(config.port, () => {
    console.log(`Hub lauscht auf Port ${config.port}. Agent: ${config.agentBaseUrl}`);
  });

  // Ohne das wartet Docker beim Stoppen die vollen zehn Sekunden ab und
  // beendet dann hart — jeder Neustart des Stacks kostet sie.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`${signal} empfangen, fahre herunter …`);
      // Beide Zuhörer, nicht nur der eine: ein offener Anmeldeweg hielte den
      // Prozess nach dem Schließen der API weiter am Leben, und Docker
      // beendete ihn nach der Frist hart.
      registrationServer.close();
      // Der Zeitgeber ist `unref()`-t und hielte den Prozess nicht auf; er
      // wird trotzdem angehalten, damit während des Herunterfahrens kein
      // Durchlauf mehr gegen einen bereits geschlossenen Verbindungspool
      // startet.
      hostCycle.stop();
      const liveStopped = liveEvents.stop();
      server.close(() => {
        void liveStopped.then(() => pool.end()).then(() => process.exit(0));
      });
    });
  }
}

main().catch((error: unknown) => {
  // Ein Konfigurationsfehler ist eine Nachricht an den Betreiber, kein
  // Programmabsturz: er bekommt die Zeile, nicht den Stacktrace. Alles andere
  // bekommt den Stacktrace, weil dort niemand ohne ihn weiterkommt.
  if (error instanceof ConfigError) {
    console.error(`Start abgebrochen: ${error.message}`);
  } else {
    console.error("Start abgebrochen:", error);
  }
  process.exit(1);
});
