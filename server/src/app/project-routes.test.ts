import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import type { Pool } from "pg";

import type { AgentHealth, HostCycleOutcome, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import { DEFAULT_HOST_THEME } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// The project routes (#3) over the whole way: real router, real Express and a
// small listener on 127.0.0.1 as the agent, like `compose-routes.test.ts`.

const HOST: HostRecord = {
  id: "host-1",
  name: "unraid",
  agentUrl: "http://127.0.0.1:0",
  kind: "external",
  state: "registered",
  tunnelAddress: null,
  wireguardPublicKey: null,
  endpointOverride: null,
  failedAttempts: 0,
  dockerGid: null,
  bindBasePath: null,
  createdAt: new Date("2026-10-03T10:00:00.000Z"),
  registeredAt: new Date("2026-10-03T10:05:00.000Z"),
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

const ROLE_HEADER = "x-test-role";
const CURRENT: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 12, readOnly: false, entries: null };
const DRAFT = "services:\n  app:\n    image: example/notes:1.0\n";

type Reply = { status: number; body: unknown };

type FakeAgent = {
  port: number;
  replies: Map<string, Reply>;
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
      const reply = state.replies.get(`${request.method} ${url}`) ?? { status: 500, body: { error: "unerwartet" } };
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await listenOnFetchablePort(server);
  state.port = (server.address() as AddressInfo).port;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
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
        return Promise.resolve({ rows: [{ agent_secret: "s".repeat(32) }], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  } as unknown as Pool;
}

type Hub = { port: number; resyncs: string[]; close: () => Promise<void> };

async function startHub(agent: FakeAgent): Promise<Hub> {
  const host = { ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` };
  const resyncs: string[] = [];
  const app = express();
  app.use(express.json({ limit: "512kb" }));
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
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
      probeHost: () => Promise.resolve(CURRENT),
      resyncHost: (record: HostRecord) => {
        resyncs.push(record.id);
        return Promise.resolve({
          hostId: record.id,
          hostName: record.name,
          status: "synced",
          entryCount: 2,
          error: null
        } as HostCycleOutcome);
      }
    })
  );
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    resyncs,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

async function post(
  hub: Hub,
  path: string,
  role: string,
  body: unknown,
  origin: "same-origin" | "cross-site" = "same-origin"
): Promise<{ status: number; json: Record<string, unknown>; cache: string | null }> {
  const headers: Record<string, string> = { [ROLE_HEADER]: role, "content-type": "application/json" };
  if (origin === "same-origin") headers.origin = `http://127.0.0.1:${hub.port}`;
  else headers["sec-fetch-site"] = origin;
  const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json, cache: response.headers.get("cache-control") };
}

const PREVIEW = `/api/hosts/${HOST.id}/projects/preview`;
const CREATE = `/api/hosts/${HOST.id}/projects`;

async function withHub(run: (agent: FakeAgent, hub: Hub) => Promise<void>): Promise<void> {
  const agent = await startAgent();
  const hub = await startHub(agent);
  try {
    await run(agent, hub);
  } finally {
    await hub.close();
    await agent.close();
  }
}

test("both project routes refuse a user without admin rights and never ask the agent", async () => {
  await withHub(async (agent, hub) => {
    for (const path of [PREVIEW, CREATE]) {
      const answer = await post(hub, path, "user", { name: "notes", content: DRAFT });
      assert.equal(answer.status, 403);
    }
    assert.deepEqual(agent.seen, []);
  });
});

test("both project routes refuse a cross-site request before the session is read", async () => {
  await withHub(async (agent, hub) => {
    for (const path of [PREVIEW, CREATE]) {
      const answer = await post(hub, path, "admin", { name: "notes", content: DRAFT }, "cross-site");
      assert.equal(answer.status, 403);
    }
    assert.deepEqual(agent.seen, []);
  });
});

test("the preview asks the agent by name with the session's actor and is not cached", async () => {
  await withHub(async (agent, hub) => {
    agent.replies.set("POST /stacks/raw-preview", {
      status: 200,
      body: { projectDir: "/home/docker/notes", stackName: "notes", valid: true, services: ["app"], mountSources: [] }
    });
    const answer = await post(hub, PREVIEW, "admin", { name: "notes", content: DRAFT, projectDir: "/elsewhere" });
    assert.equal(answer.status, 200);
    assert.equal(answer.cache, "no-store");
    assert.equal((answer.json.preview as Record<string, unknown>).projectDir, "/home/docker/notes");
    const call = agent.seen.find((entry) => entry.url === "/stacks/raw-preview");
    assert.deepEqual(JSON.parse(call?.body ?? "{}"), { name: "notes", content: DRAFT });
    assert.match(call?.actor ?? "", /admin-1/);
  });
});

test("a create reconciles the registry and answers with the project", async () => {
  await withHub(async (agent, hub) => {
    agent.replies.set("POST /stacks/raw", { status: 200, body: { ok: true } });
    const answer = await post(hub, CREATE, "admin", { name: "notes", content: DRAFT, confirmNew: ["app"] });
    assert.equal(answer.status, 200);
    assert.equal(answer.cache, "no-store");
    assert.deepEqual(answer.json, {
      outcome: {
        kind: "created",
        project: { ok: true },
        resync: { status: "synced", error: null }
      }
    });
    assert.deepEqual(hub.resyncs, [HOST.id]);
  });
});

test("a follow-up question of the agent is a 200 with the list, without reconciling", async () => {
  await withHub(async (agent, hub) => {
    agent.replies.set("POST /stacks/raw", {
      status: 409,
      body: { error: "external-source-confirmation-missing", externalSources: ["/mnt/user/media"], projectDirRemoved: true }
    });
    const answer = await post(hub, CREATE, "admin", { name: "notes", content: DRAFT });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, {
      outcome: {
        kind: "question",
        question: { kind: "external-sources", sources: ["/mnt/user/media"] },
        projectDirRemoved: true
      }
    });
    assert.deepEqual(hub.resyncs, []);
  });
});

test("a refused create keeps the agent's cleanup flag next to the translated reason", async () => {
  await withHub(async (agent, hub) => {
    agent.replies.set("POST /stacks/raw", {
      status: 409,
      body: { error: "file-already-exists", rolledBack: true, projectDir: "/home/docker/notes", projectDirRemoved: false }
    });
    const answer = await post(hub, CREATE, "admin", { name: "notes", content: DRAFT });
    assert.equal(answer.status, 409);
    assert.equal(answer.json.reason, "file-already-exists");
    assert.equal(answer.json.projectDirRemoved, false);

    agent.replies.set("POST /stacks/raw", { status: 409, body: { error: "directory-taken" } });
    const taken = await post(hub, CREATE, "admin", { name: "notes", content: DRAFT });
    assert.equal(taken.json.reason, "directory-taken");
    assert.equal("projectDirRemoved" in taken.json, false);
  });
});
