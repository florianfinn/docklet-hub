import test from "node:test";
import assert from "node:assert/strict";

import type { AgentHealth, HostRecord } from "../../domain/hosts/index.js";
import type { AgentTarget } from "../../platform/agent-transport/protocol.js";
import { createLogsService, type LogsServiceDeps } from "./service.js";
import type { LogSettings } from "./store.js";

// The service of the feature `logs` without Express and without Postgres
// (#254): which `tail` applies, `invalid-tail`, an unknown host, and the
// order in which the service asks its dependencies. The HTTP side of the same
// cases stays in `app/container-routes.test.ts` and
// `app/settings-logs-routes.test.ts`, through the real router.

const HOST = { id: "host-1", agentUrl: "http://docker-agent:8099" } as HostRecord;
const TARGET: AgentTarget = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };

type Calls = {
  settingsRead: number;
  settingsWritten: LogSettings[];
  found: string[];
  probed: string[];
  connected: number;
  urls: string[];
};

const CURRENT: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 9, readOnly: false, entries: null };

// A service over fake dependencies that records every call. `stored` is the
// setting in the table, `health` what the probe of the arm answers.
function serviceWith(stored: LogSettings = { tailLines: 1000 }, health: AgentHealth = CURRENT) {
  const calls: Calls = { settingsRead: 0, settingsWritten: [], found: [], probed: [], connected: 0, urls: [] };
  const deps: LogsServiceDeps = {
    hosts: {
      find: async (hostId) => {
        calls.found.push(hostId);
        return hostId === HOST.id ? HOST : null;
      },
      connect: async () => {
        calls.connected += 1;
        return TARGET;
      }
    },
    probe: async (record) => {
      calls.probed.push(record.id);
      return health;
    },
    readSettings: async () => {
      calls.settingsRead += 1;
      return stored;
    },
    writeSettings: async (settings) => {
      calls.settingsWritten.push(settings);
      return settings;
    }
  };
  return { service: createLogsService(deps), calls };
}

// An agent that answers every stream with an empty, closed body and records
// the URL it was asked.
function emptyAgent(calls: Calls): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.urls.push(String(input));
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" }
    });
  }) as unknown as typeof fetch;
}

const STREAM_OPTIONS = { actor: { kind: "user" as const, id: "u-1" }, signal: new AbortController().signal };

// ── tail ────────────────────────────────────────────────────────────────────

test("ohne tail gilt die Einstellung aus dem Bestand", async () => {
  const { service, calls } = serviceWith({ tailLines: 1000 });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: undefined });
  assert.ok(plan.ok);
  assert.equal(plan.tail, 1000);
  assert.equal(calls.settingsRead, 1);
});

test("ein mitgeschickter tail gilt, und die Einstellung wird gar nicht gelesen", async () => {
  const { service, calls } = serviceWith({ tailLines: 1000 });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: "137" });
  assert.ok(plan.ok);
  // Not one of the four values of the setting, and still valid: the four are
  // the choice of the surface, not the range of the route.
  assert.equal(plan.tail, 137);
  assert.equal(calls.settingsRead, 0);
});

for (const invalid of ["0", "2001", "-5", "1.5", "viele", "", ["1", "2"]]) {
  test(`tail ${JSON.stringify(invalid)} ist invalid-tail, bevor Bestand oder Host gefragt werden`, async () => {
    const { service, calls } = serviceWith();
    const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: invalid });
    assert.deepEqual(plan, { ok: false, error: "invalid-tail" });
    // ⚠️ The point of the order: an invalid value costs neither a database
    // query nor a lookup of the host, let alone a connection to the agent.
    assert.equal(calls.settingsRead, 0);
    assert.deepEqual(calls.found, []);
    assert.equal(calls.connected, 0);
  });
}

// ── host ────────────────────────────────────────────────────────────────────

test("ein unbekannter Host ist host-unknown, und der Agent wird nicht gefragt", async () => {
  const { service, calls } = serviceWith();
  const plan = await service.planContainerLog({ hostId: "nobody", containerId: "abc", tail: "7" });
  assert.deepEqual(plan, { ok: false, error: "host-unknown" });
  assert.deepEqual(calls.found, ["nobody"]);
  assert.deepEqual(calls.probed, []);
  assert.equal(calls.connected, 0);
});

// ── contract ────────────────────────────────────────────────────────────────

test("ein Arm unter dem aktuellen Vertrag ist agent-outdated, und der Strom wird nicht geöffnet", async () => {
  // v0.31.0 before #278: it streams `zeile` instead of `line`, and the reader
  // dropped every line of it without a word.
  const { service, calls } = serviceWith(undefined, { ...CURRENT, version: "0.31.0", contractVersion: 3 });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: "7" });
  assert.deepEqual(plan, { ok: false, error: "agent-outdated" });
  assert.deepEqual(calls.probed, [HOST.id]);
  assert.equal(calls.connected, 0);
});

test("ein Arm ohne Angabe des Vertrags gilt als zu alt", async () => {
  const { service } = serviceWith(undefined, { ...CURRENT, contractVersion: null });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: "7" });
  assert.deepEqual(plan, { ok: false, error: "agent-outdated" });
});

test("eine ältere Fassung mit dem aktuellen Vertrag streamt weiter", async () => {
  const { service } = serviceWith(undefined, { ...CURRENT, version: "0.31.9" });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: "7" });
  assert.ok(plan.ok);
});

test("ein Arm, der nicht antwortet, bleibt Sache des Stroms und nicht dieser Prüfung", async () => {
  const { service } = serviceWith(undefined, { reachable: false, error: "connect ECONNREFUSED" });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "abc", tail: "7" });
  assert.ok(plan.ok);
});

test("ein ungültiger tail geht einem unbekannten Host vor", async () => {
  // Both are wrong; the caller learns about the one that costs nothing to
  // check, the same order the route had before #254.
  const { service } = serviceWith();
  const plan = await service.planContainerLog({ hostId: "nobody", containerId: "abc", tail: "0" });
  assert.deepEqual(plan, { ok: false, error: "invalid-tail" });
});

// ── stream ──────────────────────────────────────────────────────────────────

test("erst der Strom verbindet zum Agenten, mit dem entschiedenen tail", async () => {
  const { service, calls } = serviceWith({ tailLines: 500 });
  const plan = await service.planContainerLog({ hostId: HOST.id, containerId: "a/b", tail: undefined });
  assert.ok(plan.ok);
  // Planning connects nowhere: the connection happens inside the relay, where
  // a failure before `open` is still a status.
  assert.equal(calls.connected, 0);

  await plan.stream({ ...STREAM_OPTIONS, fetchImpl: emptyAgent(calls) }, () => undefined);
  assert.equal(calls.connected, 1);
  assert.deepEqual(calls.urls, ["http://docker-agent:8099/containers/a%2Fb/logs-stream?tail=500"]);
});

// ── setting ─────────────────────────────────────────────────────────────────

test("die Einstellung nimmt einen der vier Werte und schreibt ihn", async () => {
  const { service, calls } = serviceWith();
  assert.deepEqual(await service.updateSettings(2000), { ok: true, settings: { tailLines: 2000 } });
  assert.deepEqual(calls.settingsWritten, [{ tailLines: 2000 }]);
});

for (const invalid of [501, "500", null, undefined, Number.NaN]) {
  test(`die Einstellung lehnt ${String(invalid)} ab und schreibt nichts`, async () => {
    const { service, calls } = serviceWith();
    assert.deepEqual(await service.updateSettings(invalid), { ok: false });
    assert.deepEqual(calls.settingsWritten, []);
  });
}
