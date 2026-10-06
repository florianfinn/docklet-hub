import type { Pool } from "pg";

import {
  type AgentHealth,
  type HostCycleOutcome,
  type HostInfo,
  type HostRecord,
  type HostRepository
} from "../domain/hosts/index.js";
import type { Actor } from "../platform/agent-transport/protocol.js";
import type { Auth } from "../platform/auth/auth.js";
import type { Config } from "../platform/config/config.js";
import type { Enrollment } from "../features/hosts/index.js";

// Das Gerüst, das JEDE Routendatei dieses Routers braucht — unabhängig davon,
// ob sie Hosts, Marken, Einstellungen oder eine Sitzung anmeldet.
//
// Diese Datei entsteht mit der Aufteilung von `server/src/app/router.ts`
// (Etappe B4a-A1, #5). `ApiOptions`, `failWith` und `guarded` standen bisher
// außerhalb der Routen, in `router.ts` selbst — gebraucht von Handlern in
// jedem Block, nicht nur einem. Bliebe das so, müsste jede neue Datei unter
// `routes/` sie aus `router.ts` importieren, obwohl `router.ts` nach der
// Aufteilung selbst nur noch Registrierfunktionen aufruft: die Abhängigkeit
// stünde verkehrt herum. Hier liegen sie an einem Ort, den beide Hälften der
// Aufteilung gleichermassen kennen, ohne dass eine der anderen unterstellt
// ist.

import type { LiveEvents } from "../domain/live-events/index.js";

export type ApiOptions = {
  liveEvents?: LiveEvents;
  auth: Auth;
  pool: Pool;
  // Der Weg zum Bestand. Einspeisbar, weil der Integrationstest dieser Fläche
  // ohne Postgres läuft (features/hosts/enrollment.ts).
  repository: HostRepository;
  enrollment: Enrollment;
  // Das Geheimnis aus der Umgebung (`DOCKER_AGENT_SECRET`).
  //
  // ⚠️ Es gilt AUSSCHLIESSLICH für den lokalen Arm. Jeder angebundene trägt
  // sein eigenes in seiner Zeile; welches wohin gehört, entscheidet
  // `resolveAgentSecret` (domain/hosts/agent-secret.ts) und nicht der Aufrufer.
  agentSecret: string;
  /**
   * Die Adresse des Hubs aus der UMGEBUNG, für `GET /settings`.
   *
   * ⚠️ Nur diese eine Angabe und nicht die ganze `Config`: der Router soll den
   * Endpoint nicht auflösen — das tut `enrollment`, an genau einer Stelle. Er
   * berichtet ihn bloß, damit der Anlege-Dialog zeigen kann, was ein Arm
   * bekommen wird.
   */
  config: Pick<Config, "wireguardEndpoint" | "wireguardPort">;
  /**
   * Woher die Erreichbarkeit eines Arms kommt.
   *
   * Gesetzt wird sie in `index.ts` auf `createObservedProbe` — die schaut
   * zuerst in den Halter des Hintergrundlaufs
   * (`domain/hosts/host-observation-store.ts`) und fragt nur selbst, wenn dort
   * nichts Brauchbares steht. Ohne sie fragt `GET /overview` bei JEDER
   * Anfrage jeden Arm einzeln, und die Fläche nach der Anmeldung wird
   * langsamer, je mehr Arme es gibt.
   *
   * ⚠️ Optional, und der Vorgabewert ist genau das bisherige Verhalten
   * (`resolveProbeHost` unten). Das ist keine vergessene Zwischenschicht,
   * sondern ein Beschleuniger: fehlt er, ist die Antwort dieselbe und nur
   * langsamer. Eine Pflichtangabe hätte acht Testdateien angefasst, die den
   * Router bauen, ohne sich für die Erreichbarkeit zu interessieren.
   * Dass `index.ts` sie tatsächlich setzt, hält
   * `web/tests/server-wiring.test.mjs` nach.
   */
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
  /**
   * Der Abgleich der Allowlist EINES Arms, außerhalb des Takts.
   *
   * Gesetzt wird er in `index.ts` auf `syncHost` des Hintergrundlaufs. Genau
   * eine Route ruft ihn: das Anwenden eines Compose-Entwurfs (#35).
   *
   * ⚠️ ANDERS ALS `probeHost` IST ER KEIN BESCHLEUNIGER. Fehlt er, ist die
   * Antwort nicht dieselbe und nur langsamer, sondern der Arm trägt bis zum
   * nächsten Takt die alte Allowlist — mit den Container-Ids von VOR dem
   * `compose up`. Jede weitere Aktion an diesem Stack lehnt der Agent dann ab,
   * und die Fläche, die gerade etwas geändert hat, ist danach kaputt.
   *
   * Optional ist er trotzdem, und aus demselben Grund wie `probeHost`: sonst
   * müsste jede Testdatei, die den Router baut, den Hintergrundlauf
   * mitbringen. Die Antwort sagt in diesem Fall ehrlich `skipped` statt
   * `synced`, und dass `index.ts` ihn tatsächlich setzt, hält
   * `web/tests/server-wiring.test.mjs` nach.
   */
  resyncHost?: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;
  /**
   * Kerne und Arbeitsspeicher eines Arms, wie der Hintergrundlauf sie zuletzt
   * gelesen hat (#214). Gesetzt in `index.ts` auf den Halter des Laufs.
   *
   * ⚠️ KEIN RÜCKFALL AUF EIN EIGENES LESEN. Fehlt die Angabe, zeigt die
   * Host-Karte keine Last durch Container — die Zahl ist eine Anzeige, und
   * eine Frage mehr je Anfrage an jeden Arm wäre genau der Aufwand, den der
   * Lauf einspart. Optional aus demselben Grund wie `probeHost`; dass
   * `index.ts` sie setzt, hält `web/tests/server-wiring.test.mjs` nach.
   */
  readHostInfo?: (hostId: string) => HostInfo | null;
};

// `failWith` and `guarded` live in `platform/http/route-responses.ts` since
// #254: a feature uses them too, and a feature does not import `api/`.
