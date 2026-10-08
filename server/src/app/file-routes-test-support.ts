import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { AgentHealth, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import { DEFAULT_HOST_THEME } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// The harness of the file surface: a small listener on 127.0.0.1 as the agent,
// the real router behind real Express, and a caller that imitates the own UI.
// Moved out of `file-routes.test.ts` in #248, when the schema cases for the
// file routes (`file-routes-contract.test.ts`) needed the same harness and the
// file stood at 970 lines — the same move as `exec-test-support.ts`.

export const HOST: HostRecord = {
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

export const ROW_SECRET = "das-secret-aus-der-zeile-des-arms";
export const ROLE_HEADER = "x-test-role";
export const CONTAINER_ID = "c0ffee";
export const CONTAINER_NAME = "immich";
export const SHARE = "immich/library";

// One version at the mark (0.32.0 since #279) and one far below it. They stand
// for "recent enough" and "too old".
export const CURRENT: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 13, readOnly: false, entries: null };
export const ANCIENT: AgentHealth = { reachable: true, version: "0.6.0", contractVersion: null, readOnly: false, entries: null };
export const GONE: AgentHealth = { reachable: false, error: "keine Verbindung" };

// ── The agent ───────────────────────────────────────────────────────────────

export type AgentReply = {
  status: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
  /**
   * An answer that never ends: 64 KiB blocks for as long as the connection
   * takes them (`FakeAgent.endless` counts them and notes the close). The
   * stand-in for a file of any size, which the agent does not cap.
   */
  endless?: boolean;
};

export type FakeAgent = {
  port: number;
  /** Reply per path without query — the test sets what it needs. */
  replies: Map<string, AgentReply>;
  seen: { method: string; url: string; actor: string | undefined; secret: string | undefined; body: string }[];
  /** The blocks an `endless` answer has written, and whether its connection is closed. */
  endless: { blocks: number; closed: boolean };
  close: () => Promise<void>;
};

export const ENDLESS_BLOCK_BYTES = 64 * 1024;

export async function startAgent(): Promise<FakeAgent> {
  const state: FakeAgent = {
    port: 0,
    replies: new Map(),
    seen: [],
    endless: { blocks: 0, closed: false },
    close: async () => undefined
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      state.seen.push({
        method: request.method ?? "",
        url,
        actor: request.headers["x-docker-agent-actor"] as string | undefined,
        secret: request.headers["x-docker-agent-secret"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8")
      });
      const path = url.split("?")[0] ?? "";
      const reply = state.replies.get(`${request.method} ${path}`);
      if (!reply) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `unerwartet: ${request.method} ${path}` }));
        return;
      }
      if (reply.endless) {
        response.writeHead(reply.status, { "content-type": "application/octet-stream" });
        response.on("close", () => {
          state.endless.closed = true;
        });
        const block = Buffer.alloc(ENDLESS_BLOCK_BYTES, 1);
        const pump = (): void => {
          while (!response.destroyed) {
            state.endless.blocks += 1;
            if (!response.write(block)) {
              response.once("drain", pump);
              return;
            }
          }
        };
        pump();
        return;
      }
      if (reply.raw !== undefined) {
        response.writeHead(reply.status, {
          "content-type": "application/octet-stream",
          "content-length": String(Buffer.byteLength(reply.raw)),
          ...reply.headers
        });
        response.end(reply.raw);
        return;
      }
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(JSON.stringify(reply.body ?? {}));
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

/** The container list every route of this surface fetches first. */
export function withContainer(agent: FakeAgent, entries?: unknown[]): void {
  agent.replies.set("GET /containers", {
    status: 200,
    body: {
      containers: entries ?? [
        {
          id: CONTAINER_ID,
          name: CONTAINER_NAME,
          image: "ghcr.io/immich-app/immich-server:v1",
          status: "running",
          running: true
        }
      ]
    }
  });
}

// ── The hub ─────────────────────────────────────────────────────────────────

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

export type Store = { share: string | null; writes: string[] };

// ⚠️ Same stance as `fakePool` in `container-routes.test.ts`: a statement this
// fake does not recognise throws — and stays that way. A pool that answers
// everything with an empty result turns a test green that talks to the wrong
// table.
function fakePool(store: Store): Pool {
  return {
    query: (text: string, values: unknown[] = []) => {
      if (/^\s*SELECT agent_secret FROM docker_host/s.test(text)) {
        return Promise.resolve({ rows: [{ agent_secret: ROW_SECRET }], rowCount: 1 });
      }
      if (/^\s*SELECT container_name, share_path FROM container_share/s.test(text)) {
        return Promise.resolve(
          store.share === null
            ? { rows: [], rowCount: 0 }
            : { rows: [{ container_name: String(values[1]), share_path: store.share }], rowCount: 1 }
        );
      }
      if (/^\s*INSERT INTO container_share/s.test(text)) {
        store.share = String(values[2]);
        store.writes.push(`set:${String(values[1])}=${store.share}`);
        return Promise.resolve({ rows: [{ container_name: String(values[1]), share_path: store.share }], rowCount: 1 });
      }
      if (/^\s*DELETE FROM container_share/s.test(text)) {
        store.share = null;
        store.writes.push(`remove:${String(values[1])}`);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  } as unknown as Pool;
}

export type Hub = { port: number; store: Store; close: () => Promise<void> };

export async function startHub(
  options: { agent?: FakeAgent; host?: HostRecord | null; health?: AgentHealth; share?: string | null } = {}
): Promise<Hub> {
  const store: Store = { share: options.share ?? null, writes: [] };
  const host =
    options.host === undefined
      ? { ...HOST, agentUrl: `http://127.0.0.1:${options.agent?.port ?? 0}` }
      : options.host;

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(store),
      repository: {
        find: (id: string) => Promise.resolve(host && host.id === id ? host : null),
        list: () => Promise.resolve(host ? [host] : [])
      } as unknown as HostRepository,
      enrollment: {} as unknown as Enrollment,
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
      // Injected instead of probed: reachability is a precondition of the
      // case here, not a measurement.
      probeHost: () => Promise.resolve(options.health ?? CURRENT)
    })
  );
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    store,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

export function url(hub: Hub, tail: string, containerId = CONTAINER_ID): string {
  return `http://127.0.0.1:${hub.port}/api/hosts/host-1/containers/${containerId}/${tail}`;
}

// ⚠️ `sec-fetch-site: same-origin` belongs to it: all four reading routes of
// this surface are in `GET_ROUTES_WITH_EFFECT` (`platform/http/request-origin.ts`), and
// the writing ones are checked anyway. This caller imitates the browser of the
// own UI, which sets the header. A call WITHOUT it is a case of its own in
// `file-routes.test.ts`.
export function call(
  target: string,
  options: {
    role?: "admin" | "user";
    method?: string;
    body?: unknown;
    raw?: string;
    /** The text editor's body — the same path as `raw`, only as text. */
    text?: string;
    /** Bytes that are deliberately NOT valid UTF-8. */
    bytes?: Uint8Array<ArrayBuffer>;
    origin?: boolean;
    contentType?: string;
    signal?: AbortSignal;
  } = {}
): Promise<globalThis.Response> {
  const headers: Record<string, string> = { [ROLE_HEADER]: options.role ?? "admin" };
  if (options.origin !== false) headers["sec-fetch-site"] = "same-origin";
  // ⚠️ `BodyInit` and not `string | Uint8Array`, and the bytes carry their
  // buffer type (`Uint8Array<ArrayBuffer>`): a `Uint8Array` with the default
  // parameter `ArrayBufferLike` is not a body in the `fetch` typings of this
  // version (TS2769), the same with `ArrayBuffer` is.
  let body: BodyInit | undefined;
  if (options.bytes !== undefined) {
    headers["content-type"] = "text/plain; charset=utf-8";
    body = options.bytes;
  } else if (options.text !== undefined) {
    headers["content-type"] = "text/plain; charset=utf-8";
    body = options.text;
  } else if (options.raw !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = options.raw;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  return fetch(target, { method: options.method ?? "GET", headers, body, signal: options.signal });
}
