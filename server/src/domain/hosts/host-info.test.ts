import test from "node:test";
import assert from "node:assert/strict";

import { fetchHostInfo, parseHostInfo } from "./host-info.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";

// Die Form ist gemessen und nicht geraten: `dashboard-docker-agent`, Route
// `GET /host-info` in `src/index.ts` — `cpuCores` aus `NCPU`, `memTotalBytes`
// aus `MemTotal`, jeweils `null`, wenn die Engine keinen positiven Wert nennt.

test("Kerne und Arbeitsspeicher kommen an", () => {
  assert.deepEqual(parseHostInfo({ cpuCores: 4, memTotalBytes: 16_000_000_000 }), {
    cpuCores: 4,
    memTotalBytes: 16_000_000_000
  });
});

test("ein fehlender oder unbrauchbarer Wert wird null und nicht null Kerne", () => {
  // Null Kerne wäre ein Nenner, durch den die Last unendlich würde.
  assert.deepEqual(parseHostInfo({ cpuCores: null, memTotalBytes: 0 }), { cpuCores: null, memTotalBytes: null });
  assert.deepEqual(parseHostInfo({ cpuCores: "4", memTotalBytes: -1 }), { cpuCores: null, memTotalBytes: null });
  assert.deepEqual(parseHostInfo({}), { cpuCores: null, memTotalBytes: null });
});

test("eine Antwort, die kein Objekt ist, ist ein Fehler des Agenten", () => {
  assert.throws(() => parseHostInfo(null), AgentError);
  assert.throws(() => parseHostInfo([4]), AgentError);
});

test("die Anfrage geht an /host-info", async () => {
  let url = "";
  const fetchImpl = (async (input: string | URL | Request) => {
    url = String(input);
    return new Response(JSON.stringify({ cpuCores: 8, memTotalBytes: 1024 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  const info = await fetchHostInfo(
    { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) },
    { actor: { kind: "system", name: "hub" }, fetchImpl }
  );
  assert.equal(url, "http://docker-agent:8099/host-info");
  assert.deepEqual(info, { cpuCores: 8, memTotalBytes: 1024 });
});
