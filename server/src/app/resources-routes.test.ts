import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { AgentHealth, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Enrollment } from "../features/hosts/index.js";
import { CONTRACT_VERSION, DEFAULT_HOST_THEME, hostResourcesResponseSchema, type HostResources } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// The resource overview of one host (#10) over the whole way: real router,
// real Express, a small agent on 127.0.0.1.

const RESOURCES: HostResources = {
  readAt: "2026-10-04T12:00:00.000Z",
  storage: { ok: false, reason: "engine-timeout" },
  usage: { ok: true },
  images: {
    ok: true,
    items: [
      {
        id: "sha256:a",
        tags: ["ghcr.io/example/docklet-hub:v0.32.0"],
        sizeBytes: 300,
        sharedSizeBytes: null,
        createdAt: null,
        usedBy: [{ name: "docklet-hub-hub-1", running: true, image: "ghcr.io/example/docklet-hub:v0.32.0", composeProject: "docklet-hub" }]
      }
    ]
  },
  volumes: { ok: true, items: [] },
  networks: { ok: false, reason: "engine-refused" }
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

type Started = { port: number; agentCalls: string[]; close: () => Promise<void> };

async function start(role: "admin" | "user", health?: AgentHealth): Promise<Started> {
  const agentCalls: string[] = [];
  const agent = await listen(
    http.createServer((request, response) => {
      agentCalls.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(RESOURCES));
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
          getSession: () => Promise.resolve({ user: { id: "person-1", name: "person", email: "person@example.org", role } })
        }
      } as unknown as Auth,
      pool: {
        query: (text: string) => {
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
        Promise.resolve(
          health ?? { reachable: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: false, entries: null }
        )
    })
  );
  const api = await listen(http.createServer(app));
  return {
    port: api.port,
    agentCalls,
    close: async () => {
      await api.close();
      await agent.close();
    }
  };
}

function get(port: number, path: string, secFetchSite = "same-origin"): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { "sec-fetch-site": secFetchSite } });
}

test("an admin reads the resources of a host, marked and with failed sections named", async () => {
  const server = await start("admin");
  try {
    const response = await get(server.port, "/hosts/host-1/resources");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { resources } = hostResourcesResponseSchema.parse(await response.json());
    assert.ok(resources.images.ok);
    assert.equal(resources.images.items[0].system, true);
    assert.deepEqual(resources.storage, { ok: false, reason: "engine-timeout" });
    assert.deepEqual(resources.networks, { ok: false, reason: "engine-refused" });
    assert.deepEqual(server.agentCalls, ["GET /resources"]);
  } finally {
    await server.close();
  }
});

test("a user without the admin role gets no resources and the agent is not asked", async () => {
  const server = await start("user");
  try {
    const response = await get(server.port, "/hosts/host-1/resources");
    assert.equal(response.status, 403);
    assert.deepEqual(server.agentCalls, []);
  } finally {
    await server.close();
  }
});

test("a foreign site cannot trigger the read under the operator's name", async () => {
  const server = await start("admin");
  try {
    const response = await get(server.port, "/hosts/host-1/resources", "cross-site");
    assert.equal(response.status, 403);
    assert.deepEqual(server.agentCalls, []);
  } finally {
    await server.close();
  }
});

test("an arm below the contract is refused with 409 before it is asked", async () => {
  const server = await start("admin", {
    reachable: true,
    version: "0.32.0",
    contractVersion: CONTRACT_VERSION - 1,
    readOnly: false,
    entries: null
  });
  try {
    const response = await get(server.port, "/hosts/host-1/resources");
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: string }).error, "agent-outdated");
    assert.deepEqual(server.agentCalls, []);
  } finally {
    await server.close();
  }
});

test("an unknown host is 404", async () => {
  const server = await start("admin");
  try {
    const response = await get(server.port, "/hosts/nope/resources");
    assert.equal(response.status, 404);
    assert.deepEqual(server.agentCalls, []);
  } finally {
    await server.close();
  }
});
