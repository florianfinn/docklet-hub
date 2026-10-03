import type { HostLoad } from "contract";

import { fetchContainers, withoutHistory, type ContainerOverviewEntry } from "../../domain/containers/index.js";
import {
  ARM_AGENT_IMAGE,
  fetchSelfUpdateStatus,
  isValidDockerGid,
  normalizeBindBasePath,
  probeAgent,
  requestSelfUpdate,
  toHostView,
  type AgentHealth,
  type HostAccess,
  type HostInfo,
  type HostRecord
} from "../../domain/hosts/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { DEFAULT_BIND_BASE_PATH } from "./bootstrap/host-archive-input.js";
import type { EnrollHostInput } from "./enrollment.js";

// The service of the feature `hosts` (#266): what the host routes decide
// between reading the request and writing the answer — the list with the state
// of each arm, the containers of one arm, the check of a new arm's input and
// the agent update through the watcher. The route reads parameters, sets the
// status and writes the answer; `service.test.ts` checks the rest without
// Express, without Postgres and without an agent.
//
// Creating an arm, its archive and removing it are the enrollment
// (`enrollment.ts`); the route calls it directly, as it did before the move.
//
// ⚠️ Every outcome is a value with a `kind`, never a status code. Which status
// a `kind` becomes is the route's table; the service knows no HTTP.

export type HostView = ReturnType<typeof toHostView>;

type AgentUpdateState = NonNullable<HostView["agentUpdate"]>["state"];
type SelfUpdateStatus = Awaited<ReturnType<typeof fetchSelfUpdateStatus>>;

/** The load by containers of one arm (#214); `features.ts` hands it in, see there. */
export type HostLoadOf = (containers: readonly ContainerOverviewEntry[], info: HostInfo | null) => HostLoad | null;

/** The agent calls of this surface; injectable for `service.test.ts`. */
export type HostsAgent = {
  probeAgent: typeof probeAgent;
  fetchContainers: typeof fetchContainers;
  requestSelfUpdate: typeof requestSelfUpdate;
  fetchSelfUpdateStatus: typeof fetchSelfUpdateStatus;
};

export type HostsServiceDeps = {
  hosts: Pick<HostAccess, "list" | "find" | "connect">;
  /** The reachability of an arm, from the observation store where it is fresh (`resolveProbeHost`). */
  probe: (record: HostRecord) => Promise<AgentHealth>;
  /** Writes "seen now" on a host's row and returns the stored time (#205). */
  markSeen: (hostId: string) => Promise<Date | null>;
  readHostInfo: (hostId: string) => HostInfo | null;
  hostLoad: HostLoadOf;
  agent?: HostsAgent;
};

export type HostContainersResult =
  | { kind: "host-unknown" }
  | {
      kind: "ok";
      host: HostView;
      agent: AgentHealth;
      containers: ContainerOverviewEntry[] | null;
      load: HostLoad | null;
      error: string | null;
    };

export type NewHostInput =
  | { kind: "ok"; input: EnrollHostInput }
  | { kind: "invalid-input"; message: string };

export type AgentUpdateStart =
  | { kind: "host-unknown" }
  | { kind: "host-is-local" }
  | { kind: "agent-update-unavailable"; state: AgentUpdateState | null }
  | { kind: "accepted"; jobId: string; targetVersion: string }
  | { kind: "agent-error"; error: AgentError };

export type AgentUpdateRead =
  | { kind: "host-unknown" }
  | ({ kind: "ok" } & Pick<SelfUpdateStatus, "running" | "version" | "last">)
  | { kind: "agent-error"; error: AgentError };

const DEFAULT_AGENT: HostsAgent = { probeAgent, fetchContainers, requestSelfUpdate, fetchSelfUpdateStatus };

export function createHostsService({ hosts, probe, markSeen, readHostInfo, hostLoad, agent = DEFAULT_AGENT }: HostsServiceDeps) {
  // Ein Arm hat eben geantwortet: den Zeitpunkt festhalten (#205).
  //
  // ⚠️ Scheitert das Schreiben, steht trotzdem „jetzt“ in der Antwort — die
  // Sonde hat eben geantwortet, und das ist wahr, ob die Zeile es weiß oder
  // nicht. Die Liste der Arme an einer Nebenauskunft scheitern zu lassen,
  // nähme dem Betreiber die Hauptauskunft.
  const withSeenNow = async (record: HostRecord): Promise<HostRecord> => {
    try {
      return { ...record, lastSeenAt: (await markSeen(record.id)) ?? new Date() };
    } catch {
      return { ...record, lastSeenAt: new Date() };
    }
  };

  // Die Liste der Hosts mit ihrem Zustand.
  //
  // ⚠️ Ausgegeben wird eine AUFZÄHLUNG von Feldern (`toHostView`), nie der
  // Datensatz selbst. Der Datensatz trägt zwar kein Secret — das steht
  // bewusst nicht an ihm (domain/hosts/host-record.ts) —, aber die Aufzählung ist die
  // zweite Hälfte derselben Zusage: eine neue Spalte in der Tabelle landet
  // nicht dadurch im Browser, dass sie da ist.
  //
  // Der Zustand wird HIER erhoben und nicht gespeichert. Ein „letzter bekannte
  // Zustand" in der Tabelle wäre eine Zahl, die altert, ohne dass jemand es
  // merkt; hier ist sie so alt wie die Antwort.
  async function listHosts(): Promise<HostView[]> {
    const records = await hosts.list();
    return Promise.all(
      records.map(async (record) => {
        // Ein Host, dessen Agent sich nie gemeldet hat, wird nicht befragt:
        // sein Tunnel steht noch nicht, und die Liste wartete sonst je
        // ausstehendem Arm eine Frist lang.
        if (record.state === "pending") return toHostView(record, null);
        const health = await agent.probeAgent(record.agentUrl, { timeoutMs: 3_000 });
        return toHostView(health.reachable ? await withSeenNow(record) : record, health);
      })
    );
  }

  // Der Nachweis dieser Phase: Zustand des Agenten und seine Container.
  //
  // Beides in einer Antwort, weil es zusammen gelesen wird — ein leerer
  // Container-Bestand heißt etwas völlig anderes, je nachdem, ob der Agent
  // antwortet oder nicht.
  async function readHostContainers(hostId: string, userId: string): Promise<HostContainersResult> {
    const host = await hosts.find(hostId);
    if (!host) return { kind: "host-unknown" };

    // ⚠️ Die ERREICHBARKEIT kommt aus dem Halter des Hintergrundlaufs
    // (B4a-C2, #5) und nur dann aus einer eigenen Sonde, wenn der Halter
    // über diesen Arm nichts weiß oder sein Stand zu alt ist. Die
    // CONTAINER holt dieser Weg weiter selbst, mit dem Aufrufer der
    // Sitzung — siehe die Begründung unten am `fetchContainers`.
    const health = await probe(host);
    if (!health.reachable) {
      // 200 und nicht 502: die Frage „wie geht es dem Agenten?" ist
      // beantwortet worden, und zwar mit „schlecht". Ein Fehlerstatus hier
      // ließe die Oberfläche nicht zwischen „Hub kaputt" und „Agent aus"
      // unterscheiden.
      return { kind: "ok", host: toHostView(host, health), agent: health, containers: null, load: null, error: health.error };
    }

    try {
      const containers = await agent.fetchContainers(
        // ⚠️ Das Geheimnis DIESES Arms, aus seiner Zeile; die Umgebung gilt
        // nur für `kind = "local"` (domain/hosts, `connect`, #77). Der Aufruf
        // steht INNERHALB des `try`: fehlt einem angebundenen Arm sein
        // Secret, wirft er einen `AgentError`, und der wird unten zum Feld
        // `error` dieser Antwort statt zu einem 500.
        await hosts.connect(host),
        // Der Aufrufer steht im Audit-Log des Agenten. Er ist dort die
        // einzige Spur, die von diesem Hub zurück auf einen Menschen zeigt.
        { actor: { kind: "user", id: userId } }
      );
      // Die Last durch Container (#214) entsteht HIER aus dem vollen
      // Verlauf; die Liste geht danach ohne ihn hinaus — die Karte braucht
      // 60 Punkte je Arm und nicht 60 je Container (`container-load.ts`).
      return {
        kind: "ok",
        host: toHostView(host, health),
        agent: health,
        containers: containers.map(withoutHistory),
        load: hostLoad(containers, readHostInfo(host.id)),
        error: null
      };
    } catch (error) {
      if (error instanceof AgentError) {
        return { kind: "ok", host: toHostView(host, health), agent: health, containers: null, load: null, error: error.message };
      }
      throw error;
    }
  }

  // Der Rumpf von `POST /hosts`, geprüft, bevor ein Datensatz entsteht.
  function parseNewHost(body: unknown): NewHostInput {
    const invalid = (message: string): NewHostInput => ({ kind: "invalid-input", message });
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return invalid("Der Rumpf der Anfrage ist kein JSON-Objekt.");
    }
    const { name, kind, endpointOverride, dockerGid, bindBasePath } = body as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return invalid("Der Name des Hosts fehlt.");
    if (kind !== "internal" && kind !== "external") {
      return invalid(
        "„kind“ ist „internal“ oder „external“. „local“ gibt es genau einmal und wird eingetragen, nicht angelegt."
      );
    }
    if (endpointOverride !== undefined && endpointOverride !== null && typeof endpointOverride !== "string") {
      return invalid("„endpointOverride“ ist eine Adresse oder leer.");
    }
    // ⚠️ `isValidDockerGid` und nicht `!dockerGid`: 0 ist die Gruppe root
    // und auf einem Host, der Docker als root fährt, die richtige Antwort.
    // Eine Prüfung auf Wahrheitswert wiese genau diesen Host ab — mit der
    // Meldung, die Angabe fehle.
    if (!isValidDockerGid(dockerGid)) {
      return invalid("„dockerGid“ ist eine ganze Zahl ab 0 — die Gruppe, der der Docker-Socket auf dem Zielhost gehört.");
    }
    // Leer heißt: die Vorgabe des Agenten. Ein Wert, der da ist, muss taugen.
    const path = bindBasePath === undefined || bindBasePath === null || bindBasePath === "" ? DEFAULT_BIND_BASE_PATH : bindBasePath;
    if (normalizeBindBasePath(path) === null) {
      return invalid(
        "„bindBasePath“ ist ein absoluter Pfad ohne Leerzeichen, ohne Doppelpunkt und ohne „..“; „/“ selbst ist ausgeschlossen."
      );
    }
    return {
      kind: "ok",
      input: {
        name,
        kind,
        dockerGid,
        bindBasePath: path as string,
        endpointOverride: typeof endpointOverride === "string" ? endpointOverride : null
      }
    };
  }

  // Das Update des Agenten eines Arms, ausgeführt von dessen Watcher
  // (Phase 7, #7; domain/hosts/self-update.ts).
  //
  // ⚠️ DAS ZIEL KOMMT VOM HUB und nicht aus der Anfrage: `ARM_AGENT_IMAGE`, der
  // Pin, mit dem dieser Hub neue Arme anlegt. Ein Ref aus dem Rumpf machte aus
  // dem Knopf einen Weg, jedem Arm ein beliebiges Image aus demselben
  // Repository unterzuschieben — auch eines, das der Hub nie geprüft hat.
  //
  // Angenommen wird nur bei `available`: das Angebot wird HIER frisch
  // erhoben und nicht aus der Liste im Browser geglaubt. Ein Arm auf
  // `manual` ignorierte das Ziel und meldete `unchanged`.
  async function startAgentUpdate(hostId: string, userId: string): Promise<AgentUpdateStart> {
    const host = await hosts.find(hostId);
    if (!host) return { kind: "host-unknown" };
    if (host.kind === "local") return { kind: "host-is-local" };
    const view = toHostView(host, await probe(host));
    if (view.agentUpdate?.state !== "available") {
      return { kind: "agent-update-unavailable", state: view.agentUpdate?.state ?? null };
    }
    try {
      const accepted = await agent.requestSelfUpdate(await hosts.connect(host), ARM_AGENT_IMAGE, {
        actor: { kind: "user", id: userId }
      });
      return { kind: "accepted", jobId: accepted.jobId, targetVersion: view.agentUpdate.targetVersion };
    } catch (error) {
      if (error instanceof AgentError) return { kind: "agent-error", error };
      throw error;
    }
  }

  // Der Stand des Auftrags. Während des Tauschs antwortet der Arm nicht —
  // das ist dann `502 agent-unreachable` und für die Oberfläche „läuft noch",
  // nicht „gescheitert".
  async function readAgentUpdate(hostId: string, userId: string): Promise<AgentUpdateRead> {
    const host = await hosts.find(hostId);
    if (!host) return { kind: "host-unknown" };
    try {
      const status = await agent.fetchSelfUpdateStatus(await hosts.connect(host), {
        actor: { kind: "user", id: userId },
        timeoutMs: 3_000
      });
      // Aufgezählt und nicht durchgereicht — dieselbe Zusage wie bei
      // `toHostView`: ein Feld, das der Parser morgen mehr liest, landet
      // nicht dadurch im Browser, dass es da ist.
      return { kind: "ok", running: status.running, version: status.version, last: status.last };
    } catch (error) {
      if (error instanceof AgentError) return { kind: "agent-error", error };
      throw error;
    }
  }

  return { listHosts, readHostContainers, parseNewHost, startAgentUpdate, readAgentUpdate };
}

export type HostsService = ReturnType<typeof createHostsService>;
