import { fetchContainers, type ContainerOverviewEntry } from "../containers/index.js";
import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import type { RouteFailure } from "../../platform/http/route-failure.js";
import type { HostAccess } from "./host-access.js";
import type { AgentHealth } from "./health.js";
import type { HostRecord } from "./host-record.js";
import { deriveHostStatus } from "./host-store.js";

// The chain every container surface goes through before it asks the agent
// anything: host, reachability, version, container. It stood in
// `api/file-access.ts` as `openContainer`, which wrote the answer itself; it
// returns the refusal as data since #260, because the feature `shell` imports
// no `api/` file and answers in its own route.
//
// The reasons for the order, the status codes and the price of the container
// list stood at `openContainer` in `api/file-access.ts`; the file left with the
// feature `compose` (#264), the two paragraphs below are carried over from it
// unchanged and still German.
//
// ⚠️ WARUM DIESE KETTE DEN AGENTEN NACH SEINER CONTAINER-LISTE FRAGT, obwohl
// der Pfad die Container-Id schon trägt: die Ablage der Freigaben liegt je
// (Arm, CONTAINERNAME) und nicht je Id (Etappe E2, 011-container-shares.sql,
// Entscheidung des Leitstands), der Agent dagegen führt seine Registry-Kopie
// je ID (`registry.get(containerId)` in `checkWebftpAccess`). Die Zuordnung
// muss also irgendwo geschehen, und die einzige Quelle dafür ist der Bestand
// des Arms im Augenblick der Anfrage. Sie beantwortet im selben Zug die erste
// Zeile der Tabelle: „gehört dieser Container zu diesem Host?" lässt sich
// anders gar nicht beantworten — ein Hub, der die Id blind weiterreicht,
// fragte einen fremden Arm nach einem Container, den er nie gesehen hat.
//
// ⚠️ DER PREIS, ehrlich genannt: eine Anfrage der Fläche kostet zwei
// Vorgespräche mit dem Arm (Erreichbarkeit, Container-Liste), bevor die
// eigentliche geht. Das Erste ist meist frei — `probeHost` schaut zuerst in den
// Halter des Hintergrundlaufs (B4a-C2, #5). Das Zweite ist es nicht und
// schreibt beim Agenten zusätzlich einen Audit-Eintrag. Der Ausweg wäre eine
// gespeicherte Zuordnung Id → Name im Hub; sie wäre eine Zahl, die altert,
// ohne dass es jemand merkt, und genau deshalb steht sie hier nicht.
//
// ⚠️ THE STATUS CODES ARE THE CONTRACT (docs/design/phase-5-write-access.md §4,
// table), not a convenience:
//
//   container does not belong to this host   404
//   host is `pending` or `offline`            503
//   host is `outdated`, route with effect     409 — BEFORE the agent is asked
//   agent cannot be reached or fetched        an `agent-error` for the route
//
// Reasons here are for the person in front of the surface and stay German
// sentences, like every message of the hub.

/** What the chain needs: the way to the hosts and the probe. */
export type ContainerAccessDeps = {
  hosts: Pick<HostAccess, "find" | "connect">;
  probe: (record: HostRecord) => Promise<AgentHealth>;
};

/** Which container a request is about, and who asks. */
export type ContainerAccessRequest = { hostId: string; containerId: string; userId: string };

/**
 * Whether a route changes something. The write lock against an agent that is
 * too old hangs on it; it is not `GET_ROUTES_WITH_EFFECT` (`request-origin.ts`),
 * which answers the question of the origin check.
 */
export type RouteWriting = "writes" | "reads";

/** What stands after the chain. */
export type ContainerAccess = {
  host: HostRecord;
  /** The arm with ITS secret (`createHostAccess(…).connect`, #77). */
  target: AgentTarget;
  /** The container with id AND name — the name is the key of the share store. */
  container: ContainerOverviewEntry;
  /**
   * The options of every call of the surface. The caller comes from the
   * session and never from the body: it is the one trace in the agent's audit
   * log that leads from this hub to a person.
   */
  options: { actor: { kind: "user"; id: string } };
  /** The whole container list of the arm, fetched anyway (compose reads it). */
  containers: ContainerOverviewEntry[];
  /**
   * Whether a route with effect would pass this chain: `false` for an
   * `outdated` arm. A reading route that only OFFERS a write (the compose
   * selection, #185) reads it here instead of asking the arm a second time.
   */
  writable: boolean;
};

export type ContainerAccessResult = { ok: true; access: ContainerAccess } | { ok: false; failure: RouteFailure };

function problem(status: number, error: string, message: string): { ok: false; failure: RouteFailure } {
  return { ok: false, failure: { kind: "problem", status, error, message } };
}

/** Host, reachability, version, container — or the refusal, as data. */
export async function openContainerAccess(
  deps: ContainerAccessDeps,
  request: ContainerAccessRequest,
  writing: RouteWriting
): Promise<ContainerAccessResult> {
  const host = await deps.hosts.find(request.hostId);
  if (!host) return problem(404, "host-unknown", "Diesen Arm führt der Hub nicht.");

  const health = await deps.probe(host);
  const status = deriveHostStatus({
    state: host.state,
    reachable: health.reachable,
    // The version is named only by an arm that answered; the unreachable
    // branch carries none (`health.ts`), so `deriveHostStatus` decides
    // "offline" before "outdated".
    agentVersion: health.reachable ? health.version : null,
    contractVersion: health.reachable ? health.contractVersion : null
  });

  if (status === "pending" || status === "offline") {
    // 503 and not 502: the hub is fine, the arm is not — and a `pending` arm
    // has no agent yet.
    return problem(
      503,
      "host-unreachable",
      status === "pending"
        ? "Dieser Arm hat sich noch nie gemeldet — sein Archiv liegt noch beim Betreiber."
        : "Dieser Arm antwortet nicht."
    );
  }

  if (status === "outdated" && writing === "writes") {
    // ⚠️ BEFORE the agent is asked. The mark lives in a file (`version.ts`,
    // `MIN_AGENT_VERSION`); a lock that holds only after the call locked
    // nothing.
    return problem(
      409,
      "agent-outdated",
      "Der Agent dieses Arms ist zu alt für schreibende Zugriffe. Lesen geht weiter; " +
        "zum Schreiben braucht er eine neuere Fassung."
    );
  }

  const target = await deps.hosts.connect(host);
  const options = { actor: { kind: "user" as const, id: request.userId } };

  let containers: ContainerOverviewEntry[];
  try {
    containers = await fetchContainers(target, options);
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    return { ok: false, failure: { kind: "agent-error", error } };
  }

  const container = containers.find((entry) => entry.id === request.containerId);
  // A container THIS arm does not keep is not there for this route — also if
  // another arm of the inventory keeps it.
  if (!container) return problem(404, "container-unknown", "Diesen Container führt dieser Arm nicht.");

  return { ok: true, access: { host, target, container, options, containers, writable: status !== "outdated" } };
}
