import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_LOG_SETTINGS } from "../features/logs/index.js";
import { DEFAULT_GLOBAL_THEME, logSettingsResponseSchema } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die Route der Logansicht (#5, Etappe G) — über echte Anfragen durch den
// echten Router, wie `theme-routes.test.ts` es für Thema und Netz tut.
//
// ⚠️ WAS OHNE POSTGRES GEPRÜFT WERDEN KANN und hier geprüft wird:
//   - dass `GET /settings` die Einstellung unter `logs` mitträgt;
//   - dass `PUT /settings/logs` einen der vier erlaubten Werte schreibt;
//   - dass ein unbekannter Wert (501) einen 400 ergibt UND NICHTS schreibt —
//     der Fall, den ein Test hielte, der nur den Statuscode läse: ein
//     Handler, der erst schreibt und dann ablehnt, bliebe damit grün;
//   - die Entscheidung zu einer Zahl als Zeichenkette (`"500"`): sie wird
//     abgelehnt, siehe die Begründung beim Test unten;
//   - dass ein Benutzer ohne Adminrechte einen 403 bekommt und nichts
//     schreibt.
//
// ⚠️ WAS OHNE POSTGRES UNGEPRÜFT BLEIBT: dass das SQL selbst richtig ist —
// dazu `server/src/platform/db/migrations/010-log-tail-lines.sql` und der `CHECK`
// darin, gegen eine echte Datenbank.

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
function fakePool(): Pool & { logs: { tailLines: number } } {
  const theme: Record<string, string> = { ...DEFAULT_GLOBAL_THEME };
  const network: { externalEndpoint: string | null } = { externalEndpoint: null };
  const logs: { tailLines: number } = { tailLines: DEFAULT_LOG_SETTINGS.tailLines };
  const pool = {
    logs,
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
        return Promise.resolve({ rows: [{ show_system: false }], rowCount: 1 });
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
  return pool as unknown as Pool & { logs: { tailLines: number } };
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

type Running = { port: number; logs: { tailLines: number }; close: () => Promise<void> };

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
  return { port: api.port, logs: pool.logs, close: api.close };
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

test("GET /settings trägt die Zeilenzahl der Logansicht unter „logs“", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "GET", "/settings");
    assert.equal(status, 200);
    assert.deepEqual(body.logs, DEFAULT_LOG_SETTINGS);
  } finally {
    await running.close();
  }
});

test("PUT /settings/logs schreibt einen der vier erlaubten Werte", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/logs", { logs: { tailLines: 1000 } });
    assert.equal(status, 200);
    // The web parses this response against the contract (#248).
    const parsed = logSettingsResponseSchema.safeParse(body);
    assert.ok(parsed.success, `PUT /settings/logs does not match logSettingsResponseSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data, body);
    assert.deepEqual(body.logs, { tailLines: 1000 });
    assert.equal(running.logs.tailLines, 1000);
  } finally {
    await running.close();
  }
});

test("PUT /settings/logs lehnt 501 ab und schreibt NICHTS", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/logs", { logs: { tailLines: 501 } });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
    // ⚠️ Die eigentliche Aussage: die Ablage trägt nach der Ablehnung noch
    // die Vorgabe und nicht 501. Ein Test, der nur den Statuscode läse, bliebe
    // grün, wenn der Handler erst schreibt und dann erst ablehnt.
    assert.equal(running.logs.tailLines, DEFAULT_LOG_SETTINGS.tailLines);
  } finally {
    await running.close();
  }
});

test("PUT /settings/logs lehnt „500“ als Zeichenkette ab und schreibt NICHTS", async () => {
  // ⚠️ ENTSCHEIDUNG: eine Zeichenkette wird NICHT in eine Zahl umgewandelt,
  // selbst wenn ihr Inhalt einer der vier erlaubten Werte wäre. Dieselbe
  // Haltung wie `normalizeExternalEndpoint` (dort: nur `string`, hier: nur
  // `number`) — ein JSON-Rumpf, der eine Zahl meint, schickt eine Zahl.
  // Diese Entscheidung hätte auch anders ausfallen können (großzügige
  // Koerzision); sie fiel hier zugunsten der Konsistenz mit dem übrigen
  // Bestand (`domain/hosts/host-store.ts`, `config.ts`: durchweg `typeof value === "number"`
  // ohne Umwandlung).
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/logs", { logs: { tailLines: "500" } });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
    assert.equal(running.logs.tailLines, DEFAULT_LOG_SETTINGS.tailLines);
  } finally {
    await running.close();
  }
});

test("PUT /settings/logs verlangt Adminrechte", async () => {
  const running = await start("user");
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/logs", { logs: { tailLines: 1000 } });
    assert.equal(status, 403);
    assert.equal(running.logs.tailLines, DEFAULT_LOG_SETTINGS.tailLines, "nichts davon ist angekommen");
    // Lesen darf er: nach #17 schreibt ein Administrator, lesen alle.
    const read = await call(running.port, "GET", "/settings");
    assert.equal(read.status, 200);
    assert.equal(body.error, "admin-required");
  } finally {
    await running.close();
  }
});
