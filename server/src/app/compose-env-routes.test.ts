import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { HostRecord, HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_HOST_THEME } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Der neue Reiter durchläuft den echten Router und einen lokalen Fake-Arm.
// So werden Rollen, Herkunft, Maskierung und der explizite Klartextaufruf
// gemeinsam geprüft, ohne einen echten Host oder eine Datenbank zu brauchen.
const CONTAINER_ID = "c0ffee";
const BASE = `/api/hosts/host-1/containers/${CONTAINER_ID}/compose/env`;

function fakeAuth(): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const role = headers.get("x-test-role");
        if (role !== "admin" && role !== "user") return Promise.resolve(null);
        return Promise.resolve({ user: { id: `${role}-1`, name: role, email: `${role}@example.org`, role, language: "de" } });
      }
    }
  } as unknown as Auth;
}

type Agent = { port: number; seen: Array<{ url: string; actor: string | undefined }>; close: () => Promise<void> };

async function startAgent(): Promise<Agent> {
  const seen: Agent["seen"] = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    seen.push({ url, actor: request.headers["x-docker-agent-actor"] as string | undefined });
    const body = url === "/containers"
      ? { containers: [{ id: CONTAINER_ID, name: "sonarr", image: "sonarr:1", status: "running", running: true }] }
      : {
          projectDir: "/opt/stacks/medien",
          composeFileName: "compose.yaml",
          filePresent: true,
          plaintext: true,
          entries: [
            { key: "DB_PASSWORD", inFile: true, empty: false, value: "streng-geheim" },
            { key: "PATH", inFile: false, empty: false, value: "fremder-wert" }
          ]
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function startHub(agent: Agent): Promise<{ port: number; close: () => Promise<void> }> {
  const host = {
    id: "host-1", name: "unraid", agentUrl: `http://127.0.0.1:${agent.port}`,
    kind: "external", state: "registered", tunnelAddress: "10.254.0.2",
    wireguardPublicKey: null, endpointOverride: null, failedAttempts: 0,
    dockerGid: null, bindBasePath: null, createdAt: new Date(), registeredAt: new Date(),
    display: DEFAULT_HOST_THEME
  } as HostRecord;
  const app = express();
  app.use("/api", createApiRouter({
    auth: fakeAuth(),
    pool: {
      query: () => Promise.resolve({ rows: [{ agent_secret: "test-secret" }], rowCount: 1 })
    } as unknown as Pool,
    repository: {
      find: (id: string) => Promise.resolve(id === host.id ? host : null),
      list: () => Promise.resolve([host])
    } as unknown as HostRepository,
    enrollment: {} as Enrollment,
    agentSecret: "test-secret",
    config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
    probeHost: () => Promise.resolve({ reachable: true, version: "0.32.0", contractVersion: 7, readOnly: false, entries: null })
  }));
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

test("die .env bleibt maskiert, bis der Admin Klartext ausdrücklich anfordert", async () => {
  const agent = await startAgent();
  const hub = await startHub(agent);
  try {
    const headers = { "x-test-role": "admin", origin: `http://127.0.0.1:${hub.port}` };
    const masked = await fetch(`http://127.0.0.1:${hub.port}${BASE}`, { headers });
    assert.equal(masked.status, 200);
    assert.equal(masked.headers.get("cache-control"), "no-store");
    const maskedBody = await masked.text();
    assert.equal(maskedBody.includes("streng-geheim"), false);
    assert.equal(maskedBody.includes("fremder-wert"), false);
    assert.equal(JSON.parse(maskedBody).env.plaintext, false);
    assert.deepEqual(JSON.parse(maskedBody).env.entries, [{ key: "DB_PASSWORD", inFile: true, empty: false }]);

    const revealed = await fetch(`http://127.0.0.1:${hub.port}${BASE}?plaintext=1`, { headers });
    assert.equal(revealed.status, 200);
    const revealedEnv = (await revealed.json()).env;
    assert.equal(revealedEnv.plaintext, true);
    assert.deepEqual(revealedEnv.entries, [
      { key: "DB_PASSWORD", inFile: true, empty: false, value: "streng-geheim" }
    ]);
    assert.ok(agent.seen.some((entry) => entry.url.endsWith("/env?plaintext=1") && entry.actor === "user:admin-1"));
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("Benutzer und fremde Herkunft erreichen den .env-Endpunkt des Arms nicht", async () => {
  const agent = await startAgent();
  const hub = await startHub(agent);
  try {
    const user = await fetch(`http://127.0.0.1:${hub.port}${BASE}`, {
      headers: { "x-test-role": "user", origin: `http://127.0.0.1:${hub.port}` }
    });
    assert.equal(user.status, 403);
    const foreign = await fetch(`http://127.0.0.1:${hub.port}${BASE}?plaintext=1`, {
      headers: { "x-test-role": "admin", "sec-fetch-site": "cross-site" }
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Hub schreibt keine .env: ein direkter PUT erreicht den Arm nicht", async () => {
  const agent = await startAgent();
  const hub = await startHub(agent);
  try {
    // The agent refuses the write for externally managed stacks (#121); the
    // hub offers no write route at all, so no direct call can forward one.
    for (const method of ["PUT", "POST", "PATCH"]) {
      const response = await fetch(`http://127.0.0.1:${hub.port}${BASE}`, {
        method,
        headers: { "x-test-role": "admin", origin: `http://127.0.0.1:${hub.port}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedEnvHash: null, set: { DB_PASSWORD: "neu" }, remove: [] })
      });
      assert.equal(response.status, 404, method);
    }
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});
