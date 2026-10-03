import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { HostRecord, HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_HOST_THEME } from "contract";
import type { Enrollment } from "../features/hosts/index.js";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die Routen mit WIRKUNG über echte Anfragen: wer durchkommt, wer nicht — und
// vor allem, ob die Wirkung bei den Abgewiesenen ausbleibt.
//
// ⚠️ Warum das ein Ausführungstest sein muss und kein Textabgleich (#78,
// Lücke 2): `web/tests/api-read-only.test.mjs` liest den Quelltext und prüft,
// ob `requireAdmin(` unmittelbar hinter dem Pfad steht. Er hält damit die
// GEWOHNHEIT, nicht die Absicht — ein Umweg über eine Zwischenvariable, eine
// Zwischenschicht, die den Fehlerfall durchreicht, oder ein Handler, der die
// Kennung aus dem Rumpf statt aus der Sitzung nimmt, kommen an ihm vorbei.
// Beides ist nötig: der Textwächter sieht die vergessene Zwischenschicht auch
// dort, wo es noch keinen Test gibt, dieser Test sieht, was sie tut.
//
// ⚠️ Geprüft wird nicht nur der Status, sondern der AUSBLEIBENDE Aufruf. Eine
// 403, nach der die Rotation trotzdem gelaufen ist, wäre die schlimmere
// Fassung des Fehlers: der Aufrufer hält den Arm für unverändert, und sein
// Archiv ist trotzdem ungültig geworden.

const ROLE_HEADER = "x-test-role";

const HOST: HostRecord = {
  id: "host-1",
  name: "unraid",
  agentUrl: "http://10.254.0.2:8099",
  kind: "external",
  state: "pending",
  tunnelAddress: "10.254.0.2",
  wireguardPublicKey: null,
  endpointOverride: null,
  failedAttempts: 0,
  dockerGid: null,
  bindBasePath: null,
  createdAt: new Date("2026-09-06T10:00:00.000Z"),
  registeredAt: null,
  lastSeenAt: null,
  // ⚠️ Beim Zusammenführen von D7a (#62) dazugekommen: `HostRecord` trägt
  // seither die Darstellung, und die ist ein Pflichtfeld. Dieser Prüfling
  // stammt aus #78 und wurde auf einem Zweig gebaut, der D7a nicht kannte —
  // beide Seiten waren einzeln grün, zusammen brach der Typlauf. Der Wert ist
  // die Vorgabe aus der Preset-Datei und keine abgeschriebene Kopie: was der
  // Editor als Ausgangspunkt setzt, setzt auch dieser Prüfling.
  display: DEFAULT_HOST_THEME
};

type Recorded = { statements: { text: string; values: unknown[] }[]; calls: string[] };

// ⚠️ Die leeren Erwartungen tragen ihren Typ und stehen nicht als `[]` im
// Aufruf. `assert.deepEqual` aus `node:assert/strict` ist typseitig ein
// `asserts actual is T`: ein nacktes `[]` engt die Eigenschaft für den REST
// der Funktion auf `never[]` ein, und die nächste Zeile, die einen Eintrag
// liest, wird zum Typfehler (gemessen am 2026-09-06).
const NOTHING_CALLED: Recorded["calls"] = [];
const NOTHING_WRITTEN: Recorded["statements"] = [];

// Die Rolle kommt aus einer Kopfzeile statt aus better-auth: aufgelöst wird
// über `auth.api.getSession`, und genau das ist hier die Attrappe (dasselbe
// Muster wie in `users-route.test.ts`).
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

function fakePool(recorded: Recorded): Pool {
  return {
    query: (text: string, values: unknown[] = []) => {
      recorded.statements.push({ text, values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
  } as unknown as Pool;
}

function fakeEnrollment(recorded: Recorded): Enrollment {
  return {
    enrollHost: () => {
      recorded.calls.push("enrollHost");
      return Promise.resolve({ record: HOST, archive: Buffer.alloc(0) });
    },
    regenerateArchive: () => {
      recorded.calls.push("regenerateArchive");
      return Promise.resolve({ record: HOST, archive: Buffer.from("tar") });
    },
    removeHost: () => {
      recorded.calls.push("removeHost");
      return Promise.resolve();
    }
  } as unknown as Enrollment;
}

async function stack(): Promise<{ port: number; recorded: Recorded; close: () => Promise<void> }> {
  const recorded: Recorded = { statements: [], calls: [] };
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(recorded),
      repository: { find: () => Promise.resolve(HOST), list: () => Promise.resolve([HOST]) } as unknown as HostRepository,
      enrollment: fakeEnrollment(recorded),
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
    })
  );
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    recorded,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

type CallOptions = { method?: string; role?: string; body?: unknown };

async function call(port: number, path: string, options: CallOptions = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      // Was der Browser der eigenen Oberfläche bei jeder Anfrage
      // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
      // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
      // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
      // dieser Fall prüft etwas anderes.
      "sec-fetch-site": "same-origin",
      ...(options.role === undefined ? {} : { [ROLE_HEADER]: options.role }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: response.status, text: await response.text() };
}

test("POST /hosts: ohne Anmeldung 401, als Benutzer 403 — und kein Arm entsteht", async () => {
  const running = await stack();
  try {
    const anonymous = await call(running.port, "/hosts", { method: "POST", body: { name: "neu", kind: "external" } });
    assert.equal(anonymous.status, 401);

    const asUser = await call(running.port, "/hosts", {
      method: "POST",
      role: "user",
      body: { name: "neu", kind: "external", dockerGid: 996, bindBasePath: "/home/docker" }
    });
    assert.equal(asUser.status, 403);

    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "der Bestand wurde nicht angefasst");

    const asAdmin = await call(running.port, "/hosts", {
      method: "POST",
      role: "admin",
      body: { name: "neu", kind: "external", dockerGid: 996, bindBasePath: "/home/docker" }
    });
    assert.equal(asAdmin.status, 201);
    assert.deepEqual(running.recorded.calls, ["enrollHost"]);
  } finally {
    await running.close();
  }
});

test("POST /hosts verlangt die Gruppen-ID — und nimmt die 0", async () => {
  // Seit 008 fragt der Hub die beiden Werte des Zielhosts ab (#4). Sie sind
  // Pflicht und kein Zusatz: das Archiv gibt es genau einmal, und ein Paket
  // mit leerem DOCKER_GID ist ein Paket, das auf dem Zielhost nicht startet.
  // Der Zwang steht deshalb VOR der Erzeugung und nicht danach.
  const running = await stack();
  try {
    const withoutGroupId = await call(running.port, "/hosts", {
      method: "POST",
      role: "admin",
      body: { name: "neu", kind: "external", bindBasePath: "/home/docker" }
    });
    assert.equal(withoutGroupId.status, 400);
    assert.match(withoutGroupId.text, /invalid-input/);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "es wurde trotzdem angelegt");

    // ⚠️ Der Fall, den eine Prüfung auf Wahrheitswert verschluckt: 0 ist die
    // Gruppe root und auf manchem Host die richtige Antwort.
    const mitNull = await call(running.port, "/hosts", {
      method: "POST",
      role: "admin",
      body: { name: "root-host", kind: "external", dockerGid: 0, bindBasePath: "/home/docker" }
    });
    assert.equal(mitNull.status, 201, mitNull.text);
    assert.deepEqual(running.recorded.calls, ["enrollHost"]);
  } finally {
    await running.close();
  }
});

test("POST /hosts weist einen Basispfad ab, der die Compose-Zeile des Arms zerlegt", async () => {
  // Der Wert steht im Paket unmaskiert in `- ${PFAD}:${PFAD}`. Was hier
  // durchkommt, fällt erst auf dem fremden Host beim `compose up` auf — und
  // die Meldung spricht dort von YAML und nicht von diesem Feld.
  const running = await stack();
  try {
    for (const bad of ["/mnt:/mnt", "/mnt/my data", "relativ", "/"]) {
      const response = await call(running.port, "/hosts", {
        method: "POST",
        role: "admin",
        body: { name: "arm", kind: "internal", dockerGid: 996, bindBasePath: bad }
      });
      assert.equal(response.status, 400, `durchgelassen: „${bad}"`);
      assert.match(response.text, /invalid-input/);
    }
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "es wurde trotzdem angelegt");
  } finally {
    await running.close();
  }
});

test("GET /hosts/:id/archive: ein GET mit Wirkung, und der Benutzer löst sie nicht aus", async () => {
  // Die Methode sagt hier nichts: jeder Aufruf rotiert Schlüssel, Secret und
  // Token und setzt den Arm auf `pending` zurück (router.ts, §4). Genau
  // deshalb steht nach der 403 die Prüfung, dass `regenerateArchive` NICHT
  // gelaufen ist.
  const running = await stack();
  try {
    const anonymous = await call(running.port, "/hosts/host-1/archive");
    assert.equal(anonymous.status, 401);

    const asUser = await call(running.port, "/hosts/host-1/archive", { role: "user" });
    assert.equal(asUser.status, 403);

    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "nichts wurde rotiert");

    const asAdmin = await call(running.port, "/hosts/host-1/archive", { role: "admin" });
    assert.equal(asAdmin.status, 200);
    assert.deepEqual(running.recorded.calls, ["regenerateArchive"]);
  } finally {
    await running.close();
  }
});

test("DELETE /hosts/:id: ohne Adminrechte bleibt der Arm stehen", async () => {
  const running = await stack();
  try {
    assert.equal((await call(running.port, "/hosts/host-1", { method: "DELETE" })).status, 401);
    assert.equal((await call(running.port, "/hosts/host-1", { method: "DELETE", role: "user" })).status, 403);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED);

    assert.equal((await call(running.port, "/hosts/host-1", { method: "DELETE", role: "admin" })).status, 204);
    assert.deepEqual(running.recorded.calls, ["removeHost"]);
  } finally {
    await running.close();
  }
});

test("PUT /session/language: ein Benutzer darf, ein Unangemeldeter nicht", async () => {
  // Die eine schreibende Route ohne `requireAdmin` (router.ts). Sie ist keine
  // Tür, sondern anders geprüft — und dass ein Benutzer OHNE Adminrechte hier
  // durchkommt, ist die Zusage selbst: wer die Oberfläche nicht lesen kann,
  // käme sonst nur über den Betreiber zu einer, die er lesen kann.
  const running = await stack();
  try {
    const anonymous = await call(running.port, "/session/language", { method: "PUT", body: { language: "en" } });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(running.recorded.statements, NOTHING_WRITTEN, "ohne Sitzung wird nichts geschrieben");

    const asUser = await call(running.port, "/session/language", {
      method: "PUT",
      role: "user",
      body: { language: "en" }
    });
    assert.equal(asUser.status, 204);
    assert.equal(running.recorded.statements.length, 1);
    assert.deepEqual(running.recorded.statements[0]?.values, ["user-1", "en"]);
  } finally {
    await running.close();
  }
});

test("PUT /session/language: geschrieben wird am Konto der SITZUNG, nicht am Rumpf", async () => {
  // Der Fall, den der Textwächter nicht sehen kann: eine `userId` im Rumpf
  // machte aus dieser Route den Weg, über den ein Benutzer die Oberfläche
  // eines anderen umstellt. Die Kennung muss aus der aufgelösten Sitzung
  // kommen — hier `user-1` und nicht `admin-1`.
  const running = await stack();
  try {
    const response = await call(running.port, "/session/language", {
      method: "PUT",
      role: "user",
      body: { language: "en", userId: "admin-1", id: "admin-1" }
    });
    assert.equal(response.status, 204);
    assert.deepEqual(running.recorded.statements[0]?.values, ["user-1", "en"]);
  } finally {
    await running.close();
  }
});

test("PUT /session/language: eine unbekannte Sprache wird abgewiesen und nicht stillschweigend ersetzt", async () => {
  // `toLanguage` ist fail closed und machte aus „fr" ein „de". Beim LESEN ist
  // das richtig; beim SCHREIBEN wäre es eine Einstellung, die niemand gewählt
  // hat (router.ts). Der Test hält beides: die 400 UND dass nichts geschrieben
  // wurde.
  const running = await stack();
  try {
    const response = await call(running.port, "/session/language", {
      method: "PUT",
      role: "user",
      body: { language: "fr" }
    });
    assert.equal(response.status, 400);
    assert.match(response.text, /invalid-input/);
    assert.deepEqual(running.recorded.statements, NOTHING_WRITTEN);
  } finally {
    await running.close();
  }
});
