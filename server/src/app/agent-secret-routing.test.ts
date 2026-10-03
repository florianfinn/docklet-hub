import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import { CONTRACT_VERSION, SECRET_HEADER } from "contract";
import type { Auth } from "../platform/auth/auth.js";
import type { HostRecord, HostRepository } from "../domain/hosts/index.js";
import { createApiRouter } from "./router.js";
import { DEFAULT_HOST_THEME } from "contract";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Welches Geheimnis bei welchem Arm ankommt — über echte Anfragen durch den
// echten Router (#77).
//
// ⚠️ ZWEI ARME MIT ZWEI VERSCHIEDENEN GEHEIMNISSEN IN EINEM LAUF, und die
// Zusicherung fragt, WELCHES wo ankam. Ein Test mit einem Arm beweist hier
// nichts: der Fehler, den diese Fläche hatte, war „beide bekommen dasselbe",
// und der ist mit einem Arm unsichtbar. Zwei Arme mit demselben Wert wären
// ebenso grün und ebenso blind.
//
// Der lokale Arm bekommt das Geheimnis aus der Umgebung (`agentSecret` der
// `ApiOptions`), der angebundene das aus SEINER Zeile
// (`readHostAgentSecret`) — und ein angebundener ohne Zeileneintrag bekommt
// gar keines, sondern eine Meldung in seiner Zeile. Das ist die Bedingung,
// die still bricht: ein Rückfall auf die Umgebung bei jedem `null` sähe
// richtig aus und schickte einem fremden Arm wieder das falsche Geheimnis.
//
// Ohne Postgres und ohne Agenten: der Pool ist erfunden, der Agent ist ein
// kleiner Zuhörer auf 127.0.0.1, der die Kopfzeile mitschreibt.

const LOCAL_ENV_SECRET = "secret-der-umgebung-des-lokalen-arms";
const REMOTE_ROW_SECRET = "secret-aus-der-zeile-des-angebundenen-arms";

type Listener = { port: number; close: () => Promise<void> };

async function listen(server: http.Server): Promise<Listener> {
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

// Ein Zuhörer für alle Arme. `agentGet` hängt den Pfad an die Basis-URL an,
// deshalb genügt ein Server mit einem Präfix je Arm — und die Zuordnung
// „welche Kopfzeile kam von welchem Arm" ist damit die des Pfads.
async function startAgent(): Promise<Listener & { secretsSeen: Map<string, string[]> }> {
  const secretsSeen = new Map<string, string[]>();
  const server = http.createServer((request, response) => {
    const [, arm = "", route = ""] = (request.url ?? "").split("/");
    if (route === "containers") {
      const seen = secretsSeen.get(arm) ?? [];
      seen.push(String(request.headers[SECRET_HEADER] ?? ""));
      secretsSeen.set(arm, seen);
    }
    response.setHeader("content-type", "application/json");
    response.end(
      route === "health"
        ? JSON.stringify({ ok: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: true })
        : JSON.stringify({ containers: [] })
    );
  });
  const listener = await listen(server);
  return { ...listener, secretsSeen };
}

function record(overrides: Partial<HostRecord> & { id: string; name: string; agentUrl: string }): HostRecord {
  return {
    kind: "internal",
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
    lastSeenAt: null,
    ...overrides
  };
}

// Der Pool antwortet auf zwei Abfragen: die von `readHostAgentSecret` und die
// zwei leeren Antworten, mit denen `readHostDecoration` seit D7b (#62) die
// Marken eines Arms holt. Alles andere ist hier ein Fehler und soll einer
// bleiben.
//
// ⚠️ Die Marken stehen hier nur deshalb, weil `GET /overview` sie mitholt.
// Sie sind NICHT der Gegenstand dieses Wächters — er prüft, welches Geheimnis
// an welchen Arm geht. Eine leere Antwort ist deshalb richtig und nicht faul:
// dieser Test vergibt keine Marken.
function fakePool(secrets: Map<string, string | null>): Pool {
  return {
    query(text: string, values: unknown[] = []) {
      if (/FROM mark_assignment/.test(text) || /FROM stack_display/.test(text)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (!/SELECT agent_secret/.test(text)) {
        throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
      }
      const id = String(values[0]);
      return Promise.resolve({ rows: [{ agent_secret: secrets.get(id) ?? null }], rowCount: 1 });
    }
  } as unknown as Pool;
}

function fakeAuth(): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({ user: { id: "admin-1", name: "admin", email: "admin@example.org", role: "admin" } })
    }
  } as unknown as Auth;
}

function fakeRepository(records: HostRecord[]): HostRepository {
  return {
    list: () => Promise.resolve(records),
    find: (id: string) => Promise.resolve(records.find((entry) => entry.id === id) ?? null)
  } as unknown as HostRepository;
}

type Stack = {
  apiPort: number;
  secretsSeen: Map<string, string[]>;
  close: () => Promise<void>;
};

async function stack(options: { remoteSecret: string | null }): Promise<Stack> {
  const agent = await startAgent();
  const base = `http://127.0.0.1:${agent.port}`;
  const records = [
    record({ id: "local-1", name: "hub", agentUrl: `${base}/local`, kind: "local" }),
    record({ id: "remote-1", name: "local-host", agentUrl: `${base}/remote`, kind: "internal" })
  ];

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(new Map([["remote-1", options.remoteSecret]])),
      repository: fakeRepository(records),
      enrollment: {} as never,
      agentSecret: LOCAL_ENV_SECRET,
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
    })
  );
  const api = await listen(http.createServer(app));

  return {
    apiPort: api.port,
    secretsSeen: agent.secretsSeen,
    close: async () => {
      await api.close();
      await agent.close();
    }
  };
}

async function call(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    headers: {
      // Was der Browser der eigenen Oberfläche bei jeder Anfrage
      // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
      // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
      // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
      // dieser Fall prüft etwas anderes.
      "sec-fetch-site": "same-origin"
    }
  });
  return { status: response.status, body: await response.json() };
}

test("GET /overview schickt jedem Arm SEIN Geheimnis, nicht beiden dasselbe", async () => {
  const running = await stack({ remoteSecret: REMOTE_ROW_SECRET });
  try {
    const { status } = await call(running.apiPort, "/overview");
    assert.equal(status, 200);

    assert.deepEqual(running.secretsSeen.get("local"), [LOCAL_ENV_SECRET]);
    assert.deepEqual(running.secretsSeen.get("remote"), [REMOTE_ROW_SECRET]);
    // Die eigentliche Aussage, noch einmal ausdrücklich: die beiden Werte
    // sind verschieden. Ein Test, der beide Arme mit demselben Geheimnis
    // ausstattet, liefe hier grün durch, ohne etwas zu zeigen.
    assert.notEqual(LOCAL_ENV_SECRET, REMOTE_ROW_SECRET);
  } finally {
    await running.close();
  }
});

test("GET /hosts/:hostId/containers nimmt dasselbe Geheimnis wie die Übersicht", async () => {
  const running = await stack({ remoteSecret: REMOTE_ROW_SECRET });
  try {
    const local = await call(running.apiPort, "/hosts/local-1/containers");
    const remote = await call(running.apiPort, "/hosts/remote-1/containers");
    assert.equal(local.status, 200);
    assert.equal(remote.status, 200);

    assert.deepEqual(running.secretsSeen.get("local"), [LOCAL_ENV_SECRET]);
    assert.deepEqual(running.secretsSeen.get("remote"), [REMOTE_ROW_SECRET]);
  } finally {
    await running.close();
  }
});

test("ein angebundener Arm ohne Secret bekommt eine Meldung und NICHT das der Umgebung", async () => {
  // Der Fehler aus #77 in neuer Verkleidung: ein Rückfall auf die Umgebung
  // bei jedem `null` wäre grün in jedem anderen Test und schickte hier das
  // falsche Geheimnis hinaus.
  const running = await stack({ remoteSecret: null });
  try {
    const { status, body } = await call(running.apiPort, "/overview");
    assert.equal(status, 200);

    const hosts = (body as { hosts: { host: { id: string }; error: string | null }[] }).hosts;
    const local = hosts.find((entry) => entry.host.id === "local-1");
    const remote = hosts.find((entry) => entry.host.id === "remote-1");

    // Die Fläche fällt nicht um: der lokale Arm antwortet wie immer.
    assert.equal(local?.error, null);
    // Der angebundene trägt die Meldung in SEINER Zeile.
    assert.match(String(remote?.error), /kein Agent-Secret hinterlegt/);

    // Und es ging gar keine Anfrage an ihn hinaus — schon gar nicht mit dem
    // Geheimnis des lokalen Arms.
    assert.equal(running.secretsSeen.get("remote"), undefined);
    assert.deepEqual(running.secretsSeen.get("local"), [LOCAL_ENV_SECRET]);
  } finally {
    await running.close();
  }
});
