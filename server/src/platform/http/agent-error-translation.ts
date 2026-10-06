import type { Response } from "express";

import { agentFailureReason } from "../agent-transport/stream-rejection.js";
import type { AgentError } from "../agent-transport/protocol.js";

// Die Fehlerübersetzung an der Grenze zum Agenten — für die Datei-, Freigabe-,
// Compose- und Log-Fläche. Die Exec-Fläche führt ihre eigene Tabelle
// (`features/shell/rejections.ts`, `AGENT_START_REJECTIONS`), weil dort derselbe
// Status je Schlüssel drei verschiedene Dinge heißt.
//
// ── WARUM ES EINE EIGENE DATEI IST (#122) ───────────────────────────────────
//
// Bis #122 stand die Übersetzung zweimal da: in `file-access.ts` und als
// private Abschrift in `routes/container-routes.ts`. Die eine kannte das `429`,
// die andere das `409` und das `413` — und beide machten aus jeder anderen
// benannten Antwort des Arms ein `502 agent-unreachable`. Gemessen mit echten
// `AgentError`-Objekten, wie `agentRequest` sie baut: `429 too-many-streams`,
// `503 agent-read-only`, `404 not-allowlisted`, `404 fehlt` und
// `400 path-traversal` kamen alle als „Arm nicht erreichbar" an, bei einem
// Arm, der sauber und begründet abgelehnt hatte.
//
// ── ZWEI FELDER, ZWEI EIGENTÜMER ────────────────────────────────────────────
//
// `error` ist die Kennung DES HUBS und englisch (AGENTS.md, Abschnitt Sprache);
// die Oberfläche vergleicht gegen sie. `reason` ist der Schlüssel DER
// GEGENSEITE, wörtlich und ungeprüft durchgereicht — wie
// `LogStreamFailure.reason`. Eine Übersetzung an der Grenze wäre eine zweite
// Wahrheit, und ein Schlüssel, den der Agent morgen ergänzt, käme nicht mehr
// an. `reason` fehlt, wo der Agent keinen Rumpf mitgab oder der Weg ihn nicht
// lesen ließ (`AgentError.detail` in `agent/protocol.ts`).

/** Was an den Browser geht. */
export type TranslatedAgentError = { status: number; error: string; message: string };

/**
 * Gründe, die ein Fehler DES HUBS sind und keiner der Anfrage.
 *
 * `actor-not-allowed` means the hub called a route bound to another caller.
 * For the browser that is the same as a wrong secret — the same class as in
 * `AGENT_START_REJECTIONS`.
 */
const HUB_FAULT_REASONS: ReadonlySet<string> = new Set(["actor-not-allowed"]);

const UNREACHABLE = "agent-unreachable";

/**
 * Die Abbildung selbst — ohne `Response`, damit sie als Tabelle prüfbar ist.
 *
 * ⚠️ EINE ANTWORT OHNE GRUND BLEIBT, WAS SIE WAR. Ein `404` ohne Schlüssel ist
 * ein Arm, der die Route nicht kennt, und ein `400` ohne Schlüssel kommt von
 * keinem gemessenen Weg des Agenten. Beide bleiben im Sammelfall; erst der
 * benannte Schlüssel macht aus dem Status eine Antwort.
 */
export function translateAgentOutcome(
  status: number | null,
  reason: string | null,
  message: string
): TranslatedAgentError {
  // Ein `401` heißt: Hub und Agent tragen verschiedene Geheimnisse. Das ist
  // ein Fehler des Hubs und keiner der Anfrage.
  if (status === 401) return { status: 502, error: UNREACHABLE, message };
  if (reason !== null && HUB_FAULT_REASONS.has(reason)) {
    return {
      status: 502,
      error: UNREACHABLE,
      message: "Der Arm hat eine Route abgelehnt, die an einen anderen Aufrufer gebunden ist. Das ist ein Fehler des Hubs."
    };
  }
  if (status === 403) {
    // Die Meldung des Protokoll-Clients nennt die STELLE (das Audit-Log des
    // Zielhosts) statt einer geratenen Ursache. Häufigste Fälle: die Allowlist
    // des Agenten, ein selbstverwaltetes Projekt, ein Verzeichnis ohne Recht.
    return { status: 403, error: "agent-forbidden", message };
  }
  if (status === 404 && reason === "not-allowlisted") {
    // `gate()` führt die Allowlist als `404`; für den Betreiber ist es eine
    // Ablehnung und keine fehlende Sache. Dieselbe Einordnung wie an der
    // Exec- und der Compose-Fläche.
    return { status: 403, error: "agent-forbidden", message: "Diesen Container führt der Arm nicht in seiner Allowlist." };
  }
  if (status === 404 && reason === "container-gone") {
    return { status: 404, error: "container-unknown", message: "Diesen Container führt dieser Arm nicht mehr." };
  }
  if (status === 404 && reason !== null) {
    return { status: 404, error: "agent-not-found", message: `Der Arm findet das Ziel nicht („${reason}").` };
  }
  if (status === 400 && reason !== null) {
    return { status: 400, error: "agent-rejected", message: `Der Arm hat die Anfrage abgelehnt („${reason}").` };
  }
  if (status === 409) {
    // Ein `409`, der es bis hierher schafft, ist NICHT der Hash-Konflikt des
    // Texteditors — den fängt `writeFileText` und gibt ihn als Antwort
    // zurück. Hier landen die übrigen: eine fehlende Freigabe oder ein fehlendes
    // Schreibrecht beim Agenten, ein Registry-Anker, der nicht mehr passt.
    return { status: 409, error: "agent-conflict", message };
  }
  if (status === 413) {
    // Der Deckel des Agenten. Er ist eine Zahl und keine Störung.
    return { status: 413, error: "too-large", message };
  }
  if (status === 429) {
    // Der Deckel gleichzeitiger Ströme je Agent — Logs, Pulls, Anwenden und
    // Downloads teilen sich einen Topf (`MAX_OPEN_STREAMS` im Vertrag). Der
    // Vertrag verspricht dieses `429` ausdrücklich. Auch ohne Rumpf: der
    // Log-Strom liest keinen, und der Status allein ist hier eindeutig.
    return {
      status: 429,
      error: "too-many-streams",
      message: "Der Agent führt bereits die Höchstzahl gleichzeitiger Ströme. Ein geschlossener Strom gibt einen Platz frei."
    };
  }
  if (status === 503 && reason === "agent-read-only") {
    // Der Kill-Switch des Arms. Eine Einstellung und kein Ausfall — auch der
    // Trockenlauf der Compose-Fläche fällt darunter.
    return {
      status: 503,
      error: "agent-read-only",
      message: "Dieser Arm steht auf „nur lesen“. Solange der Kill-Switch liegt, schreibt er nichts."
    };
  }
  // Alles Übrige ist aus Sicht des Browsers dasselbe: der Hub konnte den
  // Agenten nicht bedienen.
  return { status: 502, error: UNREACHABLE, message };
}

/** Die Übersetzung samt Antwort; `reason` nur, wo der Agent einen nannte. */
export function translateAgentError(error: AgentError, response: Response): void {
  const reason = agentFailureReason(error);
  const outcome = translateAgentOutcome(error.status, reason, error.message);
  const body = { error: outcome.error, message: outcome.message };
  response.status(outcome.status).json(reason === null ? body : { ...body, reason });
}
