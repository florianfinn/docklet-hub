import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Pool } from "pg";
import { CONTRACT_VERSION, DEFAULT_HOST_THEME } from "contract";
import type { Auth } from "../platform/auth/auth.js";
import type { HostRecord, HostRepository, AgentHealth } from "../domain/hosts/index.js";
import type { LiveEvents, RefreshTarget } from "../domain/live-events/index.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";
import { createApiRouter } from "./router.js";

export async function lifecycleFixture() {
  const state: { role: string | null; health: AgentHealth; status: number; body: unknown } = {
    role: "admin",
    health: { reachable: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: false, entries: 1 },
    status: 200, body: { ok: true }
  };
  const calls: { method: string; path: string; actor: string | undefined; body: unknown }[] = [];
  const refreshes: RefreshTarget[] = [];
  let probes = 0;
  const agentApp = express(); agentApp.use(express.json());
  agentApp.use((request, response) => {
    calls.push({ method: request.method, path: request.path, actor: request.header("x-docker-agent-actor"), body: request.body });
    response.status(state.status).json(state.body);
  });
  const agent = http.createServer(agentApp); await listenOnFetchablePort(agent);
  const host = { id: "demo-host", name: "Demo", kind: "local", state: "registered", display: DEFAULT_HOST_THEME,
    agentUrl: `http://127.0.0.1:${(agent.address() as AddressInfo).port}` } as HostRecord;
  const app = express(); app.use(express.json());
  app.use("/api", createApiRouter({
    pool: { query: async () => ({ rows: [{ agent_secret: null }] }) } as unknown as Pool,
    repository: { find: async () => host, list: async () => [host] } as unknown as HostRepository,
    agentSecret: "s".repeat(32), enrollment: {} as never,
    config: { wireguardEndpoint: "hub.example.org", wireguardPort: 51821 },
    auth: { api: { getSession: async () => state.role ? { user: { id: "demo-human", role: state.role } } : null } } as unknown as Auth,
    probeHost: async () => { probes++; return state.health; },
    liveEvents: { refresh: async (_id: string, target: RefreshTarget) => { refreshes.push(target); return []; } } as unknown as LiveEvents
  }));
  const server = http.createServer(app); await listenOnFetchablePort(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hosts/demo-host`;
  const stop = (service: http.Server) => new Promise<void>((resolve) => { service.closeAllConnections(); service.close(() => resolve()); });
  return { state, calls, refreshes, get probes() { return probes; },
    call: async (method: string, path: string, body?: unknown, origin = "same-origin") => {
      const response = await fetch(url + path, { method, headers: { "content-type": "application/json", "sec-fetch-site": origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
    }, close: async () => { await stop(server); await stop(agent); }
  };
}
