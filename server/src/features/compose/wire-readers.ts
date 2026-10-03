import { AgentError } from "../../platform/agent-transport/protocol.js";

// Lesen der Antwort — the readers of the agent's answers (moved here from the
// foot of `agent/compose.ts`, #264). The agent is a foreign side: a field that
// is missing or of another type gives an empty value and no crash.

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentError(`Die Antwort des Agenten auf „${path}" ist kein Objekt.`);
  }
  return value as Record<string, unknown>;
}

export function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asFlag(value: unknown): boolean {
  return value === true;
}

export function asTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function asTextMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") map[key] = entry;
  }
  return map;
}
