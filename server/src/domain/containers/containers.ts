import { runtimeAccessSchema } from "contract";
import type { ContainerEntry, ContainerStats, ContainerStatsSample, ExternalManagement } from "contract";

import { agentGet, AgentError, type AgentTarget, type RequestOptions } from "../../platform/agent-transport/protocol.js";

// Die rein lesende Container-Übersicht — die eine Route, an der diese Phase
// zeigt, dass Hub und Agent sich einig sind.
//
// ⚠️ Was der Agent unter `GET /containers` liefert, ist deutlich mehr als das
// hier: Umgebungsschlüssel, Härtungsbefunde, Beweglichkeit der
// Image-Referenz. Der Hub nimmt davon nur, was die Übersicht zeigt.
//
// Seit D6b gehört die FREMDVERWALTUNG dazu (`externalManagement`, #20,
// Entscheidung vom 2026-09-06): die Fläche „Container" führt fremdverwaltete
// Container als eigene Gruppe und nennt dabei, wer sie verwaltet. Ohne dieses
// Feld sähe ein von Unraid verwalteter Container aus wie jeder andere — und
// eine Aktion darauf liefe gegen einen Verwalter, der sie zurückdreht.
//
// Das ist Absicht und keine Sparsamkeit: jedes Feld, das hier hereinkommt,
// steht ab sofort in einer Antwort des Hubs und damit im Browser. Die
// Härtungs-Karte etwa ist eine offene Entscheidung (#18); sie hier schon
// mitzunehmen hieße, sie beiläufig zu treffen.
//
// ⚠️ Der Agent zeigt unter dieser Route ausschließlich Container, die in
// SEINER Allowlist stehen (`registry.allowedIds()`, v0.18.1). Ein frisch
// aufgesetzter Agent hat eine leere Allowlist und meldet deshalb korrekt eine
// leere Liste — die Antwort ist richtig und nicht leer, weil etwas fehlt.
//
// ⚠️ Eine KURZE Liste kann dagegen sehr wohl etwas verschweigen, und der Hub
// kann es nicht sehen. Gemessener Fall: v0.17.0 und v0.18.0 lasen die
// Allowlist-Datei aus der Zeit davor nur teilweise, weil drei Schlüssel darin
// umbenannt worden waren — am 2026-09-04 auf einem Live-Host 13 Einträge in
// der Datei, 6 geladen, kein Wort im Log (dashboard-docker-agent#52, behoben
// in v0.18.1). Von hier aus sah das aus wie sechs Container. Was der Agent
// nicht lädt, kann diese Route nicht zeigen und dieser Hub nicht bemerken —
// der Vergleich gegen den tatsächlichen Bestand des Hosts liefe über
// `GET /host-containers` und gehört in die Phase, die den Bestand pflegt.
//
// Gefüllt wird sie über `PUT /registry`. Bedient wird sie hier trotzdem nicht: wer die
// Allowlist schreibt, bestimmt, worauf der Agent überhaupt Aktionen zulässt —
// das ist der Gegenstand der Phase, die diese Aktionen einführt, und nicht
// der Übersicht.

// The shapes of a container as the hub hands it on live in the contract
// (`contract/src/api/containers.ts`, #248), together with the reasons for
// each nullable field; the web checks them there. `ContainerOverviewEntry` is
// this side's name for `ContainerEntry`.
export type { ContainerStats, ContainerStatsSample, ExternalManagement };
export type ContainerOverviewEntry = ContainerEntry;

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

function optionalText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseStats(value: unknown): ContainerStats | null {
  // `null` heißt beim Agenten „gerade nicht ermittelbar" (Container eben
  // gestartet, Stats-Aufruf gescheitert) und ist kein Fehler. Der Unterschied
  // zu „null Prozent" gehört bis in die Oberfläche durchgereicht.
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    cpuPercent: optionalNumber(record, "cpuPercent"),
    memUsageBytes: optionalNumber(record, "memUsageBytes"),
    memLimitBytes: optionalNumber(record, "memLimitBytes"),
    sampledAt: optionalText(record, "sampledAt"),
    samples: parseSamples(record.samples)
  };
}

function parseSample(value: unknown): ContainerStatsSample | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sampledAt = optionalText(record, "sampledAt");
  // Ein Messpunkt ohne lesbaren Zeitpunkt lässt sich keiner Welle zuordnen
  // (#214 summiert je Welle über `sampledAt`) und fällt deshalb heraus.
  if (sampledAt === null || Number.isNaN(Date.parse(sampledAt))) return null;
  return {
    sampledAt,
    cpuPercent: optionalNumber(record, "cpuPercent"),
    memUsageBytes: optionalNumber(record, "memUsageBytes"),
    memLimitBytes: optionalNumber(record, "memLimitBytes")
  };
}

// ⚠️ KÜRZEN STATT ABBRECHEN, anders als bei der Liste selbst. Ein Messpunkt,
// der nicht passt, nimmt dem Verlauf einen Wert und nicht dem Container seine
// Zeile — dieselbe Abwägung wie bei `parseExternalManagement`.
function parseSamples(value: unknown): ContainerStatsSample[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const sample = parseSample(entry);
    return sample === null ? [] : [sample];
  });
}

/**
 * Liest die Messwerte aus der Antwort des Agenten auf `GET /containers/:id`.
 *
 * Die Einzelansicht trägt dieselbe Form wie ein Eintrag der Liste; der Hub
 * nimmt davon nur die Messwerte — für den Verlauf im Container-Detail (#213).
 */
export function parseContainerStats(body: unknown): ContainerStats | null {
  const record = asRecord(body, "Die Antwort auf GET /containers/:id");
  return parseStats(record.stats);
}

/** Holt die Messwerte samt Verlauf EINES Containers. */
export async function fetchContainerStats(
  target: AgentTarget,
  containerId: string,
  options: RequestOptions
): Promise<ContainerStats | null> {
  return parseContainerStats(await agentGet(target, `/containers/${encodeURIComponent(containerId)}`, options));
}

/**
 * Derselbe Eintrag ohne den Verlauf.
 *
 * ⚠️ Die Übersicht trägt nur den letzten Wert (#213, gemessen: 60 Messpunkte
 * sind je Container rund 7,6 kB JSON — die Rechnung steht in
 * `features/metrics/container-load.ts`). Der Verlauf kommt im Detail über eine
 * eigene Route.
 */
export function withoutHistory(entry: ContainerOverviewEntry): ContainerOverviewEntry {
  return entry.stats === null ? entry : { ...entry, stats: { ...entry.stats, samples: [] } };
}

function parseExternalManagement(value: unknown): ExternalManagement | null {
  // Kein Abbruch bei einer Form, die nicht passt: die Fremdverwaltung ist ein
  // HINWEIS an der Zeile und nicht die Zeile selbst. Ein Agent, dessen Feld
  // anders aussieht als erwartet, soll seine Container weiterhin zeigen —
  // anders als bei `id` oder `name`, ohne die eine Zeile nichts bedeutet.
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
 * Liest die Antwort des Agenten auf `GET /containers`.
 *
 * Bricht ab, statt eine kürzere Liste zu liefern: eine Übersicht, die einen
 * Container stillschweigend weglässt, weil sein Datensatz nicht passte, ist
 * schlimmer als eine Fehlermeldung — sie sieht vollständig aus.
 */
export function parseContainerList(body: unknown): ContainerOverviewEntry[] {
  const envelope = asRecord(body, "Die Antwort auf GET /containers");
  const containers = envelope.containers;
  if (!Array.isArray(containers)) {
    throw new AgentError(`Die Antwort auf GET /containers trägt kein Feld „containers" mit einer Liste.`);
  }

  return containers.map((entry, index) => {
    const what = `Container ${index + 1} in der Antwort auf GET /containers`;
    const record = asRecord(entry, what);
    return {
      id: requiredText(record, "id", what),
      name: requiredText(record, "name", what),
      image: requiredText(record, "image", what),
      status: requiredText(record, "status", what),
      running: record.running === true,
      exitCode: optionalNumber(record, "exitCode"),
      ...(typeof record.oneShot === "boolean" ? { oneShot: record.oneShot } : {}),
      ...(runtimeAccessSchema.safeParse(record.runtimeAccess).success
        ? { runtimeAccess: runtimeAccessSchema.parse(record.runtimeAccess) } : {}),
      startedAt: optionalText(record, "startedAt"),
      health: optionalText(record, "health"),
      compose: parseCompose(record.compose),
      stats: parseStats(record.stats),
      externalManagement: parseExternalManagement(record.externalManagement)
    };
  });
}

/** Holt die Container eines Agenten. */
export async function fetchContainers(
  target: AgentTarget,
  options: RequestOptions
): Promise<ContainerOverviewEntry[]> {
  return parseContainerList(await agentGet(target, "/containers", options));
}
