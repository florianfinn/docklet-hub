import { agentGet, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

// Die Ausstattung eines Arms: Zahl der Kerne und Arbeitsspeicher (#214).
//
// Der Agent liest beides aus `docker info` (`NCPU`, `MemTotal`) und sendet
// `null`, wo die Engine keinen positiven Wert nennt. Der Hub braucht beides
// als Nenner für die Last durch Container — eine Summe von `docker stats`
// sagt ohne die Zahl der Kerne nicht, ob 250 % viel oder wenig ist.
//
// ⚠️ The route reveals the host's layout.

export type HostInfo = {
  cpuCores: number | null;
  memTotalBytes: number | null;
};

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Liest die Antwort des Agenten auf `GET /host-info`. */
export function parseHostInfo(body: unknown): HostInfo {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AgentError("Die Antwort auf GET /host-info ist kein Objekt.");
  }
  const record = body as Record<string, unknown>;
  return { cpuCores: positive(record.cpuCores), memTotalBytes: positive(record.memTotalBytes) };
}

/** Holt die Ausstattung eines Arms. */
export async function fetchHostInfo(target: AgentTarget, options: RequestOptions): Promise<HostInfo> {
  return parseHostInfo(await agentGet(target, "/host-info", options));
}
