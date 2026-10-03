import test from "node:test";
import assert from "node:assert/strict";

import { probeAgent } from "./health.js";

// Geprüft wird ohne laufenden Agenten: `fetch` wird eingespeist. Ein Test, der
// einen Agenten bräuchte, übersprünge sich auf einer frischen Arbeitskopie
// still und wäre damit keiner (AGENTS.md, „Tests").

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("gesunder Agent gilt als erreichbar, Version wird übernommen", async () => {
  const result = await probeAgent("http://docker-agent:8099", {
    fetchImpl: async (input) => {
      assert.equal(String(input), "http://docker-agent:8099/health");
      return response(200, { ok: true, version: "v0.16.0", readOnly: false, entries: 0 });
    }
  });
  assert.deepEqual(result, { reachable: true, version: "v0.16.0", contractVersion: null, readOnly: false, entries: 0 });
});

test("ein älterer Agent ohne Versionsfeld gilt trotzdem als erreichbar", async () => {
  const result = await probeAgent("http://docker-agent:8099", {
    fetchImpl: async () => response(200, { ok: true })
  });
  assert.deepEqual(result, { reachable: true, version: null, contractVersion: null, readOnly: null, entries: null });
});

test("HTTP-Fehler gilt nicht als erreichbar", async () => {
  const result = await probeAgent("http://docker-agent:8099", {
    fetchImpl: async () => response(503, {})
  });
  assert.deepEqual(result, { reachable: false, error: "Agent antwortete mit HTTP 503" });
});

test("eine Antwort ohne ok:true gilt nicht als erreichbar", async () => {
  // Der Fall, der ohne diese Prüfung durchginge: irgendetwas anderes lauscht
  // auf dem Port und liefert freundlich 200.
  const result = await probeAgent("http://docker-agent:8099", {
    fetchImpl: async () => response(200, { hallo: "welt" })
  });
  assert.deepEqual(result, { reachable: false, error: "Agent antwortete ohne ok:true" });
});

test("eine abgelehnte Verbindung wird als Grund weitergereicht", async () => {
  const result = await probeAgent("http://docker-agent:8099", {
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 172.20.0.3:8099");
    }
  });
  assert.equal(result.reachable, false);
  assert.match(result.reachable === false ? result.error : "", /ECONNREFUSED/);
});

test("ein schweigender Agent läuft in die Frist statt zu hängen", async () => {
  const result = await probeAgent("http://docker-agent:8099", {
    timeoutMs: 20,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        // So verhält sich `fetch` beim Abbruch: es lehnt mit AbortError ab.
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("Abgebrochen");
          error.name = "AbortError";
          reject(error);
        });
      })
  });
  assert.deepEqual(result, { reachable: false, error: "Agent antwortete nicht innerhalb von 20 ms" });
});
