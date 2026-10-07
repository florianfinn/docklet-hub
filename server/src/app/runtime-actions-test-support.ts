import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { DEFAULT_HOST_THEME, CONTRACT_VERSION, type RuntimeAction, type LiveStatus,
  type HubContainerRuntimeResult, type HubStackRuntimeResult, type ExpectedStack } from "contract";
import type { Auth } from "../platform/auth/auth.js";
import type { HostRecord, HostRepository, AgentHealth } from "../domain/hosts/index.js";
import type { LiveEvents, RefreshTarget } from "../domain/live-events/index.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";
import { createApiRouter } from "./router.js";
import type { Pool } from "pg";

export const ID = "a".repeat(64);
export const EXPECTED = { containerId: ID, status: "running", startedAt: "2026-10-06T12:00:00Z" };
export const STACK: ExpectedStack = { projectName: "demo", projectDir: "/srv/example/demo",
  composeFileName: "compose.yml", services: [{ serviceName: "web", ...EXPECTED }] };
export function containerResult(action: RuntimeAction = "start"): HubContainerRuntimeResult {
  return { ok: true, action, outcome: "ok", state: { ...EXPECTED, exitCode: null, health: "healthy" } };
}
export function stackResult(action: RuntimeAction = "start", applyDefinition = true): HubStackRuntimeResult {
  return { ok: true, action, applyDefinition, outcome: "ok",
    services: [{ serviceName: "web", ...containerResult(action).state, outcome: "ok" }], containerIds: { web: ID } };
}
export type AgentCall = { path: string; body: unknown; actor: string | undefined; secret: string | undefined; signal?: AbortSignal };
export async function fixture() {
  const state: { role: string | null; health: AgentHealth; live: LiveStatus; mode: boolean; host: boolean;
    agent: (request: express.Request, response: express.Response) => void } = {
    role: "admin", health: { reachable: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: false, entries: 1 },
    live: "connected", mode: true, host: true,
    agent: (request, response) => {
      const action = String(request.params.action).replace(/-stream$/, "") as RuntimeAction;
      if (request.path.startsWith("/containers/")) response.json(containerResult(action));
      else {
        response.type("application/x-ndjson");
        response.end(JSON.stringify({ kind: "result", status: 200,
          body: stackResult(action, request.body.applyDefinition ?? false) }) + "\n");
      }
    }
  };
  const calls: AgentCall[] = [];
  const refreshes: { hostId: string; target: RefreshTarget }[] = [];
  let probes = 0;
  const agentApp = express();
  agentApp.use(express.json());
  agentApp.use((request, _response, next) => {
    calls.push({ path: request.path, body: request.body, actor: request.header("x-docker-agent-actor"),
      secret: request.header("x-docker-agent-secret") }); next();
  });
  agentApp.get("/containers", (_request, response) => response.json({ containers: [{ id: ID, name: "demo-web",
    image: "nginx:1.27", status: "running", running: true, startedAt: EXPECTED.startedAt,
    compose: { project: "demo", service: "web" }, externalManagement: { manager: "unraid-compose" } }] }));
  agentApp.post("/containers/:id/:action", (request, response) => state.agent(request, response));
  agentApp.post("/stacks/:id/actions/:action", (request, response) => state.agent(request, response));
  const agent = http.createServer(agentApp);
  await listenOnFetchablePort(agent);
  const host = { id: "demo-host", name: "Demo", agentUrl: `http://127.0.0.1:${(agent.address() as AddressInfo).port}`,
    kind: "local", state: "registered", display: DEFAULT_HOST_THEME } as HostRecord;
  const storage = { state: { applyComposeDefinition: true } };
  const pool = { query: async (sql: string) => {
    if (sql.includes("agent_secret")) return { rows: [{ agent_secret: null }] };
    if (!sql.startsWith("SELECT apply_compose_definition")) throw new Error("Unexpected SQL");
    return { rows: [{ apply_compose_definition: storage.state.applyComposeDefinition }] };
  } } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({ pool, agentSecret: "s".repeat(32),
    repository: { find: async () => state.host ? host : null, list: async () => [host] } as unknown as HostRepository,
    auth: { api: { getSession: async () => state.role ? { user: { id: "demo-human", name: "Demo", email: "demo@example.org",
      role: state.role } } : null } } as unknown as Auth,
    enrollment: {} as never, config: { wireguardEndpoint: "hub.example.org", wireguardPort: 51821 },
    probeHost: async () => { probes += 1; return state.health; },
    liveEvents: { hostStatus: () => state.live,
      refresh: async (hostId: string, target: RefreshTarget) => { refreshes.push({ hostId, target }); return []; } } as unknown as LiveEvents
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void error; response.status(500).json({ error: "test-unhandled" });
  });
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const stop = (service: http.Server) => new Promise<void>((resolve, reject) => {
    service.closeAllConnections(); service.close((error) => error ? reject(error) : resolve());
  });
  return { state, calls, refreshes, storage, get probes() { return probes; }, url,
    call: async (stack = false, action = "start", body: unknown = stack ? { expectedStack: STACK } : { expectedContainer: EXPECTED },
      origin = "same-origin") => {
      storage.state.applyComposeDefinition = state.mode;
      const response = await fetch(`${url}/hosts/demo-host/${stack ? "stacks" : "containers"}/${ID}/${stack ? "actions/" : ""}${action}`,
        { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": origin }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: response.headers.get("content-type")?.includes("application/x-ndjson")
        ? text.trim().split("\n").map((line) => JSON.parse(line)) : JSON.parse(text), text };
    }, close: async () => { await stop(server); await stop(agent); }
  };
}
