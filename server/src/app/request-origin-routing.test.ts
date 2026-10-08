import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { HostRecord, HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_HOST_THEME } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die Herkunftsprüfung über echte Anfragen durch den echten Router.
//
// ⚠️ WAS HIER DER EIGENTLICHE NACHWEIS IST: nicht die 403, sondern der
// AUSBLEIBENDE Aufruf. Eine 403, die erst nach der Wirkung kommt, ist keine
// Schranke, sondern eine Beschriftung — der Aufrufer hält den Arm für
// unverändert, und sein Archiv ist trotzdem ungültig geworden. Jeder
// Ablehnungsfall unten prüft deshalb beides. (Dasselbe Muster wie in
// `write-routes.test.ts`, und aus demselben Grund.)
//
// Warum ZUSÄTZLICH zu `request-origin.test.ts`: der prüft die Bedingungsliste,
// dieser prüft die Verdrahtung — dass die Schranke tatsächlich VOR jeder
// Route unter `/api` hängt und dass ihr der Pfad in der Form erreicht, in der
// die Liste `GET_ROUTES_WITH_EFFECT` geschrieben ist. Beide Hälften einzeln
// richtig und zusammen falsch ist hier der wahrscheinlichste Fehler.

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
  display: DEFAULT_HOST_THEME
};

const NEW_HOST = { name: "neu", kind: "external", dockerGid: 996, bindBasePath: "/home/docker" };

// `calls` sind die Aufrufe der Attrappen mit sprechendem Namen (`enrollHost`
// und seine Geschwister), `queries` die Anweisungen am Verbindungspool.
//
// ⚠️ Die zweite Liste ist nicht dieselbe Sache noch einmal: `PUT
// /session/language` hat keine Fach-Attrappe, an der sich seine Wirkung
// ablesen ließe — es schreibt über `pool.query`
// (`auth/language-store.ts`, die einzige Anweisung dort). Ohne diesen
// Mitschreiber wäre der Nachweis für diese Route auf die 403 beschränkt, und
// genau das ist die Beschriftung statt der Schranke.
type Recorded = { calls: string[]; queries: string[] };

// ⚠️ Die leere Erwartung trägt ihren Typ und steht nicht als `[]` im Aufruf:
// `assert.deepEqual` aus `node:assert/strict` ist typseitig ein
// `asserts actual is T`, und ein nacktes `[]` engte die Eigenschaft für den
// Rest der Funktion auf `never[]` ein.
const NOTHING_CALLED: Recorded["calls"] = [];
const NOTHING_WRITTEN: Recorded["queries"] = [];
const NOTHING_ASKED: AgentContact[] = [];

/** Eine Anfrage, die der Hub an den Arm gestellt hat. */
type AgentContact = { url: string; actor: string | undefined };

// Das Geheimnis, das die Zeile des Arms trägt. Ohne es wirft
// `resolveAgentSecret` für einen angebundenen Arm, und der Log-Strom scheiterte
// VOR dem Arm — der Fall „same-origin erreicht den Arm" wäre dann grün, ohne
// dass er es belegt.
const ROW_SECRET = "das-secret-aus-der-zeile-des-arms";

// Die eine Anweisung, die `PUT /session/language` absetzt. Gefiltert statt
// „gar keine Anweisung": am Verbindungspool hängt mehr als diese Route, und
// eine Erwartung auf die leere Liste zerbräche an der nächsten Abfrage, die
// mit dieser Wirkung nichts zu tun hat.
const LANGUAGE_WRITE = /UPDATE\s+"user"/i;

// Die Rolle kommt aus einer Kopfzeile statt aus better-auth — dasselbe Muster
// wie in `write-routes.test.ts`. Sie steht hier auf `admin`, damit KEIN Fall
// unten versehentlich an `requireAdmin` scheitert statt an der Herkunft: eine
// 403 aus der Rechteprüfung sähe aus wie eine 403 aus der Schranke.
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
    query: (text: string) => {
      recorded.queries.push(text);
      // Die eine Abfrage, die eine echte Antwort braucht: ohne das Geheimnis
      // des Arms wirft `resolveAgentSecret` (`domain/hosts/agent-secret.ts`), und der
      // Log-Strom endete mit einer Fehlermeldung statt am Arm. Alles andere
      // bleibt wie bisher leer — kein Fall dieser Datei liest einen Wert.
      if (/^\s*SELECT agent_secret FROM docker_host/s.test(text)) {
        return Promise.resolve({ rows: [{ agent_secret: ROW_SECRET }], rowCount: 1 });
      }
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

type Running = {
  port: number;
  recorded: Recorded;
  pathsSeen: string[];
  /**
   * Jede Anfrage, die der HUB AN DEN ARM gestellt hat.
   *
   * ⚠️ Das ist für `GET …/logs-stream` der eigentliche Nachweis, und nicht der
   * Statuscode. Der Handler öffnet den Strom zum Arm, BEVOR er den Status
   * vergibt (`container-routes.ts`, `begin()` hängt an `onOpen`) — eine
   * Fassung, die erst den Strom öffnet und dann ablehnt, bliebe an einer
   * Erwartung auf `403` allein grün, und der Platz am Arm wäre trotzdem weg.
   */
  agentSeen: AgentContact[];
  close: () => Promise<void>;
};

/**
 * Der Arm — ein kleiner Zuhörer auf 127.0.0.1, der jede Anfrage mitschreibt
 * und den Strom sofort wieder beendet.
 *
 * ⚠️ Er läuft NUR, wenn ein Fall ihn anfordert. `GET /hosts` fragt die
 * Erreichbarkeit jedes Arms ab (`resolveProbeHost` in `router-support.ts`,
 * hier ohne eigenen `probeHost`), und ein Zuhörer unter der Adresse des Arms
 * sammelte damit in jedem anderen Fall dieser Datei Anfragen ein, die mit dem
 * Log-Strom nichts zu tun haben — `agentSeen` wäre dann kein Nachweis mehr,
 * sondern ein Nebengeräusch.
 */
async function startAgent(seen: AgentContact[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    seen.push({
      url: request.url ?? "",
      actor: request.headers["x-docker-agent-actor"] as string | undefined
    });
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    // Ohne `flushHeaders` gingen die Kopfzeilen erst mit dem `end` hinaus;
    // derselbe Grund wie in `container-routes.test.ts`.
    response.flushHeaders();
    response.end(`${JSON.stringify({ kind: "start", containerName: "immich", tty: false })}\n`);
  });
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

async function stack({ withAgent = false }: { withAgent?: boolean } = {}): Promise<Running> {
  const recorded: Recorded = { calls: [], queries: [] };
  const pathsSeen: string[] = [];
  const agentSeen: AgentContact[] = [];
  const agent = withAgent ? await startAgent(agentSeen) : null;
  const host = agent === null ? HOST : { ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` };
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    // Ein Mitschreiber an DERSELBEN Montagestelle wie der Router: was er in
    // `request.path` sieht, sieht die Schranke auch. Er trifft keine
    // Entscheidung und reicht durch.
    (request, _response, next) => {
      pathsSeen.push(request.path);
      next();
    },
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(recorded),
      repository: {
        find: () => Promise.resolve(host),
        list: () => Promise.resolve([host])
      } as unknown as HostRepository,
      enrollment: fakeEnrollment(recorded),
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
      // With the arm running, its health is injected: the log stream asks for
      // the contract first (`features/logs/service.ts`), and a `/health` in
      // `agentSeen` would be the background noise described above.
      ...(agent === null
        ? {}
        : {
            probeHost: () =>
              Promise.resolve({
                reachable: true as const,
                version: "0.32.0",
                contractVersion: 13,
                readOnly: false,
                entries: null
              })
          })
    })
  );
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    recorded,
    pathsSeen,
    agentSeen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await agent?.close();
    }
  };
}

type CallOptions = {
  method?: string;
  body?: unknown;
  secFetchSite?: string;
  origin?: string;
  referer?: string;
};

// ⚠️ Die Kopfzeilen stehen hier EINZELN und nicht als Vorgabewert: dieser Test
// prüft gerade ihr Fehlen mit. Eine Hilfsfunktion, die stillschweigend
// `same-origin` ergänzte, machte den Fall „ohne beide Kopfzeilen" grün, ohne
// dass die Schranke etwas dazu getan hätte.
async function call(port: number, path: string, options: CallOptions = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      [ROLE_HEADER]: "admin",
      ...(options.secFetchSite === undefined ? {} : { "sec-fetch-site": options.secFetchSite }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.referer === undefined ? {} : { referer: options.referer }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: response.status, text: await response.text() };
}

// ── Die Messung, auf der die Pfadliste steht ────────────────────────────────

test("request.path innerhalb des gemounteten Routers trägt kein /api", async () => {
  // Gemessen statt angenommen. Stünde in `request.path` das Präfix, träfe
  // `GET_ROUTES_WITH_EFFECT` mit seinem `/hosts/:hostId/archive` NIE — und die
  // Lücke sähe aus wie eine geschlossene Tür: eine gepflegte Liste, ein
  // Abgleich, der ins Leere geht.
  const running = await stack();
  try {
    await call(running.port, "/hosts/host-1/archive", { secFetchSite: "same-origin" });
    assert.deepEqual(running.pathsSeen, ["/hosts/host-1/archive"]);
  } finally {
    await running.close();
  }
});

// ── Abgelehnt — und die Wirkung bleibt aus ──────────────────────────────────

test("POST mit Sec-Fetch-Site cross-site ist 403, und der Handler lief nicht", async () => {
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", {
      method: "POST",
      body: NEW_HOST,
      secFetchSite: "cross-site"
    });
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "der Arm wurde trotz 403 angelegt");
  } finally {
    await running.close();
  }
});

test("POST mit Sec-Fetch-Site SAME-SITE ist ebenfalls 403, und der Handler lief nicht", async () => {
  // ⚠️ Der Fall, den `SameSite=Lax` am Sitzungs-Cookie nicht abdeckt: das
  // Hauptdashboard auf einer Nachbar-Subdomain ist keine andere Site. Es ist
  // die naheliegendste Startrampe, die es hier gibt.
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", {
      method: "POST",
      body: NEW_HOST,
      secFetchSite: "same-site"
    });
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "der Arm wurde trotz 403 angelegt");
  } finally {
    await running.close();
  }
});

test("GET /hosts/:hostId/archive mit cross-site ist 403, und die Rotation lief nicht", async () => {
  // Der Fall, den eine Prüfung nach der Methode verlöre: dieser GET rotiert
  // Schlüsselpaar, Agent-Secret und Token. Ein `<img src="…">` auf einer
  // fremden Seite sperrte damit einen Arm aus.
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts/host-1/archive", { secFetchSite: "cross-site" });
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "die Rotation lief trotz 403");
  } finally {
    await running.close();
  }
});

// ⚠️ Die gemessene Lücke, und der Grund für diese Etappe.
//
// Gemessen am 2026-09-07 gegen Express 5.2.1: `/api/HOSTS/abc/ARCHIVE` und
// `/api/Hosts/abc/Archive` antworten beide mit `200` und erreichen den Router
// als `/HOSTS/abc/ARCHIVE` bzw. `/Hosts/abc/Archive` — Express routet in der
// Vorgabe ohne Rücksicht auf Groß- und Kleinschreibung. Solange der Abgleich
// der Schranke zeichengenau war, lautete ihr Urteil auf beide „durchgelassen":
// `<img src="https://hub.example/api/HOSTS/<id>/ARCHIVE">` auf einer fremden
// Seite, geöffnet vom angemeldeten Betreiber, rotierte damit die Schlüssel
// eines Arms, ohne dass irgendwo ein Fehler stand.
//
// Die Schreibweisen unten sind WÖRTLICH die gemessenen. Der zweite Teil jeder
// Zusage — dass der Pfad in dieser Schreibweise überhaupt im Router ankommt —
// steht als eigene Erwartung auf `pathsSeen`: ohne sie wäre ein 403 aus einem
// blossen 404-Zweig nicht zu unterscheiden.

for (const path of ["/HOSTS/host-1/ARCHIVE", "/Hosts/host-1/Archive"]) {
  test(`GET ${path} mit cross-site ist 403, und die Rotation lief nicht`, async () => {
    const running = await stack();
    try {
      const response = await call(running.port, path, { secFetchSite: "cross-site" });
      assert.deepEqual(running.pathsSeen, [path], "Express führte diese Schreibweise gar nicht erst auf den Router");
      assert.equal(response.status, 403, response.text);
      assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "die Rotation lief trotz 403");
    } finally {
      await running.close();
    }
  });
}

// ⚠️ DIE STELLUNG DER SCHRANKE, an der Route, die sie zuerst verlöre.
//
// `createApiRouter` hängt `router.use(requireTrustedOrigin)` an und ruft
// DANACH die Registrierfunktionen auf — `registerSessionRoutes` als ERSTE.
// Express hängt Zwischenschichten in der Reihenfolge ihrer Anmeldung: eine
// als `use` NACH einer Route angemeldete Schicht läuft für diese Route nicht
// mehr. Wer die eine Zeile um eine einzige Position nach unten schiebt, öffnet
// damit genau die Routen aus `features/account/routes.ts` — und darunter
// `PUT /session/language`, die einzige schreibende Route des Routers ohne
// `requireAdmin` (`web/tests/api-read-only.test.mjs`, `SESSION_ONLY_WRITE`).
//
// Gemessen am 2026-09-07 (Etappe B4a-E, #5): mit dieser Verschiebung blieb die
// volle Kette VOLLSTÄNDIG grün — `lint 0`, Server `530/528/2`, Web `187/187/0`,
// Zeichen für Zeichen wie ohne sie. Der Grund war die Auswahl der Fälle, nicht
// ihre Bauart: jeder Ablehnungsfall dieser Datei fuhr auf `/hosts…`, und die
// Host-Routen werden als DRITTE angemeldet — sie stehen auch nach der
// Verschiebung noch hinter der Schranke.
//
// Deshalb hier ein Fall auf der ZUERST angemeldeten Gruppe. Er ist der
// eigentliche Nachweis dieser Etappe; der Textwächter in
// `web/tests/api-read-only.test.mjs` ist die zweite Hälfte und hält nur die
// Gewohnheit.
test("PUT /session/language mit cross-site ist 403, und geschrieben wurde nicht", async () => {
  const running = await stack();
  try {
    const response = await call(running.port, "/session/language", {
      method: "PUT",
      body: { language: "en" },
      secFetchSite: "cross-site"
    });
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(
      running.recorded.queries.filter((query) => LANGUAGE_WRITE.test(query)),
      NOTHING_WRITTEN,
      "die Sprache des angemeldeten Kontos wurde trotz 403 umgestellt"
    );
  } finally {
    await running.close();
  }
});

test("ohne Sec-Fetch-Site und ohne Origin ist es 403, und der Handler lief nicht", async () => {
  // Anders als im Quellsystem, und ausdrücklich so (§1, „Der
  // Maschinen-Aufrufer"): dieser Hub hat keinen Aufrufer ohne Browser über
  // diesen Router. Headerlos ist die billigste Anfrage, die ein Skript
  // stellen kann.
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", { method: "POST", body: NEW_HOST });
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "der Arm wurde trotz 403 angelegt");
  } finally {
    await running.close();
  }
});

// ── Durchgelassen ───────────────────────────────────────────────────────────

test("ein harmloses GET mit cross-site läuft durch", async () => {
  // Ohne Wirkung gibt es nichts auszulösen — eine Schranke, die auch das
  // Lesen abwiese, wäre eine andere Zusage als die aus §1.
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", { secFetchSite: "cross-site" });
    assert.equal(response.status, 200, response.text);
  } finally {
    await running.close();
  }
});

test("POST mit same-origin läuft durch, und der Handler lief", async () => {
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", {
      method: "POST",
      body: NEW_HOST,
      secFetchSite: "same-origin"
    });
    assert.equal(response.status, 201, response.text);
    assert.deepEqual(running.recorded.calls, ["enrollHost"]);
  } finally {
    await running.close();
  }
});

test("PUT /session/language mit same-origin läuft durch, und geschrieben wurde", async () => {
  // ⚠️ Die Gegenprobe zum Ablehnungsfall oben, und sie ist dort nicht
  // Beiwerk: der Nachweis „nichts geschrieben" ist wertlos, solange nicht
  // feststeht, dass dieser Mitschreiber die Anweisung überhaupt sähe. Ein
  // kaputter Filter, ein vertippter Pfad, eine Route, die es nicht mehr gibt —
  // jedes davon machte den Fall oben still grün.
  const running = await stack();
  try {
    const response = await call(running.port, "/session/language", {
      method: "PUT",
      body: { language: "en" },
      secFetchSite: "same-origin"
    });
    assert.equal(response.status, 204, response.text);
    assert.equal(running.recorded.queries.filter((query) => LANGUAGE_WRITE.test(query)).length, 1);
  } finally {
    await running.close();
  }
});

test("POST mit none läuft durch, und der Handler lief", async () => {
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", {
      method: "POST",
      body: NEW_HOST,
      secFetchSite: "none"
    });
    assert.equal(response.status, 201, response.text);
    assert.deepEqual(running.recorded.calls, ["enrollHost"]);
  } finally {
    await running.close();
  }
});

test("ohne Sec-Fetch-Site, aber mit passendem Origin, läuft es durch", async () => {
  // Ein Browser ohne diesen Kopf ist alt, nicht fremd. Der `Origin` muss sich
  // dafür über den `Host` der Anfrage ausweisen — deshalb wird er hier aus
  // dem Port des laufenden Zuhörers gebaut und nicht fest hingeschrieben.
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", {
      method: "POST",
      body: NEW_HOST,
      origin: `http://127.0.0.1:${running.port}`
    });
    assert.equal(response.status, 201, response.text);
    assert.deepEqual(running.recorded.calls, ["enrollHost"]);
  } finally {
    await running.close();
  }
});

test("ein GET mit Wirkung nur mit passendem Referer läuft durch — die eigene Oberfläche über reines HTTP", async () => {
  // ⚠️ Gemessen am 2026-09-29 gegen `http://192.0.2.31:8090`: in einem
  // nicht sicheren Kontext sendet der Browser weder `Sec-Fetch-Site` noch,
  // bei einem GET aus derselben Herkunft, `Origin`. Allein der `Referer`
  // weist die Anfrage dann aus.
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts/host-1/archive", {
      referer: `http://127.0.0.1:${running.port}/settings/hosts`
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(running.recorded.calls, ["regenerateArchive"], "die Schranke hat die eigene Oberfläche abgewiesen");
  } finally {
    await running.close();
  }
});

test("ein GET mit Wirkung ohne jede Browser-Kopfzeile ist 403", async () => {
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts/host-1/archive");
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "die Rotation lief trotz 403");
  } finally {
    await running.close();
  }
});

test("ein Origin mit fremdem Host ist 403, und der Handler lief nicht", async () => {
  const running = await stack();
  try {
    const response = await call(running.port, "/hosts", {
      method: "POST",
      body: NEW_HOST,
      origin: "https://fremde-seite.example"
    });
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "der Arm wurde trotz 403 angelegt");
  } finally {
    await running.close();
  }
});

test("die Schranke steht vor jeder Route — auch vor einer, die es nicht gibt", async () => {
  // Sie hängt als erste Zwischenschicht und nicht an einzelnen Routen. Eine
  // fremd ausgelöste POST-Anfrage auf einen unbekannten Pfad bekommt deshalb
  // die 403 der Herkunft und nicht die 404 des Sammelbeckens: die Antwort
  // verrät damit auch nicht, welche Pfade es gibt.
  const running = await stack();
  try {
    const response = await call(running.port, "/gibt-es-nicht", {
      method: "POST",
      body: {},
      secFetchSite: "cross-site"
    });
    assert.equal(response.status, 403, response.text);
  } finally {
    await running.close();
  }
});

// ── Der Router trifft nur noch die eigene Schreibweise (Etappe B4b-F, #5) ────
//
// ⚠️ Die Fälle darüber belegen die Schranke, dieser belegt den ROUTER. Beide
// zusammen sind der Grundsatz aus dem Fund: die Schranke bleibt unempfindlich
// gegen Schreibweise, der Router ist es seit `Router({ caseSensitive: true })`
// nicht mehr — und eine Schranke darf nie enger treffen als der Router.
//
// Gemessen an derselben Route wie oben, nur mit `same-origin`: ohne die
// Herkunftsprüfung als Ursache bleibt sichtbar, was der Router allein tut.

test("eine abweichende Schreibweise trifft die Route nicht mehr", async () => {
  const running = await stack();
  try {
    // Die Gegenprobe zuerst: in ihrer eigenen Schreibweise trifft sie.
    const exact = await call(running.port, "/hosts", { secFetchSite: "same-origin" });
    assert.equal(exact.status, 200, exact.text);

    // Und in jeder anderen nicht — 404 aus dem Sammelbecken am Ende des
    // Routers, nicht 200 aus dem Handler.
    for (const path of ["/HOSTS", "/Hosts"]) {
      const response = await call(running.port, path, { secFetchSite: "same-origin" });
      assert.equal(response.status, 404, `${path} erreichte einen Handler: ${response.text}`);
      assert.match(response.text, /"error":"not-found"/);
    }
  } finally {
    await running.close();
  }
});

test("die zustandsändernde GET-Route läuft auch in abweichender Schreibweise nicht mehr", async () => {
  // ⚠️ DER FUND AUS B4a, an seiner Wurzel gemessen. Bis hierher hielt ihn
  // allein die Herkunftsprüfung auf; mit `same-origin` wäre sie gar nicht
  // zuständig. Ohne `caseSensitive` liefe hier die Rotation — Schlüsselpaar,
  // Agent-Secret und Token — und die Antwort wäre eine 200 mit dem Archiv.
  const running = await stack();
  try {
    for (const path of ["/HOSTS/host-1/ARCHIVE", "/Hosts/host-1/Archive"]) {
      const response = await call(running.port, path, { secFetchSite: "same-origin" });
      assert.equal(response.status, 404, `${path} erreichte einen Handler`);
      assert.deepEqual(running.recorded.calls, NOTHING_CALLED, "die Rotation lief trotz 404");
    }
  } finally {
    await running.close();
  }
});

// ── Der Log-Strom ist ein GET MIT WIRKUNG (Etappe B4b-K, #5) ────────────────
//
// ⚠️ DER BEFUND, DEN DIESE FÄLLE FESTNAGELN. `GET
// /hosts/:hostId/containers/:containerId/logs-stream` stand nicht in
// `GET_ROUTES_WITH_EFFECT`, und `hasEffect` lässt einen GET ohne Eintrag
// ungeprüft durch. Gemessen durch genau diesen Aufbau: `cross-site`,
// `same-site`, `same-origin` und ganz ohne Kopfzeilen antworteten alle mit
// `200`, der Arm wurde kontaktiert, und der Aufrufer lautete auf den
// angemeldeten Menschen.
//
// Was daran der Schaden ist — und was NICHT: die fremde Seite kann den Rumpf
// des Stroms nicht lesen, und weder Container- noch Host-Zustand ändern sich.
// Sie belegt einen der gleichzeitigen Ströme des Arms (die sich drei
// Endpunkte und alle Nutzer dieses Arms teilen) und hinterlässt im Audit-Log
// des Arms einen Eintrag unter fremdem Namen. Der Kommentar neben dem Eintrag
// in `request-origin.ts` trägt beides aus.
//
// ⚠️ GEPRÜFT WIRD AM AUSGEBLIEBENEN KONTAKT ZUM ARM, nicht am Statuscode
// allein — dasselbe Muster wie oben und aus einem hier besonders scharfen
// Grund: dieser Handler öffnet den Strom zum Arm, BEVOR er den Status vergibt.
// Eine Fassung, die erst öffnet und dann ablehnt, bliebe an einer Erwartung
// auf `403` grün, und der Platz am Arm wäre trotzdem weg.

const LOGS_STREAM = "/hosts/host-1/containers/abc123/logs-stream?tail=7";

test("GET logs-stream mit same-origin erreicht den Arm weiterhin", async () => {
  // ⚠️ DER FALL, DER OHNE IHN FALSCH WÄRE. Eine Schranke, die auch die eigene
  // Oberfläche aussperrt, ist keine Verbesserung — `streamContainerLogs`
  // (`web/src/features/logs/api.ts`) ruft den Pfad relativ zum Dokument auf, der
  // Browser setzt damit `same-origin`, und das ist Zeile 2 der Tabelle aus §1.
  //
  // Er ist zugleich die Gegenprobe zu den drei Fällen darunter: der Nachweis
  // „der Arm wurde nicht kontaktiert" ist wertlos, solange nicht feststeht,
  // dass dieser Mitschreiber einen Kontakt überhaupt sähe.
  const running = await stack({ withAgent: true });
  try {
    const response = await call(running.port, LOGS_STREAM, { secFetchSite: "same-origin" });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(running.agentSeen, [
      { url: "/containers/abc123/logs-stream?tail=7", actor: "user:admin-1" }
    ]);
  } finally {
    await running.close();
  }
});

// Die drei Herkünfte, die eine fremde Seite erzeugen kann — und die
// headerlose Anfrage, die ein Skript stellt. `undefined` steht für „die
// Kopfzeile fehlt"; `call` lässt sie dann weg, statt sie leer zu senden.
for (const secFetchSite of ["cross-site", "same-site", undefined]) {
  const label = secFetchSite ?? "ohne Sec-Fetch-Site und ohne Origin";
  test(`GET logs-stream mit ${label} ist 403, und der Arm wurde nicht kontaktiert`, async () => {
    const running = await stack({ withAgent: true });
    try {
      const response = await call(running.port, LOGS_STREAM, { secFetchSite });
      assert.equal(response.status, 403, response.text);
      assert.deepEqual(
        running.agentSeen,
        NOTHING_ASKED,
        "der Arm wurde trotz 403 kontaktiert — ein Platz seiner Ströme ist weg, " +
          "und in seinem Audit-Log steht ein Eintrag unter fremdem Namen"
      );
    } finally {
      await running.close();
    }
  });
}
