import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
import { startAgent, type AgentUnderTest } from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { agentPut, AgentError } from "../../platform/agent-transport/protocol.js";
import { sendSelfHealingConfig } from "./agent-client.js";

let agent: AgentUnderTest;
before(async () => { agent = await startAgent(); });
after(async () => { await agent?.stop(); });

test("Hub-Client spricht den echten Agent-Handler und prüft seine gespeicherte Quittung samt Audit", async () => {
  const config = { ...DEFAULT_SELF_HEALING_CONFIG, enabled: false };
  await sendSelfHealingConfig(agent.target, config);
  const audit = readFileSync(agent.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(audit.at(-1).action, "self-healing-config");
  assert.equal(audit.at(-1).actor, "system:hub");
  assert.equal(audit.at(-1).outcome, "allowed");
  assert.deepEqual(JSON.parse(readFileSync(new URL("self-healing-config.json", `file://${agent.auditFile}`), "utf8")), config);
});

test("Agent lehnt fremde und fehlende Akteure sowie ungültige Konfigurationen mit Audit ab", async () => {
  for (const actor of [{ kind: "user", id: "demo-admin" }, { kind: "system", name: "monitor" }] as const)
    await assert.rejects(agentPut(agent.target, "/self-healing/config", DEFAULT_SELF_HEALING_CONFIG, { actor }),
      (error: unknown) => error instanceof AgentError && error.status === 403);
  const withoutActor = await fetch(`${agent.target.baseUrl}/self-healing/config`, { method: "PUT",
    headers: { "x-docker-agent-secret": agent.target.secret, "content-type": "application/json" },
    body: JSON.stringify(DEFAULT_SELF_HEALING_CONFIG) });
  assert.equal(withoutActor.status, 403);
  await assert.rejects(agentPut(agent.target, "/self-healing/config", { ...DEFAULT_SELF_HEALING_CONFIG, attempts: 2 },
    { actor: { kind: "system", name: "hub" } }), (error: unknown) => error instanceof AgentError && error.status === 400);
  const audit = readFileSync(agent.auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(audit.at(-1).outcome, "denied");
  assert.equal(audit.at(-1).reason, "invalid-request (retryDelaysSeconds)");
});

test("eine abweichende Quittung gilt als Übertragungsfehler", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ config: { ...DEFAULT_SELF_HEALING_CONFIG, enabled: false } }),
    { headers: { "content-type": "application/json" } });
  try { await assert.rejects(sendSelfHealingConfig(agent.target, DEFAULT_SELF_HEALING_CONFIG), /acknowledgement/); }
  finally { globalThis.fetch = original; }
});
