import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { AgentHealth, HostInfo, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Enrollment } from "../features/hosts/index.js";
import { CONTRACT_VERSION, DEFAULT_HOST_THEME, hostContainersSchema, overviewSchema } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Wo der Verlauf hingeht und wo nicht (#213, #214) — über den ganzen Weg:
// echter Router, echter Express, ein kleiner Agent auf 127.0.0.1.
//
// Die Übersicht und die Liste eines Arms tragen den letzten Wert, aber keinen
// Verlauf (Messung in `containers/container-load.ts`). Die Liste eines Arms
// trägt dafür die Last durch Container, gerechnet aus dem vollen Verlauf.

const SAMPLES = [
  { sampledAt: "2026-09-30T10:00:00.000Z", cpuPercent: 100, memUsageBytes: 200, memLimitBytes: null },
  { sampledAt: "2026-09-30T10:00:10.000Z", cpuPercent: 60, memUsageBytes: 300, memLimitBytes: null }
];

const CONTAINER = {
  id: "abc123",
  name: "immich",
  image: "ghcr.io/example/immich:1",
  status: "running",
  running: true,
  startedAt: null,
  health: null,
  compose: null,
  stats: { cpuPercent: 60, memUsageBytes: 300, memLimitBytes: null, sampledAt: SAMPLES[1].sampledAt, samples: SAMPLES },
  externalManagement: null
};

async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

type StartOptions = {
  containers?: unknown[];
  health?: AgentHealth;
};

async function start(
  hostInfo: HostInfo | null,
  options: StartOptions = {}
): Promise<{ port: number; close: () => Promise<void> }> {
  const containers = options.containers ?? [CONTAINER];
  const agent = await listen(
    http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        request.url === "/health"
          ? JSON.stringify({ ok: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: false })
          : JSON.stringify({ containers })
      );
    })
  );
  const host: HostRecord = {
    id: "host-1",
    name: "hub",
    agentUrl: `http://127.0.0.1:${agent.port}`,
    kind: "local",
    state: "registered",
    tunnelAddress: null,
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    registeredAt: new Date("2026-01-02T00:00:00Z"),
    lastSeenAt: null
  };

  const app = express();
  app.use(
    "/api",
    createApiRouter({
      auth: {
        api: {
          getSession: () =>
            Promise.resolve({ user: { id: "user-1", name: "user", email: "user@example.org", role: "user" } })
        }
      } as unknown as Auth,
      pool: {
        query: (text: string) => {
          if (/FROM mark_assignment/.test(text) || /FROM stack_display/.test(text)) {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          // Der lokale Arm nimmt das Geheimnis aus der Umgebung; die Zeile
          // ist leer (domain/hosts/agent-secret.ts).
          if (/SELECT agent_secret/.test(text)) return Promise.resolve({ rows: [{ agent_secret: null }], rowCount: 1 });
          throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
        }
      } as unknown as Pool,
      repository: {
        list: () => Promise.resolve([host]),
        find: (id: string) => Promise.resolve(id === host.id ? host : null)
      } as unknown as HostRepository,
      enrollment: {} as unknown as Enrollment,
      agentSecret: "s".repeat(32),
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
      probeHost: () =>
        Promise.resolve(options.health ?? { reachable: true, version: "0.32.0", contractVersion: 8, readOnly: false, entries: null }),
      readHostInfo: (hostId) => (hostId === host.id ? hostInfo : null)
    })
  );
  const api = await listen(http.createServer(app));
  return {
    port: api.port,
    close: async () => {
      await api.close();
      await agent.close();
    }
  };
}

async function get(port: number, path: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(response.status, 200);
  return response.json();
}

type Stats = { cpuPercent: number | null; samples: unknown[] };

test("die Liste eines Arms trägt die Last durch Container und keinen Verlauf je Container", async () => {
  const running = await start({ cpuCores: 4, memTotalBytes: 1_000 });
  try {
    const body = (await get(running.port, "/hosts/host-1/containers")) as {
      containers: { stats: Stats }[];
      load: { cpuPercent: number; memPercent: number; series: { cpuPercent: number | null }[] };
    };
    assert.deepEqual(body.containers[0].stats.samples, []);
    assert.equal(body.containers[0].stats.cpuPercent, 60, "der letzte Wert bleibt");
    assert.equal(body.load.cpuPercent, 15);
    assert.equal(body.load.memPercent, 30);
    assert.deepEqual(
      body.load.series.map((point) => point.cpuPercent),
      [25, 15]
    );
  } finally {
    await running.close();
  }
});

test("ohne bekannte Ausstattung ist die Last null und die Liste steht trotzdem", async () => {
  const running = await start(null);
  try {
    const body = (await get(running.port, "/hosts/host-1/containers")) as { containers: unknown[]; load: unknown };
    assert.equal(body.load, null);
    assert.equal(body.containers.length, 1);
  } finally {
    await running.close();
  }
});

test("die Übersicht trägt den letzten Wert und keinen Verlauf", async () => {
  const running = await start({ cpuCores: 4, memTotalBytes: 1_000 });
  try {
    const body = (await get(running.port, "/overview")) as { hosts: { loose: { stats: Stats }[] }[] };
    const [entry] = body.hosts[0].loose;
    assert.deepEqual(entry.stats.samples, []);
    assert.equal(entry.stats.cpuPercent, 60);
  } finally {
    await running.close();
  }
});

// ── The responses against their schemas (#248) ──────────────────────────────
//
// The web parses both routes against the contract and fails on a mismatch;
// these are the same checks on the side that builds them. A second container
// in a compose project puts a stack on the wire, not only loose containers.

const STACKED = {
  ...CONTAINER,
  id: "def456",
  name: "immich-db",
  compose: { project: "immich", service: "db" },
  stats: null,
  externalManagement: { manager: "unraid" }
};

test("Antwort von GET /overview erfüllt das Schema", async () => {
  const running = await start({ cpuCores: 4, memTotalBytes: 1_000 }, { containers: [CONTAINER, STACKED] });
  try {
    const body = await get(running.port, "/overview");
    const parsed = overviewSchema.safeParse(body);
    assert.ok(parsed.success, `GET /overview does not match overviewSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.hosts[0].stacks.length, 1, "a stack is on the wire");
    assert.equal(parsed.data.hosts[0].loose.length, 1, "a loose container is on the wire");
    // Nothing the server sends is stripped by the parse.
    assert.deepEqual(parsed.data, body);
  } finally {
    await running.close();
  }
});

test("Antwort von GET /hosts/:hostId/containers erfüllt das Schema", async () => {
  const running = await start({ cpuCores: 4, memTotalBytes: 1_000 }, { containers: [CONTAINER, STACKED] });
  try {
    const body = await get(running.port, "/hosts/host-1/containers");
    const parsed = hostContainersSchema.safeParse(body);
    assert.ok(
      parsed.success,
      `GET /hosts/:hostId/containers does not match hostContainersSchema: ${JSON.stringify(parsed.error?.issues)}`
    );
    assert.ok(parsed.data.load !== null, "the load is on the wire");
    assert.deepEqual(parsed.data, body);
  } finally {
    await running.close();
  }
});

test("Antwort von GET /hosts/:hostId/containers erfüllt das Schema, auch wenn der Arm schweigt", async () => {
  const running = await start(null, { health: { reachable: false, error: "agent unreachable" } });
  try {
    const body = await get(running.port, "/hosts/host-1/containers");
    const parsed = hostContainersSchema.safeParse(body);
    assert.ok(
      parsed.success,
      `GET /hosts/:hostId/containers does not match hostContainersSchema: ${JSON.stringify(parsed.error?.issues)}`
    );
    assert.equal(parsed.data.containers, null);
    assert.equal(parsed.data.agent.reachable, false);
    assert.deepEqual(parsed.data, body);
  } finally {
    await running.close();
  }
});
