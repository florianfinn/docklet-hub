import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { HostRepository } from "../domain/hosts/index.js";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// `GET /users` über echte Anfragen: wer sie bekommt, wer nicht, und was drin
// steht.
//
// ⚠️ Warum das ein AUSFÜHRUNGSTEST sein muss und kein Textabgleich: der
// Wächter `web/tests/api-read-only.test.mjs` liest, ob `requireAdmin`
// unmittelbar hinter dem Pfad steht — er kann nicht sehen, ob die
// Zwischenschicht auch wirklich abweist. Die Route ist lesend, und die
// Versuchung, eine lesende Route „erst mal offen" zu lassen, ist genau der
// Fehler, den #17 benennt: die Konten-Liste sagt, wer sonst noch ein Konto
// auf diesem Hub hat, wann er zuletzt da war und wie viele Sitzungen offen
// sind.

const ROLE_HEADER = "x-test-role";

const ACCOUNTS = [
  {
    id: "user-1",
    name: "Florian",
    email: "florian@example.org",
    role: "admin",
    last_sign_in_at: new Date("2026-09-04T18:30:00.000Z"),
    session_count: "2"
  },
  {
    id: "user-2",
    name: "Gast",
    email: "gast@example.org",
    role: "user",
    last_sign_in_at: null,
    session_count: "0"
  }
];

function fakePool(): Pool {
  return {
    query: () => Promise.resolve({ rows: ACCOUNTS, rowCount: ACCOUNTS.length })
  } as unknown as Pool;
}

// Die Rolle kommt aus einer Kopfzeile statt aus better-auth: `requireAdmin`
// löst über `auth.api.getSession` auf, und genau das ist hier die Attrappe.
function fakeAuth(): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        const role = headers.get(ROLE_HEADER);
        if (role !== "admin" && role !== "user") return Promise.resolve(null);
        return Promise.resolve({ user: { id: `${role}-1`, name: role, email: `${role}@example.org`, role } });
      }
    }
  } as unknown as Auth;
}

async function stack(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(),
      repository: {} as unknown as HostRepository,
      enrollment: {} as unknown as Enrollment,
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
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

async function call(port: number, role?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/users`, {
    headers: {
      // Was der Browser der eigenen Oberfläche bei jeder Anfrage
      // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
      // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
      // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
      // dieser Fall prüft etwas anderes.
      "sec-fetch-site": "same-origin",
      ...(role === undefined ? {} : { [ROLE_HEADER]: role })
    }
  });
  return { status: response.status, body: await response.json() };
}

test("ein Admin bekommt die Konten im vereinbarten Vertrag", async () => {
  const running = await stack();
  try {
    const { status, body } = await call(running.port, "admin");
    assert.equal(status, 200);
    assert.deepEqual(body, {
      users: [
        {
          id: "user-1",
          name: "Florian",
          email: "florian@example.org",
          role: "admin",
          lastSignInAt: "2026-09-04T18:30:00.000Z",
          sessionCount: 2
        },
        {
          id: "user-2",
          name: "Gast",
          email: "gast@example.org",
          role: "user",
          lastSignInAt: null,
          sessionCount: 0
        }
      ]
    });
  } finally {
    await running.close();
  }
});

test("ein Benutzer ohne Adminrechte bekommt 403, ein Unangemeldeter 401", async () => {
  const running = await stack();
  try {
    const asUser = await call(running.port, "user");
    assert.equal(asUser.status, 403);
    assert.deepEqual(asUser.body, { error: "admin-required" });

    const anonymous = await call(running.port);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.body, { error: "unauthenticated" });
  } finally {
    await running.close();
  }
});
