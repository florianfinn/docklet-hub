import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_CONTAINER_VIEW_SETTINGS } from "../features/containers/index.js";
import { DEFAULT_LOG_SETTINGS } from "../features/logs/index.js";
import { containerViewSettingsResponseSchema, DEFAULT_GLOBAL_THEME } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die Route „Container des Leitstands zeigen" (`PUT /settings/containers`) —
// über echte Anfragen durch den echten Router, wie
// `settings-logs-routes.test.ts` es für die Logansicht tut. Die Hilfen unten
// sind dieselben, erweitert um die Tabelle `container_view_settings`.
//
// ⚠️ WAS OHNE POSTGRES UNGEPRÜFT BLEIBT: das SQL selbst — dazu
// `server/src/platform/db/migrations/014-container-view-settings.sql`.

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

// Ein erfundener Pool mit genau dem Gedächtnis, das `GET /settings` und
// `PUT /settings/logs` anfassen: die eine Zeile jeder der drei Tabellen, die
// unter `/settings` zusammenlaufen.
//
// ⚠️ Jede Anweisung, die er nicht wiedererkennt, ist hier ein Fehler und soll
// einer bleiben — wie in `theme-routes.test.ts`.
function fakePool(): Pool & { view: { showSystem: boolean } } {
  const theme: Record<string, string> = { ...DEFAULT_GLOBAL_THEME };
  const network: { externalEndpoint: string | null } = { externalEndpoint: null };
  const logs: { tailLines: number } = { tailLines: DEFAULT_LOG_SETTINGS.tailLines };
  const view: { showSystem: boolean } = { ...DEFAULT_CONTAINER_VIEW_SETTINGS };
  const pool = {
    view,
    query(text: string, values: unknown[] = []) {
      if (/^SELECT apply_compose_definition FROM runtime_settings/.test(text))
        return Promise.resolve({ rows: [{ apply_compose_definition: true }], rowCount: 1 });
      if (/^SELECT self_healing_config, self_healing_revision FROM runtime_settings/.test(text))
        return Promise.resolve({ rows: [{ self_healing_config: DEFAULT_SELF_HEALING_CONFIG, self_healing_revision: 1 }], rowCount: 1 });
      if (/FROM docker_host h LEFT JOIN self_healing_delivery/.test(text))
        return Promise.resolve({ rows: [], rowCount: 0 });

      if (/SELECT .* FROM hub_theme/s.test(text)) {
        // ⚠️ Kleingeschriebene Schlüssel, wie Postgres sie liefert, und der
        // gequotete Alias wörtlich (B6/E4, #5). Der lange Grund steht an
        // `postgresRow` in `theme-routes.test.ts`; kurz: eine Attrappe, die
        // freundlichere Schlüssel liefert als das echte System, verdeckt
        // genau den Fehler, den sie prüfen soll. Die Fassung hier ist knapper,
        // weil `GET /settings` nur liest.
        const row: Record<string, string> = {};
        for (const item of /SELECT\s+([\s\S]*?)\s+FROM\s+hub_theme/i.exec(text)![1].split(",")) {
          const parsed = /^\s*([A-Za-z_]\w*)(?:\s+AS\s+"([^"]+)")?\s*$/.exec(item);
          assert.ok(parsed, `Diese Attrappe versteht die Spaltenangabe „${item}" nicht.`);
          const knob = Object.keys(theme).find((name) => name.toLowerCase() === parsed[1].toLowerCase());
          assert.ok(knob, `hub_theme hat keine Spalte „${parsed[1]}" — hier hätte Postgres einen Fehler gemeldet.`);
          row[parsed[2] ?? parsed[1].toLowerCase()] = theme[knob];
        }
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      if (/^\s*SELECT external_endpoint FROM hub_network/s.test(text)) {
        return Promise.resolve({ rows: [{ external_endpoint: network.externalEndpoint }], rowCount: 1 });
      }
      if (/^\s*SELECT show_system FROM container_view_settings/s.test(text)) {
        return Promise.resolve({ rows: [{ show_system: view.showSystem }], rowCount: 1 });
      }
      if (/^\s*INSERT INTO container_view_settings/s.test(text)) {
        view.showSystem = values[0] as boolean;
        return Promise.resolve({ rows: [{ show_system: view.showSystem }], rowCount: 1 });
      }
      if (/^\s*SELECT tail_lines FROM log_settings/s.test(text)) {
        return Promise.resolve({ rows: [{ tail_lines: logs.tailLines }], rowCount: 1 });
      }
      if (/^\s*INSERT INTO log_settings/s.test(text)) {
        logs.tailLines = values[0] as number;
        return Promise.resolve({ rows: [{ tail_lines: logs.tailLines }], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  };
  return pool as unknown as Pool & { view: { showSystem: boolean } };
}

function fakeAuth(role: "admin" | "user"): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({ user: { id: "admin-1", name: "admin", email: "admin@example.org", role } })
    }
  } as unknown as Auth;
}

function fakeRepository(): HostRepository {
  return {
    list: () => Promise.resolve([]),
    find: () => Promise.resolve(null)
  } as unknown as HostRepository;
}

type Running = { port: number; view: { showSystem: boolean }; close: () => Promise<void> };

async function start(role: "admin" | "user" = "admin"): Promise<Running> {
  const pool = fakePool();
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(role),
      pool,
      repository: fakeRepository(),
      enrollment: {} as never,
      agentSecret: "secret-der-umgebung",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
    })
  );
  const api = await listen(http.createServer(app));
  return { port: api.port, view: pool.view, close: api.close };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      // Ohne diese Kopfzeile wäre jede schreibende Anfrage ein 403 durch die
      // Herkunftsprüfung — richtig so, aber dieser Test prüft etwas anderes.
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("GET /settings trägt unter „containers“ die Vorgabe: ausgeblendet", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "GET", "/settings");
    assert.equal(status, 200);
    assert.deepEqual(body.containers, { showSystem: false });
  } finally {
    await running.close();
  }
});

test("PUT /settings/containers schaltet die Container des Leitstands ein", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/containers", { containers: { showSystem: true } });
    assert.equal(status, 200);
    // The web parses this response against the contract (#248).
    const parsed = containerViewSettingsResponseSchema.safeParse(body);
    assert.ok(parsed.success, `PUT /settings/containers does not match containerViewSettingsResponseSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data, body);
    assert.deepEqual(body.containers, { showSystem: true });
    assert.equal(running.view.showSystem, true);
    const read = await call(running.port, "GET", "/settings");
    assert.deepEqual(read.body.containers, { showSystem: true });
  } finally {
    await running.close();
  }
});

test("PUT /settings/containers lehnt „true“ als Text ab und schreibt NICHTS", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/containers", { containers: { showSystem: "true" } });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
    assert.equal(running.view.showSystem, false);
  } finally {
    await running.close();
  }
});

test("PUT /settings/containers verlangt Adminrechte", async () => {
  const running = await start("user");
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/containers", { containers: { showSystem: true } });
    assert.equal(status, 403);
    assert.equal(body.error, "admin-required");
    assert.equal(running.view.showSystem, false, "nichts davon ist angekommen");
  } finally {
    await running.close();
  }
});
