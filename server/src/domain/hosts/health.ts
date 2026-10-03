import type { AgentHealth } from "contract";

import type { HostRecord } from "./host-record.js";

// Erreichbarkeit des Agenten — mehr nicht.
//
// ⚠️ Abgrenzung: das ist NICHT der Protokoll-Client. Der wird in einer späteren
// Phase aus dem Quellsystem übernommen (`docker-agent-client.ts`, siehe
// concept-and-plan.md §4) und spricht die Container-, Compose- und
// Update-Routen. Hier geht es allein um die Frage, die das Abnahmekriterium
// dieser Phase stellt: erreicht der Hub den Agenten?
//
// Deshalb genau ein Endpunkt, und zwar der einzige, der beim Agenten VOR der
// Secret-Prüfung liegt und nichts über Container aussagt. Ein Aufruf mit
// Secret wäre hier schon der Anfang des Clients — und der gehört in die Phase,
// die ihn auch prüft.

// ⚠️ `version` wird IMMER gelesen, und `null` ist ein Ergebnis und kein
// fehlender Wert. Daran hängt die Schreibsperre: ein Host ohne genannte
// Version gilt als zu alt und nicht als in Ordnung (domain/hosts/version.ts,
// `isAgentOutdated`). Der Agent liefert das Feld seit v0.7.0 aus seiner
// package.json und meldet „unbekannt", wenn er sie nicht lesen kann — beide
// Fälle kommen hier als „nicht lesbar" an und werden dort zu „zu alt".
//
// Dass die Angabe im unerreichbaren Zweig fehlt, ist Absicht: wer nicht
// antwortet, hat nichts genannt. Die Statusableitung entscheidet deshalb
// „offline" vor „zu alt" (domain/hosts/host-store.ts, `deriveHostStatus`), und der
// Typcheck erzwingt die Unterscheidung an jeder Auswertung.
//
// `entries` ist die Größe der Allowlist, die der Agent gerade hält
// (`registry.size()`). Der Hintergrundlauf hält sie gegen die Zahl, die er
// zuletzt geschickt hat (#123): fällt der Agent bei fehlender oder
// unlesbarer Datei still auf die leere Liste, bleibt der Fingerabdruck im
// Hub gleich, und nur diese Zahl verrät den Unterschied. `null` heißt „nicht
// genannt" — ein älterer Agent löst dann keinen Schub aus.
// The shape lives in the contract (`contract/src/api/hosts.ts`, #248): it
// travels to the web inside the overview and the list of an arm.
export type { AgentHealth };

export type ProbeOptions = {
  // Einspeisbar, damit die Prüfung ohne laufenden Agenten testbar ist —
  // AGENTS.md verlangt Tests ohne echte Dienste.
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function isContractNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isEntryCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export async function probeAgent(baseUrl: string, options: ProbeOptions = {}): Promise<AgentHealth> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  // Ohne Frist bleibt ein Aufruf gegen einen Agenten, der die Verbindung
  // annimmt und dann schweigt, bis zum Prozessende offen. Genau so verhält
  // sich ein Port, vor dem eine Firewall verwirft statt abzulehnen.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) {
      return { reachable: false, error: `Agent antwortete mit HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) {
      return { reachable: false, error: "Agent antwortete ohne ok:true" };
    }
    const record = body as Record<string, unknown>;
    return {
      reachable: true,
      // Beides nur mitnehmen, wenn es wirklich dasteht: die Auskunft des
      // Agenten wächst über seine Versionen, und ein älterer liefert weniger.
      version: typeof record.version === "string" ? record.version : null,
      contractVersion: isContractNumber(record.contractVersion) ? record.contractVersion : null,
      readOnly: typeof record.readOnly === "boolean" ? record.readOnly : null,
      entries: isEntryCount(record.entries) ? record.entries : null
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Agent antwortete nicht innerhalb von ${timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { reachable: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// The deadline a route gives itself for "does this arm live?".
//
// Three seconds and not the ten of the protocol client: a person waits in
// front of a surface. The same value stands in the background run
// (`host-cycle-service.ts`) — another deadline there would give another answer
// to the same question, depending on who happened to ask.
const PROBE_TIMEOUT_MS = 3_000;

/**
 * The probe a route file uses: the injected one or its own (moved from
 * `app/router-support.ts` with #260, where only `api/` could reach it).
 *
 * ⚠️ ONE place for the fallback and not one per route file. Two copies of the
 * same default are two truths: whoever moves one to the observation store
 * leaves the other behind, and both stay green.
 */
export function resolveProbeHost(options: {
  probeHost?: (record: HostRecord) => Promise<AgentHealth>;
}): (record: HostRecord) => Promise<AgentHealth> {
  return options.probeHost ?? ((record) => probeAgent(record.agentUrl, { timeoutMs: PROBE_TIMEOUT_MS }));
}
