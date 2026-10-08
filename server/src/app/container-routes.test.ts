import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { AgentHealth, HostRecord, HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_LOG_TAIL_LINES } from "../features/logs/index.js";
import { containerStatsResponseSchema, DEFAULT_HOST_THEME } from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Der Log-Strom über den ganzen Weg: echter Router, echter Express, echter
// Agent — ein kleiner Zuhörer auf 127.0.0.1, dessen Strom dieser Test von Hand
// füttert (dasselbe Muster wie `agent-secret-routing.test.ts`).
//
// ⚠️ WARUM EIN ECHTER ZUHÖRER UND KEINE `fetch`-ATTRAPPE: die Zusage dieser
// Etappe ist eine DURCHREICHUNG, und die ist nur über zwei echte Verbindungen
// prüfbar. Eine Attrappe beantwortete die Frage „kommt Zeile 1 an, bevor
// Zeile 2 geschickt wird?" mit der Bauart des Tests statt mit der des Servers.
// Ebenso den Abbruch: dass der Hub den Strom ZUM AGENTEN beendet, wenn der
// Browser geht, sieht nur der Agent selbst.

const HOST: HostRecord = {
  id: "host-1",
  name: "unraid",
  // Wird je Lauf auf den Port des Zuhörers gesetzt.
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

// ⚠️ Die leere Erwartung trägt ihren Typ und steht nicht als `[]` im Aufruf:
// `assert.deepEqual` aus `node:assert/strict` ist typseitig ein
// `asserts actual is T`, und ein nacktes `[]` engte die Eigenschaft für den
// Rest der Funktion auf `never[]` ein — dieselbe Falle wie in
// `request-origin-routing.test.ts`.
const NOTHING_ASKED: { url: string; actor: string | undefined; secret: string | undefined }[] = [];

// ── Der Agent ───────────────────────────────────────────────────────────────

type AgentMode =
  | { kind: "stream" }
  | { kind: "status"; status: number; body: string };

type FakeAgent = {
  port: number;
  mode: AgentMode;
  /** Jede Anfrage, die der Hub gestellt hat: Pfad samt Abfrage und Aufrufer. */
  seen: { url: string; actor: string | undefined; secret: string | undefined }[];
  /** Wie oft der Hub eine laufende Verbindung von sich aus gekappt hat. */
  hungUp: number;
  arrived: Promise<void>;
  push: (chunk: string) => void;
  finish: () => void;
  /**
   * Reißt den Rumpf mitten im Strom ab, ohne ihn zu beenden.
   *
   * ⚠️ `socket.destroy()` und nicht `response.end()`: `end()` wäre ein
   * ordentliches Ende, und der Hub liefe in seinen Erfolgsfall. Was hier
   * nachgestellt wird, ist der Ausfall des Arms — Netz weg, Prozess weg,
   * Container gestorben —, und der kommt beim Hub als `TypeError
   * "terminated"` aus `fetch` an, also im `catch` nach der ersten Zeile
   * (#130).
   */
  tear: () => void;
  close: () => Promise<void>;
};

async function startAgent(): Promise<FakeAgent> {
  let open: http.ServerResponse | null = null;
  let announce: () => void = () => undefined;
  const state: FakeAgent = {
    port: 0,
    mode: { kind: "stream" },
    seen: [],
    hungUp: 0,
    arrived: new Promise<void>((resolve) => {
      announce = resolve;
    }),
    push: (chunk) => open?.write(chunk),
    finish: () => open?.end(),
    tear: () => open?.socket?.destroy(),
    close: async () => undefined
  };

  const server = http.createServer((request, response) => {
    state.seen.push({
      url: request.url ?? "",
      actor: request.headers["x-docker-agent-actor"] as string | undefined,
      secret: request.headers["x-docker-agent-secret"] as string | undefined
    });
    if (state.mode.kind === "status") {
      response.writeHead(state.mode.status, { "content-type": "application/json" });
      response.end(state.mode.body);
      return;
    }
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform"
    });
    // ⚠️ `writeHead` allein schiebt in Node nichts auf die Leitung — die
    // Kopfzeilen gingen erst mit dem ersten `write` hinaus. Ein Agent, der so
    // antwortete, ließe jeden Aufrufer in die Frist des Verbindungsaufbaus
    // laufen; der echte flusht. Ohne diese Zeile prüfte der Test etwas anderes
    // als das, was im Betrieb steht.
    response.flushHeaders();
    open = response;
    // Der Hub hat aufgelegt, bevor der Strom von selbst endete. GENAU DAS ist
    // der Nachweis für die Bindung an die Browserverbindung.
    request.on("close", () => {
      if (!response.writableEnded) state.hungUp += 1;
    });
    announce();
  });

  await listenOnFetchablePort(server);
  state.port = (server.address() as AddressInfo).port;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
  return state;
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

// ⚠️ Dieselbe Haltung wie `fakePool` in `theme-routes.test.ts`: eine
// Anweisung, die diese Attrappe nicht wiedererkennt, wirft — und bleibt so.
// Ein Pool, der auf alles mit einer leeren Antwort reagiert, machte einen
// Test grün, der die falsche Tabelle anspricht.
function fakePool(tailLines: number = DEFAULT_LOG_TAIL_LINES): Pool {
  return {
    query: (text: string) => {
      if (/^\s*SELECT agent_secret FROM docker_host/s.test(text)) {
        return Promise.resolve({ rows: [{ agent_secret: ROW_SECRET }], rowCount: 1 });
      }
      if (/^\s*SELECT tail_lines FROM log_settings/s.test(text)) {
        return Promise.resolve({ rows: [{ tail_lines: tailLines }], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  } as unknown as Pool;
}

type Hub = { port: number; close: () => Promise<void> };

// The health the hub sees from the arm. Injected, so the probe asks no
// listener of these tests: the fake agents below answer only streams.
const CURRENT_HEALTH: AgentHealth = {
  reachable: true,
  version: "0.32.0",
  contractVersion: 13,
  readOnly: false,
  entries: null
};

async function startHub(
  host: HostRecord | null,
  options: { tailLines?: number; health?: AgentHealth } = {}
): Promise<Hub> {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(),
      pool: fakePool(options.tailLines),
      repository: {
        find: (id: string) => Promise.resolve(host && host.id === id ? host : null),
        list: () => Promise.resolve(host ? [host] : [])
      } as unknown as HostRepository,
      enrollment: {} as unknown as Enrollment,
      agentSecret: "unbenutzt",
      config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
      probeHost: () => Promise.resolve(options.health ?? CURRENT_HEALTH)
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

function logsUrl(port: number, query = "?tail=42", hostId = "host-1", containerId = "abc123"): string {
  return `http://127.0.0.1:${port}/api/hosts/${hostId}/containers/${containerId}/logs-stream${query}`;
}

// ⚠️ `sec-fetch-site: same-origin` gehört seit Etappe B4b-K (#5) dazu, und
// zwar nicht als Beruhigungspflaster für die Schranke: dieser Test stellt den
// Browser der eigenen Oberfläche nach, und der setzt diesen Kopf. Die Route
// steht seither in `GET_ROUTES_WITH_EFFECT` (`platform/http/request-origin.ts`) — sie
// belegt einen der Ströme des Arms und schreibt in dessen Audit-Log unter
// dem Namen des angemeldeten Menschen, und beides darf kein Fremder auslösen.
// Ein `fetch` OHNE diesen Kopf ist ab da genau der Fall, den die Schranke mit
// `403` beantwortet, und das ist richtig so; wie sie sich in den vier
// Herkünften verhält, prüft `request-origin-routing.test.ts`.
function call(url: string, signal?: AbortSignal): Promise<globalThis.Response> {
  return fetch(url, { headers: { [ROLE_HEADER]: "user", "sec-fetch-site": "same-origin" }, signal });
}

/**
 * Liest so lange, bis der gesammelte Text die Bedingung erfüllt.
 *
 * ⚠️ Mit eigener Frist. Ohne sie hinge eine SAMMELNDE Fassung des Servers hier
 * bis zum Ende des ganzen Laufs, und der Befund läse sich als „Zeitüberschreitung"
 * statt als „der Strom ist keiner".
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
  label: string
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = setTimeout(() => void reader.cancel(), 3_000);
  try {
    while (!done(text)) {
      const step = await reader.read();
      if (step.done) break;
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    clearTimeout(deadline);
  }
  assert.ok(done(text), `${label} — gelesen wurde: ${JSON.stringify(text)}`);
  return text;
}

/** Liest bis zum Ende des Stroms. */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    text += decoder.decode(step.value, { stream: true });
  }
  return text + decoder.decode();
}

function envelope(text: string, stream: "stdout" | "stderr" = "stdout"): string {
  return `${JSON.stringify({ kind: "line", stream, ts: "2026-09-07T10:00:00.000Z", text })}\n`;
}

// ── 1. Der Strom reicht Zeilen EINZELN durch ────────────────────────────────

test("jede Zeile ist da, bevor die nächste geschickt wird", async () => {
  // ⚠️ DER EIGENTLICHE NACHWEIS DIESER ETAPPE. Eine Fassung, die den Strom des
  // Agenten erst vollständig liest und dann ein Feld ausliefert, käme hier
  // nicht über die erste Erwartung hinaus — sie wartete auf ein Ende, das der
  // Test erst danach schickt.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(logsUrl(hub.port));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);

    agent.push(`${JSON.stringify({ kind: "start", containerName: "immich", tty: false })}\n`);
    agent.push(envelope("erste"));
    await readUntil(reader, (text) => text.includes('"erste"'), "die erste Zeile kam nicht an");

    // Erst JETZT die zweite. Sie kann in keinem Puffer gelegen haben.
    agent.push(envelope("zweite", "stderr"));
    await readUntil(reader, (text) => text.includes('"zweite"'), "die zweite Zeile kam nicht an");

    agent.finish();
    assert.equal(await readAll(reader), "", "nach dem Ende des Agenten kam noch etwas nach");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("der Aufrufer und das Geheimnis des Arms kommen beim Agenten an", async () => {
  // Der Aufrufer ist im Audit-Log des Agenten die einzige Spur, die auf einen
  // Menschen zeigt. Ein konstantes `system:hub` machte jede Logeinsicht anonym.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const controller = new AbortController();
    const response = await call(logsUrl(hub.port, "?tail=7"), controller.signal);
    await agent.arrived;
    assert.deepEqual(
      agent.seen.map((entry) => entry.url),
      ["/containers/abc123/logs-stream?tail=7"]
    );
    assert.equal(agent.seen[0]?.actor, "user:user-1");
    assert.equal(agent.seen[0]?.secret, ROW_SECRET);
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein Arm unter dem aktuellen Vertrag wird 409 agent-outdated, und sein Strom wird nicht geöffnet", async () => {
  // v0.31.0 streams `zeile` instead of `line` (#278). Without this answer the
  // view showed an open, empty log while the container kept writing.
  const agent = await startAgent();
  const hub = await startHub(
    { ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` },
    { health: { ...CURRENT_HEALTH, version: "0.31.0", contractVersion: 3 } }
  );
  try {
    const response = await call(logsUrl(hub.port, "?tail=7"));
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error?: string }).error, "agent-outdated");
    assert.deepEqual(agent.seen, []);
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 2. und 3. Die Fehler des Agenten VOR der ersten Zeile ───────────────────

test("ein 429 des Agenten wird 429 too-many-streams", async () => {
  // ⚠️ Die Kennung wird ÜBERSETZT und nicht durchgereicht. Der Agent sendet
  // `too-many-streams`; das ist SEIN Wort. Die Kennungen des Hubs sind
  // englisch, und die Oberfläche liest nur die.
  const agent = await startAgent();
  agent.mode = { kind: "status", status: 429, body: JSON.stringify({ error: "too-many-streams" }) };
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(logsUrl(hub.port));
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "too-many-streams");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein 403 des Agenten wird 403 und nennt die Stelle statt einer Ursache", async () => {
  // Das Gate des Agenten prüft `registry.isAllowed()` auch für rein lesende
  // Aktionen (`src/index.ts:1483`). Ein Container außerhalb seiner Allowlist —
  // insbesondere ein fremdverwalteter — wird abgelehnt
  // (`dashboard-docker-agent#78`). Das ist erwartetes Verhalten und kein
  // Fehler dieses Pakets; die Meldung darf deshalb keine Ursache behaupten.
  const agent = await startAgent();
  agent.mode = { kind: "status", status: 403, body: JSON.stringify({ error: "nicht-erlaubt" }) };
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(logsUrl(hub.port));
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "agent-forbidden");
    assert.match(body.message, /Audit-Log/);
    assert.doesNotMatch(body.message, /DOCKER_AGENT_SECRET/);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein unerreichbarer Agent wird 502 und nicht 500", async () => {
  const agent = await startAgent();
  const port = agent.port;
  // Zuhörer weg, Port bleibt in der Adresse stehen: genau die Lage eines
  // Arms, dessen Tunnel steht und dessen Agent nicht läuft.
  await agent.close();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${port}` });
  try {
    const response = await call(logsUrl(hub.port));
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "agent-unreachable");
  } finally {
    await hub.close();
  }
});

// ── 4. Unbekannter Host ─────────────────────────────────────────────────────

test("ein unbekannter Host wird 404 host-unknown, und der Agent hört nichts", async () => {
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(logsUrl(hub.port, "?tail=42", "gibt-es-nicht"));
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "host-unknown");
    assert.deepEqual(agent.seen, NOTHING_ASKED, "der Agent wurde trotz unbekanntem Host angesprochen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 5. tail ─────────────────────────────────────────────────────────────────

test("ein tail außerhalb 1..2000 wird 400, und NULL verlässt den Hub nie", async () => {
  // ⚠️ Der wichtigste der vier Fälle ist `tail=0`: beim Agenten ist das ein
  // interner Alarmstrom, der nur NEUE Zeilen liefert und keine Vergangenheit
  // (`safeTail`, `src/index.ts:3743`). Ein Log-Reiter, der so aufginge, wäre
  // leer und sähe aus wie ein stiller Container.
  //
  // ⚠️ `400` und nicht `500`: ein Wert, den der Aufrufer geschickt hat, ist
  // ein Fehler des Aufrufers. Und kein stiller Rückfall auf die globale
  // Einstellung — ein Rückfall quittierte eine Anfrage, die so nie gestellt
  // wurde.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    for (const query of ["?tail=0", "?tail=2001", "?tail=-1", "?tail=zwei", "?tail=1.5"]) {
      const response = await call(logsUrl(hub.port, query));
      assert.equal(response.status, 400, `tail „${query}" wurde angenommen`);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "invalid-tail");
    }
    assert.deepEqual(agent.seen, NOTHING_ASKED, "ein ungültiges tail ist bis zum Agenten durchgereicht worden");

    // Die Gegenprobe: die beiden Ränder gehen durch und kommen unverändert an.
    for (const tail of [1, 2000]) {
      const controller = new AbortController();
      const response = await call(logsUrl(hub.port, `?tail=${tail}`), controller.signal);
      assert.equal(response.status, 200);
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
    }
    assert.deepEqual(
      agent.seen.map((entry) => entry.url),
      ["/containers/abc123/logs-stream?tail=1", "/containers/abc123/logs-stream?tail=2000"]
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein gültiges tail, das keiner der vier Einstellungswerte ist, geht unverändert durch", async () => {
  // Die vier Werte aus `LOG_TAIL_LINE_OPTIONS` sind die Auswahl, die die
  // OBERFLÄCHE anbietet — nicht der Vertrag, den diese Route zulässt. Der
  // Agent selbst nimmt jede ganze Zahl 1..2000 (`Math.min(tail,
  // MAX_LOG_TAIL_LINES)` in `resolveLogTail`, `agent/src/log-tail.ts`).
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const controller = new AbortController();
    const response = await call(logsUrl(hub.port, "?tail=137"), controller.signal);
    assert.equal(response.status, 200);
    await agent.arrived;
    assert.deepEqual(
      agent.seen.map((entry) => entry.url),
      ["/containers/abc123/logs-stream?tail=137"]
    );
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("fehlt tail, geht der Wert aus log_settings an den Agenten — nicht die eingebaute Vorgabe", async () => {
  // ⚠️ Geprüft wird das TAIL, DAS DER AGENT TATSÄCHLICH EMPFANGEN HAT, nicht
  // der Statuscode — die Attrappe des Agenten sieht die Anfrage-URL. Ein
  // Test, der nur `200` läse, bliebe grün, wenn die Route heimlich eine
  // andere Zeilenzahl schickt.
  //
  // ⚠️ Die Einstellung steht hier bewusst auf 2000 und NICHT auf
  // `DEFAULT_LOG_TAIL_LINES` (500): ein Test gegen 500 bliebe grün, auch wenn
  // die Route `log_settings` gar nicht liest und einfach die eingebaute
  // Vorgabe nimmt — genau der Fall, den dieser Test ausschließen soll.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` }, { tailLines: 2000 });
  try {
    const controller = new AbortController();
    const response = await call(logsUrl(hub.port, ""), controller.signal);
    assert.equal(response.status, 200);
    await agent.arrived;
    assert.deepEqual(
      agent.seen.map((entry) => entry.url),
      ["/containers/abc123/logs-stream?tail=2000"]
    );
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── 6. Der Abbruch des Browsers ─────────────────────────────────────────────

test("bricht der Browser ab, kappt der Hub den Strom zum Agenten", async () => {
  // ⚠️ Ohne diese Bindung liefe der Strom zum Agenten weiter und belegte einen
  // der Plätze (`MAX_OPEN_STREAMS`), bis der Agent es selbst merkt. So viele
  // verlassene Reiter, und die Fläche antwortet allen mit 429 — der
  // Fehler wäre dann an einer ganz anderen Stelle sichtbar als seine Ursache.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const controller = new AbortController();
    const response = await call(logsUrl(hub.port), controller.signal);
    assert.equal(response.status, 200);
    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);
    agent.push(envelope("noch da"));
    await readUntil(reader, (text) => text.includes('"noch da"'), "die erste Zeile kam nicht an");
    assert.equal(agent.hungUp, 0);

    controller.abort();
    // Bis der Abbruch beide Verbindungen durchlaufen hat.
    for (let attempt = 0; attempt < 100 && agent.hungUp === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(agent.hungUp, 1, "der Hub hat den Strom zum Agenten offen gelassen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── Der Fehler NACH der ersten Zeile ────────────────────────────────────────

test("ein fehler-Ereignis des Agenten wird als Zeile durchgereicht, nicht als Status", async () => {
  // Sobald die erste Zeile draußen ist, steht der Status fest. Ein
  // `response.status(…)` an dieser Stelle wirft — bleiben kann nur die Zeile.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(logsUrl(hub.port));
    assert.equal(response.status, 200);
    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);
    agent.push(envelope("etwas"));
    agent.push(`${JSON.stringify({ kind: "error", reason: "logs-fehlgeschlagen" })}\n`);
    agent.finish();
    const text = await readAll(reader);
    assert.match(text, /"kind":"error"/);
    assert.match(text, /"reason":"logs-fehlgeschlagen"/);
    // Der Status war und bleibt 200 — das ist der Preis eines Stroms und nicht
    // ein verschluckter Fehler.
    assert.equal(response.status, 200);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("reißt der Rumpf zum Agenten ab, steht der eigene Grund des Hubs im Strom", async () => {
  // ⚠️ DER KERN VON #130. Bis hierher schrieb der Hub an dieser Stelle
  // `abgebrochen` — den Wert, mit dem der Agent bis v0.23.0 ausschließlich „der
  // Aufrufer hat abgebrochen" meinte. Ein Ausfall des Arms und ein
  // geschlossener Reiter kamen im Browser als dasselbe Wort an, und die Anzeige
  // konnte sie nicht auseinanderhalten.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(logsUrl(hub.port));
    assert.equal(response.status, 200);
    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);
    agent.push(envelope("noch da"));
    await readUntil(reader, (text) => text.includes('"noch da"'), "die erste Zeile kam nicht an");

    agent.tear();
    const text = await readAll(reader);
    assert.match(text, /"kind":"error"/, "der abgerissene Rumpf hat gar keine Zeile hinterlassen");
    assert.match(text, /"reason":"agent-stream-broken"/);
    // Und ausdrücklich NICHT der Wert, der drüben den Abbruch des Aufrufers
    // meinte. Die Verneinung ist hier der Gegenstand des Falls, nicht Beiwerk.
    assert.ok(!text.includes('"reason":"abgebrochen"'), text);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("bricht der Browser ab, schreibt der Hub gar keinen Grund", async () => {
  // Die zweite Hälfte von #130, und die interessantere: der Abbruch ist der
  // NORMALFALL. Die Verbindung, auf der die Zeile ankommen müsste, ist genau
  // die, die gerade zugegangen ist — sie hat keinen Leser. Nachgewiesen wird
  // das am Agenten und nicht am Browser: dass der Hub den Strom kappt, statt in
  // seinen Fehlerzweig zu laufen, zeigt sich daran, dass er DANACH nichts mehr
  // schreibt.
  //
  // ⚠️ GEMESSEN WIRD AM `writableEnded` DER HUB-ANTWORT, nicht an einem
  // gelesenen Text: nach `controller.abort()` ist der Leser fort, und was der
  // Hub dann noch schriebe, sähe niemand mehr. Genau das ist die Aussage.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const controller = new AbortController();
    const response = await call(logsUrl(hub.port), controller.signal);
    assert.equal(response.status, 200);
    await agent.arrived;
    const reader = response.body?.getReader();
    assert.ok(reader);
    agent.push(envelope("noch da"));
    await readUntil(reader, (text) => text.includes('"noch da"'), "die erste Zeile kam nicht an");

    controller.abort();
    for (let attempt = 0; attempt < 100 && agent.hungUp === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(agent.hungUp, 1, "der Hub hat den Strom zum Agenten offen gelassen");
    // Der Hub darf keine Fehlerzeile mehr in eine Verbindung schreiben, die es
    // nicht mehr gibt. Was er tatsächlich geschrieben hat, steht im Zuhörer:
    // nach dem Abbruch kam nichts mehr an.
    assert.equal(agent.seen.length, 1, "der Hub hat den Strom neu aufgebaut");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ohne Anmeldung gibt es keinen Strom", async () => {
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    // ⚠️ MIT `sec-fetch-site: same-origin` und ohne Rollenkopf, und der
    // Unterschied ist der ganze Fall: geprüft wird das Fehlen der ANMELDUNG,
    // nicht das Fehlen der Browser-Kopfzeilen. Ohne den Kopf antwortete seit
    // Etappe B4b-K (#5) die Herkunftsprüfung mit `403`, und dieser Fall wäre
    // grün, ohne noch irgendetwas über `withSession` auszusagen.
    const response = await fetch(logsUrl(hub.port), { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(response.status, 401);
    assert.deepEqual(agent.seen, NOTHING_ASKED, "der Agent wurde ohne Anmeldung angesprochen");
  } finally {
    await hub.close();
    await agent.close();
  }
});

// ── Die Messwerte eines Containers (#213) ───────────────────────────────────

function statsUrl(port: number, containerId = "abc123"): string {
  return `http://127.0.0.1:${port}/api/hosts/host-1/containers/${containerId}/stats`;
}

test("die Messwerte samt Verlauf kommen aus der Einzelansicht des Agenten", async () => {
  const samples = [
    { sampledAt: "2026-09-30T10:00:00.000Z", cpuPercent: null, memUsageBytes: 10, memLimitBytes: null },
    { sampledAt: "2026-09-30T10:00:10.000Z", cpuPercent: 2.5, memUsageBytes: 20, memLimitBytes: null }
  ];
  const agent = await startAgent();
  agent.mode = {
    kind: "status",
    status: 200,
    body: JSON.stringify({
      id: "abc123",
      name: "immich",
      stats: { cpuPercent: 2.5, memUsageBytes: 20, memLimitBytes: null, sampledAt: samples[1].sampledAt, samples }
    })
  };
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(statsUrl(hub.port));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { stats: { samples: unknown[]; cpuPercent: number | null } };
    // The web parses this response against the contract (#248).
    const parsed = containerStatsResponseSchema.safeParse(body);
    assert.ok(parsed.success, `GET …/stats does not match the schema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data, body);
    assert.deepEqual(body.stats.samples, samples);
    assert.equal(body.stats.cpuPercent, 2.5);
    assert.deepEqual(
      agent.seen.map((entry) => entry.url),
      ["/containers/abc123"]
    );
    assert.equal(agent.seen[0]?.actor, "user:user-1");
    assert.equal(agent.seen[0]?.secret, ROW_SECRET);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("ein abgelehnter Container wird 403 und nicht 500", async () => {
  const agent = await startAgent();
  agent.mode = { kind: "status", status: 403, body: JSON.stringify({ error: "nicht-erlaubt" }) };
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await call(statsUrl(hub.port));
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "agent-forbidden");
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("die Messwerte-Route lässt keine fremde Seite an den Agenten", async () => {
  // Sie steht in `GET_ROUTES_WITH_EFFECT`: die Einzelansicht schreibt bei
  // einer Ablehnung in das Audit-Log des Agenten, unter dem Menschen.
  const agent = await startAgent();
  const hub = await startHub({ ...HOST, agentUrl: `http://127.0.0.1:${agent.port}` });
  try {
    const response = await fetch(statsUrl(hub.port), {
      headers: { [ROLE_HEADER]: "user", "sec-fetch-site": "cross-site" }
    });
    assert.equal(response.status, 403);
    assert.deepEqual(agent.seen, NOTHING_ASKED);
  } finally {
    await hub.close();
    await agent.close();
  }
});
