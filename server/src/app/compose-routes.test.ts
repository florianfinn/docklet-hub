import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import type { Pool } from "pg";

import type { AgentHealth, HostCycleOutcome, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Actor } from "../platform/agent-transport/protocol.js";
import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import { DEFAULT_HOST_THEME, HUB_STREAM_BROKEN } from "contract";
import { readUntil, waitFor } from "./exec-test-support.js";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die Compose-Fläche über den ganzen Weg: echter Router, echter Express, ein
// kleiner Zuhörer auf 127.0.0.1 als Agent — dasselbe Muster wie
// `file-routes.test.ts`. Kein Postgres, kein docker.sock, kein laufender Agent.
//
// ⚠️ ZWEI DINGE PRÜFT NUR DIESE DATEI, und beide fallen sonst nirgends auf:
//
//   DIE STELLUNG    ein Textwächter liest, dass `requireAdmin` hinter dem Pfad
//                   steht; was passiert, wenn es woanders steht, sagt er
//                   nicht. Unten steht deshalb ein Verhaltensfall je Route.
//   DER NAME        `confirmName` kommt aus dem LESEAUFRUF und nicht aus dem
//                   Rumpf. Nimmt jemand ihn aus dem Rumpf, gelingt jeder Test,
//                   der ihn dort mitschickt — und die Prüfung des Agenten
//                   prüfte dann, ob der Browser sich selbst zustimmt.

const HOST: HostRecord = {
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

const ROW_SECRET = "das-secret-aus-der-zeile-des-arms";
const ROLE_HEADER = "x-test-role";
const CONTAINER_ID = "c0ffee";
const CURRENT: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 12, readOnly: false, entries: null };

/** Was der Agent auf den Leseaufruf antwortet. */
const COMPOSE_READ = {
  projectDir: "/opt/stacks/medien",
  composeFileName: "compose.yaml",
  stackName: "medien",
  content: "services:\n  sonarr:\n    image: sonarr:1\n",
  composeHash: "h1",
  services: ["sonarr"],
  servicesInFile: ["sonarr", "radarr"],
  fileReadable: true,
  containerIds: { sonarr: "c-sonarr" },
  inventoryViolations: ["sonarr:privileged"]
};

// ── Der Agent ───────────────────────────────────────────────────────────────

/**
 * Eine Antwort des Fake-Arms.
 *
 * ⚠️ `ndjson` UND NICHT `body` FÜR EINEN STROM. Der Anwende-Strom des Agenten
 * antwortet mit einer Zeile je Umschlag, und ein `JSON.stringify` über ein
 * Array ergäbe `[{…},{…}]` — gültiges JSON, aber kein NDJSON. Der Zerleger des
 * Hubs fände darin genau null Umschläge, und der Test wäre grün gegen etwas,
 * das der Agent nie schickt.
 *
 * `hold` schiebt die Zeilen hinaus und lässt die Antwort danach OFFEN — ein
 * Anwenden, das noch läuft. Nur so lässt sich prüfen, was der Hub tut, wenn
 * der Browser mittendrin geht.
 */
type AgentReply = { status: number; body?: unknown; ndjson?: unknown[]; hold?: true };

type FakeAgent = {
  port: number;
  replies: Map<string, AgentReply>;
  seen: { method: string; url: string; actor: string | undefined; body: string }[];
  /** Wie oft der Hub einen gehaltenen Strom gekappt hat, bevor der Arm ihn beendet hat. */
  hungUp: number;
  close: () => Promise<void>;
};

async function startAgent(): Promise<FakeAgent> {
  const state: FakeAgent = { port: 0, replies: new Map(), seen: [], hungUp: 0, close: async () => undefined };

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
      const path = url.split("?")[0] ?? "";
      const reply = state.replies.get(`${request.method} ${path}`);
      if (!reply) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `unerwartet: ${request.method} ${path}` }));
        return;
      }
      if (reply.ndjson) {
        response.writeHead(reply.status, { "content-type": "application/x-ndjson; charset=utf-8" });
        const text = reply.ndjson.map((line) => `${JSON.stringify(line)}\n`).join("");
        if (!reply.hold) {
          response.end(text);
          return;
        }
        // ⚠️ AM `response` UND NICHT AM `request`, wie in `exec-test-support.ts`:
        // der `close` der Antwort fällt auch nach einem regulären `end()`;
        // gezählt wird nur der Fall, in dem der Hub aufgelegt hat, bevor der
        // Arm fertig war.
        response.on("close", () => {
          if (!response.writableEnded) state.hungUp += 1;
        });
        response.write(text);
        // `writeHead` allein schiebt in Node nichts auf die Leitung.
        response.flushHeaders();
        return;
      }
      response.writeHead(reply.status, { "content-type": "application/json" });
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

/** Die Container-Liste, die jede Route dieser Fläche zuerst holt. */
function withContainer(agent: FakeAgent): void {
  agent.replies.set("GET /containers", {
    status: 200,
    body: {
      containers: [
        { id: CONTAINER_ID, name: "sonarr", image: "sonarr:1", status: "running", running: true }
      ]
    }
  });
}

function withRead(agent: FakeAgent): void {
  agent.replies.set(`GET /containers/${CONTAINER_ID}/compose-raw`, { status: 200, body: COMPOSE_READ });
}

/** Der Anwende-Strom, wie der Agent ihn ab v0.22.0 fährt. */
function withApplyStream(
  agent: FakeAgent,
  outcome: { status: number; body: unknown },
  steps: string[] = ["check", "write-file", "start"]
): void {
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-stream`, {
    status: 200,
    ndjson: [
      { kind: "start", projectDir: "/opt/stacks/medien", composeFileName: "compose.yaml", stackName: "medien" },
      ...steps.map((step) => ({ kind: "step", step })),
      { kind: "result", status: outcome.status, body: outcome.body }
    ]
  });
}

/** Ein Arm unter v0.22.0: den Strom kennt er nicht, den synchronen Weg schon. */
function withoutApplyStream(agent: FakeAgent): void {
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-stream`, {
    status: 404,
    body: { error: "unbekannte-route" }
  });
}

// ── Der Hub ─────────────────────────────────────────────────────────────────

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
        return Promise.resolve({ rows: [{ agent_secret: ROW_SECRET }], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  } as unknown as Pool;
}

type Resync = { calls: { hostId: string; actor: string }[]; outcome: HostCycleOutcome; throws: boolean };

function newResync(): Resync {
  return {
    calls: [],
    outcome: { hostId: HOST.id, hostName: HOST.name, status: "synced", entryCount: 3, error: null },
    throws: false
  };
}

type Hub = { port: number; close: () => Promise<void> };

async function startHub(agent: FakeAgent, resync?: Resync): Promise<Hub> {
  const host = { ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` };

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
      ...(resync === undefined
        ? {}
        : {
            resyncHost: (record: HostRecord, actor: Actor) => {
              resync.calls.push({
                hostId: record.id,
                actor: actor.kind === "user" ? `user:${actor.id}` : `system:${actor.name}`
              });
              if (resync.throws) return Promise.reject(new Error("der Arm hat den Abgleich abgelehnt"));
              return Promise.resolve(resync.outcome);
            }
          })
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

const BASE = `/api/hosts/${HOST.id}/containers/${CONTAINER_ID}/compose`;

/**
 * Die Herkunft einer Anfrage in diesem Test.
 *
 * `"same-origin"` (die Vorgabe) stellt den Browser der eigenen Oberfläche
 * nach. `false` ist der Aufrufer OHNE Browser-Kopfzeilen — ein Skript, kein
 * Browser. Die beiden übrigen Werte sind die Herkünfte, die eine FREMDE Seite
 * erzeugt: `cross-site` von einer anderen Site, `same-site` von einer
 * Nachbar-Subdomain, die das Sitzungsmerkmal bei `SameSite=Lax` mitbekommt.
 */
type TestOrigin = "same-origin" | "cross-site" | "same-site" | false;

async function call(
  hub: Hub,
  method: string,
  path: string,
  role: string,
  body?: unknown,
  origin: TestOrigin = "same-origin"
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { [ROLE_HEADER]: role };
  // Die Herkunftsprüfung sitzt vor dem ganzen Router; ohne diesen Kopf
  // endet jede schreibende Anfrage in einem 403, bevor eine Route greift.
  if (origin === "same-origin") headers.origin = `http://127.0.0.1:${hub.port}`;
  else if (origin !== false) headers["sec-fetch-site"] = origin;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/**
 * Dasselbe für eine Antwort, die ein STROM ist.
 *
 * ⚠️ Die Anwende-Route antwortet seit dem Anwende-Strom (#86) mit NDJSON und
 * nicht mehr mit einem JSON-Objekt. Ein `response.json()` darauf ergäbe je nach
 * Zahl der Zeilen mal ein Objekt, mal einen Fehler — also einen Test, der
 * zufällig grün wird.
 */
async function callStream(
  hub: Hub,
  path: string,
  role: string,
  body?: unknown
): Promise<{ status: number; lines: Record<string, unknown>[]; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method: "POST",
    headers: {
      [ROLE_HEADER]: role,
      origin: `http://127.0.0.1:${hub.port}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  const lines: Record<string, unknown>[] = [];
  // Ein Fehler VOR den Kopfzeilen ist weiterhin ein JSON-Objekt mit Status —
  // deshalb beides lesen und nicht raten.
  let json: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.kind === "string") lines.push(parsed);
      else json = parsed;
    } catch {
      // Eine Zeile, die kein JSON ist, gehört nicht zu dieser Antwort.
    }
  }
  return { status: response.status, lines, json };
}

/** Die Zeile einer Art, oder `undefined`. */
function lineOfKind(lines: Record<string, unknown>[], kind: string): Record<string, unknown> | undefined {
  return lines.find((line) => line.kind === kind);
}

// ── Die Stellung der Zwischenschicht ────────────────────────────────────────

test("ein Benutzer ohne Adminrechte kommt an keine der drei Routen", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  const hub = await startHub(agent);
  try {
    // ⚠️ Verrutscht `requireAdmin`, meldet dieser Fall `200 !== 403` statt
    // eines Textbefunds — auch an der LESENDEN Route, die eine Karte des
    // fremden Hosts ausliefert.
    assert.equal((await call(hub, "GET", BASE, "user")).status, 403);
    assert.equal((await call(hub, "POST", `${BASE}/preview`, "user", { content: "x" })).status, 403);
    assert.equal((await call(hub, "POST", BASE, "user", { content: "x", expectedComposeHash: "h1" })).status, 403);
    assert.equal(
      agent.seen.length,
      0,
      "kein Aufruf darf den Arm erreicht haben"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── Lesen ───────────────────────────────────────────────────────────────────

test("die Leseroute reicht jedes Feld durch", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "GET", BASE, "admin");
    assert.equal(answer.status, 200);
    const compose = answer.json.compose as Record<string, unknown>;
    assert.equal(compose.stackName, "medien");
    assert.equal(compose.composeHash, "h1");
    assert.deepEqual(compose.services, ["sonarr"]);
    assert.deepEqual(compose.servicesInFile, ["sonarr", "radarr"]);
    assert.deepEqual(compose.inventoryViolations, ["sonarr:privileged"]);

    // Der Aufrufer im Audit-Log des Arms ist der angemeldete Mensch.
    const read = agent.seen.find((entry) => entry.url.endsWith("/compose-raw"));
    assert.equal(read?.actor, "user:admin-1");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── Die Herkunft: der Eintrag in GET_ROUTES_WITH_EFFECT ─────────────────────
//
// ⚠️ DER BEFUND, DEN DIESE FÄLLE FESTNAGELN (Befund 1 aus #117, #118). `GET
// …/compose` stand nicht in `GET_ROUTES_WITH_EFFECT`, und `hasEffect` lässt
// einen GET ohne Eintrag ungeprüft durch — `requireAdmin` allein beantwortet
// „wer darf?" und nicht „welche Herkunft darf auslösen?". Gemessen mit genau
// diesem Aufbau: die Anfrage ohne Browser-Kopfzeilen wurde mit `200`
// beantwortet, der Arm unter `actor=user:admin-1` kontaktiert, und in seinem
// Audit-Log stand `compose-raw-read` mit `outcome: "allowed"`.
//
// ⚠️ GEPRÜFT WIRD AM AUSGEBLIEBENEN KONTAKT ZUM ARM und nicht am Statuscode
// allein — dasselbe Muster wie in `request-origin-routing.test.ts`. Eine
// Fassung, die erst den Arm fragt und danach ablehnt, bliebe an einer
// Erwartung auf `403` grün, und der Eintrag unter fremdem Namen stünde
// trotzdem im Protokoll des Arms.
//
// Die Gegenprobe steht darüber: „die Leseroute reicht jedes Feld durch" fährt
// mit `same-origin` und weist den Kontakt zum Arm nach. Ohne sie wäre
// „der Arm wurde nicht kontaktiert" wertlos — dieser Mitschreiber sähe einen
// Kontakt vielleicht ohnehin nicht.

for (const origin of ["cross-site", "same-site", false] as const) {
  const label = origin === false ? "ohne Browser-Kopfzeilen" : `mit ${origin}`;
  test(`die Leseroute ${label} ist 403, und der Arm wurde nicht kontaktiert`, async () => {
    const agent = await startAgent();
    withContainer(agent);
    withRead(agent);
    const hub = await startHub(agent);
    try {
      const answer = await call(hub, "GET", BASE, "admin", undefined, origin);
      assert.equal(answer.status, 403);
      assert.deepEqual(answer.json, { error: "forbidden-origin" });
      assert.deepEqual(
        agent.seen,
        [],
        "der Arm wurde trotz fremder Herkunft angesprochen — in seinem Audit-Log steht " +
          "ein compose-raw-read unter dem Namen des angemeldeten Menschen"
      );
    } finally {
      await hub.close();
      await agent.close();
    }
  });
}

// ── Vorschau ────────────────────────────────────────────────────────────────

/** Die Antwort des Trockenlaufs, wie der Agent sie ab v0.21.0 schickt. */
function withDryRun(agent: FakeAgent, body: Record<string, unknown>): void {
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-preview`, { status: 200, body });
}

test("die Vorschau kommt vom Trockenlauf des Arms und wird durchgereicht", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withDryRun(agent, {
    projectDir: "/srv/medien",
    composeFileName: "docker-compose.yml",
    stackName: "medien",
    composeHash: "h1",
    currentServices: ["sonarr"],
    valid: true,
    reason: null,
    errors: [],
    configError: null,
    services: ["sonarr", "radarr"],
    diff: { remaining: ["sonarr"], new: ["radarr"], removed: [] },
    imagesByService: { sonarr: "sonarr:1", radarr: "radarr:1" },
    missingImages: ["radarr:1"],
    servicesWithoutImage: [],
    inventoryViolations: ["sonarr:privileged"]
  });
  const hub = await startHub(agent);
  try {
    const draft = "services:\n  sonarr:\n    image: sonarr:1\n  radarr:\n    image: radarr:1\n";
    const answer = await call(hub, "POST", `${BASE}/preview`, "admin", { content: draft });

    assert.equal(answer.status, 200);
    const preview = answer.json.preview as Record<string, unknown>;
    assert.equal(preview.source, "agent");
    assert.deepEqual((preview.diff as Record<string, unknown>).new, ["radarr"]);
    // ⚠️ DAS FELD, DAS DER HUB NIE SELBST BILDEN KANN. Welche Images auf dem
    // Host fehlen, weiß nur der Arm; beim Anwenden gehören genau diese Refs in
    // `acknowledgeImagePull`, und die Prüfung dort ist Mengengleichheit.
    assert.deepEqual(preview.missingImages, ["radarr:1"]);
    assert.deepEqual(preview.inventoryViolations, ["sonarr:privileged"]);
    assert.equal(preview.composeHash, "h1");
    // Er rät nicht mehr — also behauptet er auch keine Unsicherheit.
    assert.deepEqual(preview.uncertainties, []);

    // ⚠️ KEIN LESEAUFRUF. Der Trockenlauf bringt Hash und Stacknamen selbst
    // mit; ein zusätzlicher `GET compose-raw` wäre eine Runde, die niemand
    // braucht — und der Fake beantwortet ihn hier gar nicht.
    assert.equal(agent.seen.filter((entry) => entry.url.endsWith("/compose-raw")).length, 0);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Arm ohne Trockenlauf bekommt die eigene Rechnung — und sagt es", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  // ⚠️ EIN ARM UNTER v0.21.0: er kennt die Route nicht. Ohne Rückfall wäre der
  // Compose-Reiter dort kaputt.
  //
  // ⚠️ `MIN_AGENT_VERSION` NO LONGER ALLOWS IT (0.32.0 since #279, 0.24.0
  // since #130), and this case checks it anyway: it checks the fallback and
  // not the mark. As long as the fallback stays in the code it belongs under
  // test; whoever removes it deletes this case in the same change.
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-preview`, {
    status: 404,
    body: { error: "unbekannte-route" }
  });
  const hub = await startHub(agent);
  try {
    // `radarr` steht in `servicesInFile`, hat aber keinen Container. Wer gegen
    // die Datei rechnet, meldet ihn als unverändert — und es entstünde ein
    // Container, über dessen Rechte nie jemand entschieden hat.
    const draft = "services:\n  sonarr:\n    image: sonarr:1\n  radarr:\n    image: radarr:1\n";
    const answer = await call(hub, "POST", `${BASE}/preview`, "admin", { content: draft });

    assert.equal(answer.status, 200);
    const preview = answer.json.preview as Record<string, unknown>;
    assert.equal(preview.source, "hub");
    assert.deepEqual((preview.diff as Record<string, unknown>).new, ["radarr"]);
    assert.deepEqual(preview.inventoryViolations, ["sonarr:privileged"]);
    assert.equal(preview.composeHash, "h1");
    // ⚠️ `null` UND NICHT `[]`. Der Hub kennt den Bildbestand des Hosts nicht,
    // und ein leeres Feld hiesse „nichts zu ziehen" — eine Beruhigung über
    // etwas, das niemand geprüft hat.
    assert.equal(preview.missingImages, null);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein abgeschalteter Arm fällt NICHT auf die eigene Rechnung zurück", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  // ⚠️ DER FALL, DER DEN RÜCKFALL GEFÄHRLICH MACHTE, WENN ER WEITER GRIFFE.
  // Ein `503` heißt `DOCKER_AGENT_READ_ONLY` — der Arm beantwortet den
  // Trockenlauf nicht, weil er den Entwurf als Datei ablegen müsste. Eine
  // ersatzweise eigene Rechnung zeigte dem Betreiber eine Vorschau für einen
  // Vorgang, den dieser Arm gar nicht ausführt.
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-preview`, {
    status: 503,
    body: { error: "agent-read-only" }
  });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "POST", `${BASE}/preview`, "admin", { content: "services:\n  sonarr:\n" });
    // Seit #122 kommt der Kill-Switch als solcher an und nicht als „Arm nicht
    // erreichbar".
    assert.equal(answer.status, 503);
    assert.equal(answer.json.error, "agent-read-only");
    assert.equal(answer.json.reason, "agent-read-only");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── „Route unbekannt" gegen `not-allowlisted` (#129) ────────────────────────

// Beide sind `404`, und bis #129 entschied allein der Status. Was den
// Unterschied macht, ist der Grund im Rumpf: `unbekannte-route` (oben, zweimal
// benutzt) löst den Rückfall aus, `not-allowlisted` ist eine Antwort des Arms
// und geht als solche hinaus.

test("eine 404 mit not-allowlisted löst KEINEN Rückfall auf die eigene Rechnung aus", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-preview`, {
    status: 404,
    body: { error: "not-allowlisted" }
  });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "POST", `${BASE}/preview`, "admin", { content: "services:\n  sonarr:\n" });

    // 403 und `agent-forbidden`: die Fläche hat dafür einen eigenen Satz
    // (`compose-errors.ts`, `composeErrorNotAllowlisted`). Ein `502` sagte
    // „Arm nicht erreichbar" über einen Arm, der begründet abgelehnt hat.
    assert.equal(answer.status, 403);
    assert.equal(answer.json.error, "agent-forbidden");
    // ⚠️ DER LESEAUFRUF DES RÜCKFALLS DARF NICHT LAUFEN. Er ist die Spur, an
    // der eine stille Rückkehr des Fehlers auffällt: der Fake beantwortet ihn,
    // der Test wäre sonst grün und die Vorschau geraten.
    assert.equal(
      agent.seen.filter((entry) => entry.url.endsWith("/compose-raw")).length,
      0,
      "der Rückfall lief trotz benannter Ablehnung"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("eine 404 mit not-allowlisted am Strom fällt NICHT auf den synchronen Weg", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-stream`, {
    status: 404,
    body: { error: "not-allowlisted" }
  });
  const hub = await startHub(agent);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1"
    });

    // ⚠️ EIN ECHTER STATUS UND KEINE ZEILE. Der Befund aus #129 sah so aus:
    // `start` ging hinaus, danach war kein Statuscode mehr zu haben, und die
    // Fläche las „Stand unbekannt" für einen Stack, den der Arm nicht
    // angefasst hat.
    assert.equal(answer.status, 403);
    assert.equal(answer.json.error, "agent-forbidden");
    assert.deepEqual(answer.lines, []);
    assert.equal(
      agent.seen.some((entry) => entry.url.endsWith("/compose-raw") && entry.method === "POST"),
      false,
      "der synchrone Weg lief trotz benannter Ablehnung"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("eine 404 mit container-gone kommt als container-unknown an", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set(`GET /containers/${CONTAINER_ID}/compose-raw`, {
    status: 404,
    body: { error: "container-gone" }
  });
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "GET", BASE, "admin");

    // Der Container ist zwischen der Liste und dem Leseaufruf verschwunden.
    // Dieselbe Kennung, die `openContainer` für denselben Sachverhalt sendet.
    assert.equal(answer.status, 404);
    assert.equal(answer.json.error, "container-unknown");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── Anwenden ────────────────────────────────────────────────────────────────

test("der Hub setzt confirmName aus dem Leseaufruf und nicht aus dem Rumpf", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  withApplyStream(agent, { status: 200, body: { ok: true } });
  const hub = await startHub(agent);
  try {
    // ⚠️ Der Rumpf nennt einen FALSCHEN Stacknamen. Er darf nicht hinausgehen:
    // was hinausgeht, ist der Name aus der Antwort des Arms.
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1",
      stackName: "ein-anderer-stack"
    });

    assert.equal(answer.status, 200);
    const written = agent.seen.find((entry) => entry.method === "POST");
    const sent = JSON.parse(written?.body ?? "{}") as Record<string, unknown>;
    assert.equal(sent.confirmName, "medien");
    assert.equal(sent.expectedComposeHash, "h1");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ohne Hash wird gar nicht erst gefragt", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  const hub = await startHub(agent);
  try {
    const answer = await call(hub, "POST", BASE, "admin", { content: "services: {}\n" });

    assert.equal(answer.status, 400);
    assert.equal(answer.json.error, "compose-hash-missing");
    assert.equal(
      agent.seen.some((entry) => entry.method === "POST"),
      false,
      "ohne Hash darf nichts an den Arm gehen"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── Der Abgleich danach ─────────────────────────────────────────────────────

test("nach dem Anwenden wird die Allowlist SOFORT abgeglichen, mit dem Menschen als Aufrufer", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  withApplyStream(agent, { status: 200, body: { ok: true } });
  const resync = newResync();
  const hub = await startHub(agent, resync);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1"
    });

    assert.equal(answer.status, 200);
    // ⚠️ DIE SCHRITTE KOMMEN EINZELN UND VOR DEM ERGEBNIS. Genau dafür gibt es
    // den Strom: eine Anzeige, die benennen kann, wo der Vorgang steht, statt
    // bis zu zehn Minuten „Wird angewendet …" zu zeigen.
    assert.deepEqual(
      answer.lines.filter((line) => line.kind === "step").map((line) => line.step),
      ["check", "write-file", "start"]
    );
    assert.equal(lineOfKind(answer.lines, "start")?.live, true);
    // ⚠️ OHNE DIESEN AUFRUF WÄRE DIE FLÄCHE NACH DEM ANWENDEN KAPUTT.
    // `compose up` erzeugt neue Container-Ids, und `compose-raw` verankert die
    // Allowlist des Arms nicht neu — bis zum nächsten Takt stünden dort die
    // alten, und jede weitere Aktion an diesem Stack liefe in eine Ablehnung.
    assert.deepEqual(resync.calls, [{ hostId: HOST.id, actor: "user:admin-1" }]);
    // Der Aufrufer ist der MENSCH und nicht `system:hub`: er hat die Änderung
    // gerade ausgelöst, und das Audit-Log des Arms soll das zeigen.
    assert.deepEqual(lineOfKind(answer.lines, "result")?.resync, { status: "synced", error: null });
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein gescheiterter Abgleich meldet sich, lässt das Anwenden aber gelten", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  withApplyStream(agent, { status: 200, body: { ok: true } });
  const resync = newResync();
  resync.throws = true;
  const hub = await startHub(agent, resync);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1"
    });

    // ⚠️ Zu diesem Zeitpunkt ist die Datei geschrieben und der Stack läuft.
    // Ein Fehlschlag hier als `500` zu melden hiesse, dem Betreiber ein
    // misslungenes Anwenden zu zeigen, das gelungen ist — und er versuchte es
    // erneut, gegen einen Hash, der nicht mehr stimmt.
    assert.equal(answer.status, 200);
    const outcome = lineOfKind(answer.lines, "result")?.resync as Record<string, unknown>;
    assert.equal(outcome.status, "failed");
    assert.match(String(outcome.error), /abgelehnt/);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ohne verdrahteten Abgleich sagt die Antwort das, statt zu schweigen", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  withApplyStream(agent, { status: 200, body: { ok: true } });
  const hub = await startHub(agent);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1"
    });

    assert.deepEqual(lineOfKind(answer.lines, "result")?.resync, { status: "skipped", error: null });
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der 409 des Arms kommt als beantwortbare Frage an", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  withApplyStream(agent, {
    status: 409,
    body: { error: "image-not-local", missingImages: ["radarr:1"], pull: true }
  });
  const hub = await startHub(agent);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  radarr:\n    image: radarr:1\n",
      expectedComposeHash: "h1"
    });

    // ⚠️ EINE ZEILE MIT DER LISTE, nicht eine Meldung. Der Hub kann diese Liste
    // nicht selbst bilden — welche Images fehlen, weiß nur der Arm. Ohne sie
    // wäre die Frage unbeantwortbar.
    //
    // ⚠️ UND KEIN STATUS. Der Strom steht längst; ein `409` an dieser Stelle
    // käme beim Browser nie an. Der Ausgang gehört ab den Kopfzeilen in den
    // Strom, und die Ablehnung des Arms ist ein Ausgang wie jeder andere.
    assert.equal(answer.status, 200);
    assert.deepEqual(lineOfKind(answer.lines, "question")?.question, { kind: "images", missing: ["radarr:1"] });
  } finally {
    await hub.close();
    await agent.close();
  }
});


test("ein Arm ohne Anwende-Strom bekommt den synchronen Weg — und die Fläche erfährt es", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  withoutApplyStream(agent);
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw`, { status: 200, body: { ok: true } });
  const hub = await startHub(agent);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1"
    });

    assert.equal(answer.status, 200);
    // ⚠️ `live: false` IST DER GANZE PUNKT DIESES FALLS. Der synchrone Weg
    // schweigt bis zum Ende. Ohne diese Angabe zeigte die Fläche eine
    // Schrittliste, in der für immer der erste Schritt läuft — und das sähe aus
    // wie ein Hänger und nicht wie ein alter Arm.
    assert.equal(lineOfKind(answer.lines, "start")?.live, false);
    assert.deepEqual(
      answer.lines.filter((line) => line.kind === "step"),
      [],
      "erfundene Schritte wären schlimmer als keine"
    );
    assert.deepEqual(lineOfKind(answer.lines, "result")?.applied, { ok: true });
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Strom ohne Abschlusszeile gilt NICHT als erfolgreich", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  // ⚠️ DER GEFÄHRLICHSTE AUSGANG VON ALLEN. Der Strom bricht nach dem
  // Schreiben ab, ohne zu sagen, wie es ausging. Wer das still als „fertig"
  // behandelt, meldet einen Stack als angewandt, über dessen Zustand niemand
  // etwas weiß — und der Betreiber schließt den Reiter.
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-stream`, {
    status: 200,
    ndjson: [
      { kind: "start", projectDir: "/opt/stacks/medien", composeFileName: "compose.yaml", stackName: "medien" },
      { kind: "step", step: "write-file" }
    ]
  });
  const hub = await startHub(agent);
  try {
    const answer = await callStream(hub, BASE, "admin", {
      content: "services:\n  sonarr:\n    image: sonarr:2\n",
      expectedComposeHash: "h1"
    });

    assert.equal(lineOfKind(answer.lines, "result"), undefined, "kein Ergebnis darf erfunden werden");
    const failure = lineOfKind(answer.lines, "error");
    assert.ok(failure, "der unbekannte Ausgang muss BENANNT werden, nicht verschwiegen");
    // ⚠️ Ein Wort des Hubs und kein Meldungstext (#176). Bis dahin stand hier
    // der deutsche Satz der Ausnahme, und dieser Fall prüfte nur, dass darin
    // „unbekannt" vorkam.
    assert.equal(failure.reason, HUB_STREAM_BROKEN);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Grund aus der fehler-Zeile des Agenten geht wörtlich an den Browser, auch als null (#176)", async () => {
  // ⚠️ BIS #176 VERSCHWAND ER. `applyComposeStreaming` warf nach der Zeile eine
  // Ausnahme, und die Route schrieb deren deutschen Meldungstext als Grund —
  // der Schlüssel des Agenten stand nur noch mitten im Satz.
  for (const [sent, expected] of [
    [{ kind: "error", reason: "engine-unreachable" }, "engine-unreachable"],
    [{ kind: "error" }, null]
  ] as const) {
    const agent = await startAgent();
    withContainer(agent);
    withRead(agent);
    agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-stream`, {
      status: 200,
      ndjson: [
        { kind: "start", projectDir: "/opt/stacks/medien", composeFileName: "compose.yaml", stackName: "medien" },
        sent
      ]
    });
    const hub = await startHub(agent);
    try {
      const answer = await callStream(hub, BASE, "admin", {
        content: "services:\n  sonarr:\n    image: sonarr:2\n",
        expectedComposeHash: "h1"
      });
      const failure = lineOfKind(answer.lines, "error");
      assert.ok(failure, `keine fehler-Zeile für ${JSON.stringify(sent)}`);
      assert.ok(
        failure.reason === expected,
        `${JSON.stringify(sent)} kam als ${JSON.stringify(failure.reason)} an, erwartet ${JSON.stringify(expected)}`
      );
      assert.equal(answer.lines.filter((line) => line.kind === "error").length, 1, "genau eine fehler-Zeile");
    } finally {
      await hub.close();
      await agent.close();
    }
  }
});

test("geht der Browser während des Anwendens, kappt der Hub den Strom zum Arm — und hält nichts an", async () => {
  const agent = await startAgent();
  withContainer(agent);
  withRead(agent);
  // Ein Anwenden, das LÄUFT: `start` und ein Schritt sind draußen, das
  // `result` kommt nicht — der Arm hält den Strom offen.
  agent.replies.set(`POST /containers/${CONTAINER_ID}/compose-raw-stream`, {
    status: 200,
    hold: true,
    ndjson: [
      { kind: "start", projectDir: "/opt/stacks/medien", composeFileName: "compose.yaml", stackName: "medien" },
      { kind: "step", step: "write-file" }
    ]
  });
  const resync = newResync();
  const hub = await startHub(agent, resync);
  const controller = new AbortController();
  try {
    // Kein `callStream`: das liest bis zum Ende, und dieses Ende kommt nie.
    const response = await fetch(`http://127.0.0.1:${hub.port}${BASE}`, {
      method: "POST",
      headers: {
        [ROLE_HEADER]: "admin",
        origin: `http://127.0.0.1:${hub.port}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: "services:\n  sonarr:\n    image: sonarr:2\n", expectedComposeHash: "h1" }),
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    assert.ok(reader, "die Antwort muss ein Strom sein");
    await readUntil(reader, (text) => text.includes('"start"'), "die start-Zeile kam nicht an");
    assert.equal(agent.hungUp, 0, "solange der Browser zuhört, bleibt der Strom zum Arm stehen");

    // ⚠️ DER BROWSER GEHT. Diese Route ist ein POST mit Rumpf, und
    // `express.json()` hat ihn vor dem Handler gelesen — der `close` der
    // ANFRAGE ist damit schon gefallen. Nur ein Zuhören am `close` der ANTWORT
    // bekommt diesen Abbruch mit; sonst hält der Hub einen der Stromplätze
    // des Arms, bis das Anwenden von selbst endet (#112).
    controller.abort();
    await waitFor(() => agent.hungUp === 1, "der Hub hat den Strom zum Arm nicht gekappt");

    // Der Hub hat kein Ergebnis gesehen und darf keinen Abgleich erfinden.
    assert.equal(resync.calls.length, 0, "ohne Ergebniszeile gibt es keinen Abgleich");
    assert.ok(
      agent.seen.some((call) => call.method === "POST" && call.url.endsWith("/compose-raw-stream")),
      "der Arm muss den Anwende-Strom gesehen haben"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});
