import test from "node:test";
import assert from "node:assert/strict";

import type { Response } from "express";

import { AgentError } from "../agent-transport/protocol.js";
import { translateAgentError } from "./agent-error-translation.js";

// Die Abbildung der Agentenfehler als Tabelle (#122). Die Fehler sind gebaut,
// wie `agentRequest` sie baut: Status aus der Antwort, der ausgewertete Rumpf
// in `detail`. Bis #122 kamen die ersten fünf Zeilen unten alle als
// `502 agent-unreachable` an, und die sechste ohne Schlüssel.

type Sent = { status: number; body: Record<string, unknown> };

function capture(): { response: Response; sent: Sent } {
  const sent: Sent = { status: 0, body: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    }
  } as unknown as Response;
  return { response, sent };
}

function rejected(status: number, detail: unknown): AgentError {
  return new AgentError(`Der Agent antwortete auf „/x" mit HTTP ${status}.`, status, { detail });
}

const NAMED: { agentStatus: number; key: string; status: number; error: string }[] = [
  { agentStatus: 429, key: "too-many-streams", status: 429, error: "too-many-streams" },
  { agentStatus: 503, key: "agent-read-only", status: 503, error: "agent-read-only" },
  { agentStatus: 404, key: "not-allowlisted", status: 403, error: "agent-forbidden" },
  { agentStatus: 404, key: "fehlt", status: 404, error: "agent-not-found" },
  { agentStatus: 400, key: "path-traversal", status: 400, error: "agent-rejected" },
  { agentStatus: 409, key: "no-write-permission", status: 409, error: "agent-conflict" },
  { agentStatus: 404, key: "container-gone", status: 404, error: "container-unknown" },
  { agentStatus: 403, key: "self-management-locked", status: 403, error: "agent-forbidden" },
  // Fehler des Hubs und keiner der Anfrage — dieselbe Einordnung wie an der
  // Exec-Fläche (`AGENT_START_REJECTIONS`).
  { agentStatus: 400, key: "tier-missing", status: 502, error: "agent-unreachable" },
  { agentStatus: 403, key: "internal-only-action", status: 502, error: "agent-unreachable" }
];

for (const row of NAMED) {
  test(`${row.agentStatus} ${row.key} kommt als ${row.status} ${row.error} an, mit dem Schlüssel des Agenten`, () => {
    const { response, sent } = capture();
    translateAgentError(rejected(row.agentStatus, { error: row.key }), response);
    assert.equal(sent.status, row.status);
    assert.equal(sent.body.error, row.error);
    // Der Schlüssel der Gegenseite geht wörtlich mit — nicht übersetzt.
    assert.equal(sent.body.reason, row.key);
    assert.ok(typeof sent.body.message === "string" && sent.body.message.length > 0);
  });
}

test("ein 429 ohne Rumpf ist trotzdem der Stromdeckel — der Log-Strom liest keinen", () => {
  const { response, sent } = capture();
  translateAgentError(new AgentError("HTTP 429", 429), response);
  assert.equal(sent.status, 429);
  assert.equal(sent.body.error, "too-many-streams");
  assert.ok(!("reason" in sent.body), "ein Schlüssel wurde erfunden, den der Agent nicht nannte");
});

// Ohne benannten Grund bleibt, was vorher galt: ein 404 ohne Schlüssel ist ein
// Arm, der die Route nicht kennt, ein 503 ohne `agent-read-only` keine Aussage
// über den Kill-Switch.
const UNNAMED: { status: number | null; detail: unknown }[] = [
  { status: 401, detail: { error: "unauthorized" } },
  { status: 404, detail: null },
  { status: 400, detail: null },
  { status: 503, detail: { error: "etwas-anderes" } },
  { status: 500, detail: { error: "intern" } },
  { status: null, detail: null }
];

for (const row of UNNAMED) {
  test(`${row.status ?? "kein Status"} ohne benannten Grund bleibt 502 agent-unreachable`, () => {
    const { response, sent } = capture();
    translateAgentError(new AgentError("x", row.status, { detail: row.detail }), response);
    assert.equal(sent.status, 502);
    assert.equal(sent.body.error, "agent-unreachable");
  });
}
