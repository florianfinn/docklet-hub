import type { Pool } from "pg";

import { probeAgent } from "./health.js";
import type { Actor, AgentTarget } from "../../platform/agent-transport/protocol.js";
import {
  REGISTRY_SYNC_ACTOR,
  fetchHostContainers,
  fetchStackDiscovery,
  readShares,
  syncRegistry
} from "../containers/index.js";
import { fetchHostInfo } from "./host-info.js";
import { createHostAccess } from "./host-access.js";
import type { HostRecord } from "./host-record.js";
import type { HostRepository } from "./host-repository.js";
import { markHostSeen } from "./host-store.js";
import {
  cycleHost,
  runHostCycle,
  type HostCycleOutcome,
  type HostCycleResult,
  type SingleHostCycleDeps
} from "./host-cycle.js";
import { createCycleRunner, startCycleTimer } from "./host-cycle-timer.js";
import { createHostObservationStore, type HostObservationStore } from "./host-observation-store.js";

// Die Verdrahtung des Hintergrundlaufs: hier treffen der Durchlauf
// (`host-cycle.ts`), der Halter (`host-observation-store.ts`) und der
// Zeitgeber (`host-cycle-timer.ts`) auf die echten Zugänge — Datenbank,
// Agenten, Geheimnisse.
//
// ⚠️ Sie steht als EIGENE Datei und nicht in `index.ts`. Der Grund ist
// gemessen: `index.ts` hat keine Teststelle (Etappe C1, #5 — wer dort
// `app.use(createContentSecurityPolicyHeader())` entfernt, bekommt eine grüne
// Kette). Alles, was hier eine Entscheidung trifft, wäre dort unbeobachtet.
// Was in `index.ts` bleibt, ist EINE Zeile Aufruf — und die hält
// `web/tests/server-wiring.test.mjs` als Text nach.

// Die Frist der Sonde, gleich der in den Routen (`features/containers/routes.ts`,
// `features/hosts/routes.ts`): drei Sekunden. Sie steht hier noch einmal, weil der Lauf
// diese Routen ablöst — eine andere Frist im Hintergrund ergäbe eine andere
// Antwort auf dieselbe Frage, je nachdem, wer gerade gefragt hat.
const PROBE_TIMEOUT_MS = 3_000;

export type HostCycleServiceOptions = {
  pool: Pool;
  repository: HostRepository;
  // Das Geheimnis aus der Umgebung. Es gilt AUSSCHLIESSLICH für den lokalen
  // Arm; jeder angebundene trägt sein eigenes in seiner Zeile
  // (`domain/hosts`, `connect`, #77).
  agentSecret: string;
  intervalSeconds: number;
  log: (message: string) => void;
  logError: (message: string, error: unknown) => void;
};

export type HostCycleService = {
  // Der Halter — die Routen lesen die Erreichbarkeit von hier.
  observations: HostObservationStore;
  // Das eingestellte Intervall in Millisekunden, `0` bei abgeschaltetem Lauf.
  // Die Routen rechnen daraus, ab wann ein abgelegter Stand zu alt ist.
  intervalMs: number;
  started: boolean;
  stop: () => void;
  /**
   * Ein Abgleich für EINEN Arm, außerhalb des Takts.
   *
   * ⚠️ DER AUFRUFER IST HIER EIN MENSCH, und das widerspricht der Regel über
   * `REGISTRY_SYNC_ACTOR` nicht, sondern folgt ihr. Ihre Begründung lautet:
   * ein `user:<id>` behauptete im Audit-Log des Agenten, ein Mensch habe den
   * Abgleich ausgelöst — „hier sieht niemand zu". Bei diesem Aufruf sieht
   * jemand zu: er hat gerade eine Compose-Datei angewandt. Ein `system:hub`
   * an dieser Stelle löschte die Spur, die von der Änderung auf die Person
   * zeigt.
   */
  syncHost: (record: HostRecord, actor: Actor) => Promise<HostCycleOutcome>;
};

/** The way to ONE arm, with the secret from its own row: the same door the routes use (#251). */
function targetFor(options: HostCycleServiceOptions, record: HostRecord): Promise<AgentTarget> {
  return createHostAccess(options).connect(record);
}

/** Eine Zeile Bilanz je Durchlauf — aber nur, wenn es etwas zu melden gibt. */
function summarize(result: HostCycleResult): string | null {
  const synced = result.hosts.filter((host) => host.status === "synced");
  const failed = result.hosts.filter((host) => host.status === "failed");
  if (synced.length === 0 && failed.length === 0) return null;

  const parts: string[] = [];
  for (const host of synced) parts.push(`${host.hostName}: ${String(host.entryCount)} Einträge eingetragen`);
  for (const host of failed) parts.push(`${host.hostName}: ${host.error ?? "unbekannter Fehler"}`);
  return `Hintergrundlauf (${result.finishedAt - result.startedAt} ms): ${parts.join("; ")}`;
}

/**
 * Startet den Hintergrundlauf.
 *
 * ⚠️ Der erste Durchlauf läuft SOFORT und nicht erst nach einem Intervall.
 * Sonst wüsste der Halter in der ersten Minute nach dem Start nichts, und
 * jede Anfrage an die Übersicht fiele in dieser Zeit auf die eigene Sonde
 * zurück — also genau in das Verhalten, das dieser Lauf ablöst, und zwar
 * ausgerechnet direkt nach einem Neustart.
 *
 * ⚠️ Der Aufrufer gegenüber jedem Agenten ist `REGISTRY_SYNC_ACTOR`
 * (`system:hub`) und kein Benutzerkonto. Er steht im Audit-Log des Agenten;
 * ein `user:<id>` behauptete, ein Mensch habe den Abgleich ausgelöst — hier
 * sieht niemand zu.
 */
/**
 * Die Zugänge eines Abgleichs, für EINEN gewählten Aufrufer.
 *
 * ⚠️ Der Aufrufer ist der einzige Unterschied zwischen dem Takt und dem
 * Abgleich nach einem angewandten Compose-Entwurf. Alles andere — die drei
 * Abrufe, der Fingerabdruck, die Reihenfolge von Quittung und Ablage — bleibt
 * dieselbe Funktion. Zwei Fassungen davon wären zwei Wahrheiten über die
 * Frage, was auf einem Arm erlaubt ist.
 */
function cycleDepsFor(
  options: HostCycleServiceOptions,
  observations: HostObservationStore,
  actor: Actor
): SingleHostCycleDeps {
  return {
    readObservation: (hostId) => observations.read(hostId),
    writeObservation: (observation) => observations.write(observation),
    // Nach einer Antwort hält der Lauf fest, wann (#205). Ohne ihn stünde
    // „Zuletzt erreichbar“ nur so frisch da wie der letzte Besuch der
    // Hosts-Seite. Ein Fehler beim Schreiben ist hier kein Fehler der Sonde:
    // er geht nicht in die Beobachtung, und der nächste Takt schreibt neu.
    probeHost: async (record) => {
      const health = await probeAgent(record.agentUrl, { timeoutMs: PROBE_TIMEOUT_MS });
      if (health.reachable) await markHostSeen(options.pool, record.id).catch(() => null);
      return health;
    },
    fetchInventory: async (record) => fetchHostContainers(await targetFor(options, record), { actor }),
    // ⚠️ `.stacks` — `fetchStackDiscovery` liefert `{ stacks, findings }`.
    // Die Befunde erklären eine Lücke, sie erzeugen keine; dieser Hub
    // vergleicht sie gegen nichts (`domain/containers/stack-discovery.ts`).
    fetchStacks: async (record) => (await fetchStackDiscovery(await targetFor(options, record), { actor })).stacks,
    readShares: (record) => readShares(options.pool, record.id),
    sendRegistry: async (record, entries) => syncRegistry(await targetFor(options, record), entries, { actor }),
    fetchHostInfo: async (record) => fetchHostInfo(await targetFor(options, record), { actor }),
    now: () => Date.now()
  };
}

export function startHostCycleService(options: HostCycleServiceOptions): HostCycleService {
  const observations = createHostObservationStore();
  const intervalMs = options.intervalSeconds * 1_000;

  const runner = createCycleRunner({
    run: async () => {
      const result = await runHostCycle({
        listHosts: () => createHostAccess(options).list(),
        ...cycleDepsFor(options, observations, REGISTRY_SYNC_ACTOR)
      });
      // ⚠️ Nur melden, wenn sich etwas getan hat. Eine Zeile je Minute und Arm
      // machte das Log unlesbar — und die eine Meldung, auf die es ankommt,
      // ginge darin unter (dieselbe Überlegung wie beim Warten auf die
      // Datenbank in `index.ts`).
      const summary = summarize(result);
      if (summary !== null) options.log(summary);
    },
    // ⚠️ Hier endet jeder Fehler, den der Durchlauf nicht selbst gefangen hat
    // — allen voran ein Ausfall der Datenbank in `repository.list()`. Ein
    // unbehandelter Fehler in einem Zeitgeber beendet den Prozess.
    onError: (error) =>
      options.logError("Der Hintergrundlauf über die Arme ist gescheitert. Er versucht es beim nächsten Takt erneut:", error),
    onOverlap: () =>
      options.log(
        `Der vorige Hintergrundlauf läuft noch — dieser Takt wird ausgelassen. Dauert das an, ist das Intervall ` +
          `(${String(options.intervalSeconds)} s, HUB_HOST_CYCLE_INTERVAL_SECONDS) kürzer als ein Durchlauf.`
      )
  });

  const timer = startCycleTimer({ intervalMs, runner });
  if (timer.started) {
    options.log(`Hintergrundlauf über die Arme: alle ${String(options.intervalSeconds)} s.`);
    runner.trigger();
  } else {
    options.log(
      "Hintergrundlauf über die Arme ist abgeschaltet (HUB_HOST_CYCLE_INTERVAL_SECONDS=0). Die Übersicht fragt " +
        "jeden Arm bei jeder Anfrage selbst."
    );
  }

  return {
    observations,
    intervalMs,
    started: timer.started,
    stop: timer.stop,
    // ⚠️ ER LÄUFT AUCH BEI ABGESCHALTETEM TAKT (`intervalSeconds = 0`). Der
    // Schalter stellt den Hintergrundlauf ab, nicht den Abgleich als solchen —
    // und ein Arm, dessen Allowlist nach einem angewandten Entwurf veraltet
    // ist, bliebe sonst dauerhaft veraltet statt bis zum nächsten Takt.
    syncHost: (record: HostRecord, actor: Actor): Promise<HostCycleOutcome> =>
      cycleHost(record, cycleDepsFor(options, observations, actor))
  };
}
