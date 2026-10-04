import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import type { Pool } from "pg";

import { DEFAULT_HOST_THEME } from "contract";
import type { AgentHealth, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { Auth } from "../platform/auth/auth.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";
import { createApiRouter } from "./router.js";

// The compose selection by hand (#185) over the whole way: real router, real
// Express, a small listener on 127.0.0.1 as the agent — the same pattern as
// `compose-routes.test.ts`, there with the streams. No Postgres, no
// docker.sock, no running agent.
//
// ⚠️ A SET-UP OF ITS OWN AND NO IMPORT FROM `compose-routes.test.ts`. That file
// stands at 986 lines and carries its set-up inline; an import from a test file
// would run its cases here a second time.

const HOST: HostRecord = {
  id: "host-1",
  name: "unraid",
  agentUrl: "http://127.0.0.1:0",
  kind: "external",
  state: "registered",
  tunnelAddress: "10.254.0.2",
  wireguardPublicKey: null,
  endpointOverride: null,
  failedAttempts: 0,
  dockerGid: null,
  bindBasePath: null,
  createdAt: new Date("2026-09-06T10:00:00.000Z"),
  registeredAt: new Date("2026-09-06T10:05:00.000Z"),
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

const ROLE_HEADER = "x-test-role";
const CONTAINER_ID = "c0ffee";
const CURRENT: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 10, readOnly: false, entries: null };
const OUTDATED: AgentHealth = { reachable: true, version: "0.31.0", contractVersion: 5, readOnly: false, entries: null };

/** What the agent answers on `compose-candidates` (`handleComposeCandidates`). */
const CANDIDATES = {
  composeAnchor: { ok: false, reason: "compose-anchor-file-ambiguous", projectDir: "/mnt/cache/docker/arc" },
  selectedFilePath: null,
  labelFilePaths: ["/mnt/cache/docker/arc/compose.yaml", "/mnt/cache/docker/arc/compose.timelapse.yaml"],
  candidates: [
    {
      filePath: "/mnt/cache/docker/arc/compose.yaml",
      projectDir: "/mnt/cache/docker/arc",
      composeFileName: "compose.yaml",
      source: "label",
      anchorReason: "compose-anchor-file-ambiguous"
    }
  ]
};

type AgentReply = { status: number; body?: unknown };

type FakeAgent = {
  port: number;
  replies: Map<string, AgentReply>;
  seen: { method: string; url: string; actor: string | undefined; body: string }[];
  close: () => Promise<void>;
};

async function startAgent(): Promise<FakeAgent> {
  const state: FakeAgent = { port: 0, replies: new Map(), seen: [], close: async () => undefined };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      state.seen.push({
        method: request.method ?? "",
        url,
        actor: request.headers["x-docker-agent-actor"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8")
      });
      const reply = state.replies.get(`${request.method} ${url.split("?")[0] ?? ""}`);
      response.writeHead(reply?.status ?? 500, { "content-type": "application/json" });
      response.end(JSON.stringify(reply?.body ?? { error: `unexpected: ${request.method} ${url}` }));
    });
  });
  await listenOnFetchablePort(server);
  state.port = (server.address() as AddressInfo).port;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
  state.replies.set("GET /containers", {
    status: 200,
    body: { containers: [{ id: CONTAINER_ID, name: "arc-2026-bluemap-timelapse", image: "b:1", status: "running", running: true }] }
  });
  return state;
}

function fakeAuth(): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const role = headers.get(ROLE_HEADER);
        if (role !== "admin" && role !== "user") return Promise.resolve(null);
        return Promise.resolve({
          user: { id: `${role}-1`, name: role, email: `${role}@example.org`, role, language: "de" }
        });
      }
    }
  } as unknown as Auth;
}

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (/^\s*SELECT agent_secret FROM docker_host/s.test(text)) {
        return Promise.resolve({ rows: [{ agent_secret: "secret" }], rowCount: 1 });
      }
      throw new Error(`Unexpected query in this test: ${text}`);
    }
  } as unknown as Pool;
}

type Hub = { port: number; close: () => Promise<void> };

async function startHub(agent: FakeAgent, health: AgentHealth = CURRENT): Promise<Hub> {
  const host = { ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` };
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(),
      repository: {
        find: (id: string) => Promise.resolve(host.id === id ? host : null),
        list: () => Promise.resolve([host])
      } as unknown as HostRepository,
      enrollment: {} as unknown as Enrollment,
      agentSecret: "unused",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
      probeHost: () => Promise.resolve(health)
    })
  );
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

const BASE = `/api/hosts/${HOST.id}/containers/${CONTAINER_ID}/compose`;

async function call(
  hub: Hub,
  method: string,
  path: string,
  role: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  // The origin check sits in front of the whole router; the header plays the
  // browser of the hub's own surface.
  const headers: Record<string, string> = { [ROLE_HEADER]: role, origin: `http://127.0.0.1:${hub.port}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/** The calls at the arm except the container list every route fetches first. */
function selectionCalls(agent: FakeAgent): string[] {
  return agent.seen.filter((entry) => entry.url !== "/containers").map((entry) => `${entry.method} ${entry.url}`);
}

const ROUTES = [
  ["GET", `${BASE}/candidates`, undefined],
  ["PUT", `${BASE}/selection`, { filePath: "/mnt/cache/docker/arc/compose.yaml" }],
  ["DELETE", `${BASE}/selection`, undefined]
] as const;

test("ein Benutzer ohne Adminrechte kommt an keine der drei Routen, und der Arm hört nichts", async () => {
  const agent = await startAgent();
  const hub = await startHub(agent);
  try {
    for (const [method, path, body] of ROUTES) {
      const answer = await call(hub, method, path, "user", body);
      assert.equal(answer.status, 403, `${method} ${path}`);
    }
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("die Kandidaten kommen durch, mit dem Menschen als Aufrufer beim Arm", async () => {
  const agent = await startAgent();
  agent.replies.set(`GET /containers/${CONTAINER_ID}/compose-candidates`, { status: 200, body: CANDIDATES });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "GET", `${BASE}/candidates`, "admin");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.selection, {
      anchor: { ok: false, reason: "compose-anchor-file-ambiguous", projectDir: "/mnt/cache/docker/arc" },
      selectedFilePath: null,
      labelFilePaths: CANDIDATES.labelFilePaths,
      candidates: [
        {
          filePath: "/mnt/cache/docker/arc/compose.yaml",
          projectDir: "/mnt/cache/docker/arc",
          composeFileName: "compose.yaml",
          source: "label"
        }
      ]
    });
    const read = agent.seen.find((entry) => entry.url.endsWith("/compose-candidates"));
    assert.equal(read?.actor, "user:admin-1");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("Festlegen reicht genau den gewählten Pfad weiter und meldet, was der Arm bestätigt", async () => {
  const agent = await startAgent();
  agent.replies.set(`PUT /containers/${CONTAINER_ID}/compose-selection`, {
    status: 200,
    body: { ok: true, selectedFilePath: "/mnt/cache/docker/arc/compose.yaml" }
  });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "PUT", `${BASE}/selection`, "admin", {
      filePath: "/mnt/cache/docker/arc/compose.yaml"
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { selectedFilePath: "/mnt/cache/docker/arc/compose.yaml" });
    const put = agent.seen.find((entry) => entry.method === "PUT");
    assert.deepEqual(JSON.parse(put?.body ?? "null"), { filePath: "/mnt/cache/docker/arc/compose.yaml" });
    assert.equal(put?.actor, "user:admin-1");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ohne Pfad wird gar nicht erst gefragt", async () => {
  const agent = await startAgent();
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "PUT", `${BASE}/selection`, "admin", {});
    assert.equal(answer.status, 400);
    assert.equal(answer.json.error, "compose-selection-missing");
    assert.deepEqual(selectionCalls(agent), []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("einen Pfad außerhalb seiner Liste lehnt der Arm ab, und sein Grund kommt wörtlich an", async () => {
  const agent = await startAgent();
  agent.replies.set(`PUT /containers/${CONTAINER_ID}/compose-selection`, {
    status: 400,
    body: { error: "invalid-compose-candidate" }
  });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "PUT", `${BASE}/selection`, "admin", { filePath: "/etc/passwd" });
    assert.equal(answer.status, 400);
    assert.equal(answer.json.error, "agent-rejected");
    assert.equal(answer.json.reason, "invalid-compose-candidate");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("Aufheben ist ein DELETE beim Arm", async () => {
  const agent = await startAgent();
  agent.replies.set(`DELETE /containers/${CONTAINER_ID}/compose-selection`, {
    status: 200,
    body: { ok: true, selectedFilePath: null }
  });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "DELETE", `${BASE}/selection`, "admin");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { selectedFilePath: null });
    assert.deepEqual(selectionCalls(agent), [`DELETE /containers/${CONTAINER_ID}/compose-selection`]);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein veralteter Arm bekommt keine der drei Routen gerufen", async () => {
  const agent = await startAgent();
  const hub = await startHub(agent, OUTDATED);
  try {
    for (const [method, path, body] of ROUTES) {
      const answer = await call(hub, method, path, "admin", body);
      assert.equal(answer.status, 409, `${method} ${path}`);
      assert.equal(answer.json.error, "agent-outdated");
    }
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── The read path of the compose file ───────────────────────────────────────

for (const reason of [
  "compose-file-missing",
  "compose-anchor-outside-base-path",
  "compose-anchor-file-ambiguous",
  "compose-anchor-labels-missing"
]) {
  test(`„${reason}" kommt als compose-file-missing mit Grund, Verzeichnis und Angebot an`, async () => {
    const agent = await startAgent();
    agent.replies.set(`GET /containers/${CONTAINER_ID}/compose-raw`, {
      status: 409,
      body: { error: reason, projectDir: "/mnt/user/docker/arc" }
    });
    const hub = await startHub(agent);
    try {
      const answer = await call(hub, "GET", BASE, "admin");
      assert.equal(answer.status, 409);
      assert.equal(answer.json.error, "compose-file-missing");
      assert.equal(answer.json.reason, reason);
      assert.equal(answer.json.projectDir, "/mnt/user/docker/arc");
      assert.equal(answer.json.selectionSupported, true);
    } finally {
      await hub.close();
      await agent.close();
    }
  });
}

test("die gelesene Datei sagt, ob der Hub die Zuordnung anbietet", async () => {
  for (const [health, expected] of [
    [CURRENT, true],
    [OUTDATED, false]
  ] as const) {
    const agent = await startAgent();
    agent.replies.set(`GET /containers/${CONTAINER_ID}/compose-raw`, {
      status: 200,
      body: { projectDir: "/mnt/cache/docker/arc", composeFileName: "compose.yaml", stackName: "arc", content: "" }
    });
    const hub = await startHub(agent, health);
    try {
      const answer = await call(hub, "GET", BASE, "admin");
      assert.equal(answer.status, 200);
      assert.equal((answer.json.compose as Record<string, unknown>).selectionSupported, expected, health.version ?? "");
    } finally {
      await hub.close();
      await agent.close();
    }
  }
});
