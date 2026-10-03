import type { ExternalManagement } from "./containers.js";
import { agentGet, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

// Der volle Bestand des Hosts — die eine Route, die zeigt, was tatsächlich
// läuft, und nicht nur, was der Agent schon kennt.
//
// ⚠️ SIE IST NICHT `GET /containers`. Der Unterschied ist der ganze Grund für
// diese Datei: `GET /containers` zeigt ausschließlich Container, die schon in
// der Allowlist des Agenten stehen (`registry.allowedIds()`, gemessen am
// 2026-09-07 an `florianfinn/dashboard-docker-agent`@6ffc3c8, v0.19.1). Auf
// einem frisch aufgesetzten Arm ist diese Liste leer; ein Abgleich, der sich
// daraus speiste, sähe null Container und schriebe null Container zurück. Er
// bliebe für immer wirkungslos, und zwar lautlos.
//
// `GET /host-containers` ist `intern-only` (`src/route-policy.ts`). Der Hub
// meldet sich dauerhaft als `internal` (`protocol.ts`, `HUB_TIER`), die Route
// steht ihm also offen.
//
// ⚠️ Der Compose-Anker steht hier NICHT vollständig. Gemessen an
// `src/index.ts:2463` und `src/redact.ts:138` trägt ein Container hier nur
// `{ project, service }` — kein `projectDir` und kein `composeFileName`. Wer
// daraus einen Anker für die Registry baut, baut einen halben, und der Agent
// verwirft einen halben Anker samt seines Eintrags. Die fehlenden zwei Felder
// kommen aus `GET /stacks` (`stack-discovery.ts`).

/**
 * Ein Container aus dem Bestand des Hosts.
 *
 * Bewusst schmaler als `ContainerOverviewEntry`: diese Route dient dem
 * Abgleich und nicht der Anzeige. Was hier hereinkommt, steht in keiner
 * Antwort des Hubs — `stats`, `health` und die Härtungsbefunde haben deshalb
 * hier nichts zu suchen, auch wenn der Agent sie mitschickte.
 */
export type HostContainerEntry = {
  id: string;
  name: string;
  image: string;
  status: string;
  // Unvollständig, siehe oben — nur zur Anzeige und zur Fehlersuche brauchbar,
  // nicht als Anker.
  compose: { project: string; service: string } | null;
  externalManagement: ExternalManagement | null;
};

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(`${what} ist kein Objekt.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new AgentError(`${what}: das Feld „${key}" fehlt oder ist leer.`);
  }
  return value;
}

function parseExternalManagement(value: unknown): ExternalManagement | null {
  // Dieselbe Behandlung wie in `containers.ts`: die Fremdverwaltung ist ein
  // HINWEIS an der Zeile und nicht die Zeile selbst, deshalb wird ein Feld,
  // das nicht passt, gekürzt und nicht zum Abbruch.
  //
  // ⚠️ `manager` is a string, not an enumeration (agent:
  // `external-management.ts`). Any non-empty value locks the definition via
  // `externallyManaged`; an unknown one must not drop the whole list.
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const manager = record.manager;
  if (typeof manager !== "string" || manager.trim() === "") return null;
  return { manager };
}

function parseCompose(value: unknown): { project: string; service: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const project = record.project;
  const service = record.service;
  if (typeof project !== "string" || typeof service !== "string") return null;
  return { project, service };
}

/**
 * Liest die Antwort des Agenten auf `GET /host-containers`.
 *
 * ⚠️ Bricht ab, statt eine kürzere Liste zu liefern — dieselbe Entscheidung
 * wie in `parseContainerList` und hier noch schwerer wiegend: ein Container,
 * der beim Auswerten stillschweigend verloren geht, fehlt anschließend in der
 * Allowlist des Agenten, weil der Abgleich die Liste VOLLSTÄNDIG ersetzt. Aus
 * einem unlesbaren Feld würde so ein Container, an dem nichts mehr geht.
 * Gekürzt wird nur INNERHALB einer Zeile, bei Feldern, die ein Hinweis sind
 * (`compose`, `externalManagement`).
 */
export function parseHostContainerList(body: unknown): HostContainerEntry[] {
  const envelope = asRecord(body, "Die Antwort auf GET /host-containers");
  const containers = envelope.containers;
  if (!Array.isArray(containers)) {
    throw new AgentError(`Die Antwort auf GET /host-containers trägt kein Feld „containers" mit einer Liste.`);
  }

  return containers.map((entry, index) => {
    const what = `Container ${index + 1} in der Antwort auf GET /host-containers`;
    const record = asRecord(entry, what);
    return {
      id: requiredText(record, "id", what),
      name: requiredText(record, "name", what),
      image: requiredText(record, "image", what),
      status: requiredText(record, "status", what),
      compose: parseCompose(record.compose),
      externalManagement: parseExternalManagement(record.externalManagement)
    };
  });
}

/** Holt den vollen Container-Bestand eines Hosts. */
export async function fetchHostContainers(
  target: AgentTarget,
  options: RequestOptions
): Promise<HostContainerEntry[]> {
  return parseHostContainerList(await agentGet(target, "/host-containers", options));
}
