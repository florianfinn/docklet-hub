import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express, { Router } from "express";
import type { Pool } from "pg";

import type { AgentHealth, HostRecord, HostRepository } from "../domain/hosts/index.js";
import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import { DEFAULT_HOST_THEME } from "contract";
import { registerShellRoutes, type Scheduler } from "../features/shell/index.js";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die Shell-Fläche über den ganzen Weg: echter Router, echter Express, ein
// kleiner Zuhörer auf 127.0.0.1 als Agent — dasselbe Muster wie
// `container-routes.test.ts` und `file-routes.test.ts`. Kein Postgres, kein
// docker.sock, kein laufender Agent.
//
// ⚠️ WARUM EIN ECHTER ZUHÖRER UND KEINE `fetch`-ATTRAPPE. Die Zusagen dieser
// Etappe sind zwei, und beide sind nur über zwei echte Verbindungen prüfbar:
// dass jede Ausgabezeile DA ist, bevor die nächste geschickt wird (eine
// sammelnde Fassung fiele in einer Attrappe nicht auf), und dass der Hub den
// Strom ZUM ARM beendet, wenn der Browser geht — das sieht nur der Arm selbst.
//
// ⚠️ UND WARUM DER GANZE ROUTER STATT NUR DIESER REGISTRIERFUNKTION. Das
// Sitzungsregister ist Zustand im Speicher und muss GENAU EINE Instanz je
// Router sein. Seit #260 legt `registerShellRoutes` es selbst an; ein Test, der
// es mehrfach aufriefe, bekäme je Aufruf ein eigenes Register und ginge an der
// einen Frage vorbei, die man hier falsch beantworten kann. Der volle Router
// ruft es genau einmal, wie der Betrieb.

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
  createdAt: new Date("2026-09-08T10:00:00.000Z"),
  registeredAt: new Date("2026-09-08T10:05:00.000Z"),
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

export const ROW_SECRET = "das-secret-aus-der-zeile-des-arms";
const ROLE_HEADER = "x-test-role";
export const CONTAINER_ID = "c0ffee";
export const CONTAINER_NAME = "immich";

/** Ein zweiter Arm im Bestand — für den Abgleich „Sitzung auf A, gerufen über B". */
export function secondArm(agent: FakeAgent): HostRecord {
  return { ...HOST, id: "host-2", name: "syno", agentUrl: `http://127.0.0.1:${agent.port}` };
}

// One version at the mark (0.32.0 since #279) and one far below it. They stand
// for "recent enough" and "too old".
const CURRENT: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 10, readOnly: false, entries: null };
export const ANCIENT: AgentHealth = { reachable: true, version: "0.6.0", contractVersion: null, readOnly: false, entries: null };
export const GONE: AgentHealth = { reachable: false, error: "keine Verbindung" };

// ── Der Arm ─────────────────────────────────────────────────────────────────

type ExecReply =
  /** Der Strom: der Test füttert ihn Zeile für Zeile. */
  | { kind: "stream" }
  /** Eine der zwölf Ablehnungen — Status plus Fehlerrumpf. */
  | { kind: "status"; status: number; body: unknown };

export type FakeAgent = {
  port: number;
  /** Wie `POST /containers/:id/exec` beantwortet wird. */
  exec: ExecReply;
  /**
   * Wie die drei kurzen Routen beantwortet werden — je Endung, sonst
   * `200 { ok: true }` wie beim echten Agenten.
   */
  short: Map<"input" | "size" | "close", { status: number; body: unknown }>;
  seen: { method: string; url: string; actor: string | undefined; secret: string | undefined; body: string }[];
  /** Wie oft der Hub eine laufende Verbindung von sich aus gekappt hat. */
  hungUp: number;
  /** Erfüllt, sobald der Strom steht. */
  arrived: Promise<void>;
  push: (chunk: string) => void;
  /** Beendet den Strom ordentlich, aber ohne letzte Zeile — `unterminated`. */
  finish: () => void;
  /**
   * Reißt den Strom ab: der Socket geht zu, ohne dass die Antwort endet. Beim
   * Hub kommt das als Fehler aus dem Lesen des Rumpfs an und nicht als Ende.
   */
  tear: () => void;
  close: () => Promise<void>;
};

export async function startAgent(): Promise<FakeAgent> {
  let open: http.ServerResponse | null = null;
  let announce: () => void = () => undefined;
  const state: FakeAgent = {
    port: 0,
    exec: { kind: "stream" },
    short: new Map(),
    seen: [],
    hungUp: 0,
    arrived: new Promise<void>((resolve) => {
      announce = resolve;
    }),
    push: (chunk) => open?.write(chunk),
    finish: () => open?.end(),
    tear: () => open?.destroy(),
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

      // Die Container-Liste, die `openContainer` vor jedem Zugriff holt.
      if (path === "/containers") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            containers: [
              {
                id: CONTAINER_ID,
                name: CONTAINER_NAME,
                image: "ghcr.io/immich-app/immich-server:v1",
                status: "running",
                running: true
              }
            ]
          })
        );
        return;
      }

      if (path === `/containers/${CONTAINER_ID}/exec`) {
        if (state.exec.kind === "status") {
          response.writeHead(state.exec.status, { "content-type": "application/json" });
          response.end(JSON.stringify(state.exec.body));
          return;
        }
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no"
        });
        // ⚠️ `writeHead` allein schiebt in Node nichts auf die Leitung. Ohne
        // diese Zeile prüfte der Test etwas anderes als das, was im Betrieb
        // steht — der echte Agent flusht.
        response.flushHeaders();
        open = response;
        // ⚠️ AM `response` UND NICHT AM `request`. Gemessen am 2026-09-08:
        // `IncomingMessage` sendet sein `close`, sobald die ANFRAGE
        // vollständig gelesen ist — bei einem POST mit Rumpf also sofort, und
        // der Zähler stünde schon vor dem ersten Byte auf 1. Der `close` der
        // ANTWORT dagegen fällt genau dann, wenn die Verbindung endet; war sie
        // dabei nicht ordentlich beendet (`writableEnded`), hat der Hub
        // aufgelegt. Genau das ist die Frage.
        response.on("close", () => {
          if (!response.writableEnded) state.hungUp += 1;
        });
        announce();
        return;
      }

      // Die drei kurzen Routen des Agenten — ein Muster für alle drei
      // (`exec-protokoll.md` §3).
      const short = /^\/exec\/([^/]+)\/(input|size|close)$/.exec(path);
      if (short) {
        const reply = state.short.get(short[2] as "input" | "size" | "close") ?? { status: 200, body: { ok: true } };
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
        return;
      }

      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unerwartet: ${request.method} ${path}` }));
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

// ── Der Hub ─────────────────────────────────────────────────────────────────

/**
 * Was mit einer bereits aufgelösten Sitzung MITTEN im Strom passieren soll.
 *
 * ⚠️ Ein Halter und kein Kopfzeilenwert: der Kopf einer laufenden Anfrage lässt
 * sich nicht nachträglich ändern, und genau darum geht es bei der wiederholten
 * Rechteprüfung — dieselbe Anfrage, ein zweites Mal aufgelöst, mit einer
 * anderen Antwort. Alle drei Lagen sind die, die `resolveSession` im Betrieb
 * liefern kann: Konto weg, Rolle herabgestuft, Sitzungsmerkmal zeigt auf ein
 * anderes Konto.
 */
export type SessionControl = {
  /** Die Sitzung gibt es nicht mehr (gelöscht, abgelaufen, Break-Glass). */
  revoked: boolean;
  /** Das Konto ist noch da, aber nicht mehr Admin. */
  demoted: boolean;
  /** Das Sitzungsmerkmal zeigt inzwischen auf ein anderes Konto. */
  identity: string | null;
  /** Das Auflösen selbst scheitert — fail closed heißt: das Recht ist weg. */
  broken: boolean;
};

export function newSessionControl(): SessionControl {
  return { revoked: false, demoted: false, identity: null, broken: false };
}

function fakeAuth(control: SessionControl): Auth {
  return {
    api: {
      getSession: ({ headers }: { headers: Headers }) => {
        if (control.broken) return Promise.reject(new Error("die Auflösung der Sitzung ist gestolpert"));
        if (control.revoked) return Promise.resolve(null);
        const role = headers.get(ROLE_HEADER);
        if (role !== "admin" && role !== "user" && role !== "admin-2") return Promise.resolve(null);
        const base = control.demoted ? "user" : role === "admin-2" ? "admin" : role;
        const id = control.identity ?? `${role}-1`;
        return Promise.resolve({
          user: { id, name: role, email: `${role}@example.org`, role: base, language: "de" }
        });
      }
    }
  } as unknown as Auth;
}

// ⚠️ Dieselbe Haltung wie `fakePool` in `file-routes.test.ts`: eine Anweisung,
// die diese Attrappe nicht wiedererkennt, wirft — und bleibt so. Ein Pool, der
// auf alles mit einer leeren Antwort reagiert, machte einen Test grün, der die
// falsche Tabelle anspricht.
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

export type Hub = {
  port: number;
  /**
   * Der Arm, so wie der Bestand ihn führt — VERÄNDERLICH.
   *
   * ⚠️ Ein Halter und keine feste Zeile: einer der Fälle unten entfernt den
   * Arm, WÄHREND eine Sitzung offen ist (`close` muss trotzdem `200`
   * antworten). Mit einem festen Wert wäre das nur mit einem zweiten Hub
   * prüfbar, und der hätte ein zweites, leeres Register.
   */
  arm: { record: HostRecord | null; others: HostRecord[] };
  /** Die Sitzung, wie sie beim NÄCHSTEN Auflösen aussieht. */
  session: SessionControl;
  /**
   * Alles, was der Hub in eine Antwort geschrieben hat, Stück für Stück.
   *
   * ⚠️ DER EINZIGE ZEUGE FÜR EIN SCHWEIGEN. Nach einem Abbruch des Browsers
   * ist der Leser fort; was der Hub dann noch schriebe, sähe kein Test mehr am
   * Leser. Mitgeschnitten wird deshalb an `response.write` selbst (#173).
   */
  written: string[];
  close: () => Promise<void>;
};

export async function startHub(
  options: {
    agent?: FakeAgent;
    host?: HostRecord | null;
    health?: AgentHealth;
    /** Weitere Arme, die der Bestand ebenfalls führt. */
    others?: HostRecord[];
    /**
     * Der Takt der wiederholten Rechteprüfung.
     *
     * ⚠️ IST ER GESETZT, WIRD DER ROUTER ANDERS GEBAUT — und das ist der eine
     * Unterschied, den dieser Prüfstand kennt. `createApiRouter` nimmt keinen
     * Takt entgegen (er gehört zur Shell-Fläche und nicht zum Gerüst der API),
     * also meldet dieser Zweig `registerShellRoutes` an einem eigenen Router an.
     * Der Preis, ehrlich genannt: die Herkunftsprüfung
     * (`router.use(requireTrustedOrigin)`) steht dort NICHT davor. Für die
     * Fälle, die diesen Zweig brauchen, ist das ohne Belang — sie prüfen die
     * Uhr und nicht die Schranke —, und alle übrigen Fälle laufen weiter durch
     * den vollen Router, in dem die Schranke greift.
     */
    schedule?: Scheduler;
  } = {}
): Promise<Hub> {
  const arm: { record: HostRecord | null; others: HostRecord[] } = {
    record:
      options.host === undefined ? { ...HOST, agentUrl: `http://127.0.0.1:${options.agent?.port ?? 0}` } : options.host,
    // ⚠️ Weitere Arme im Bestand, für den Fall „eine Sitzung auf Arm A, gerufen
    // über Arm B". Ohne einen ZWEITEN echten Arm wäre jener Fall grün, ohne
    // etwas zu zeigen: ein `host-2`, den der Bestand gar nicht führt, scheitert
    // schon an der Suche und nie am Abgleich des Registers.
    others: options.others ?? []
  };
  const session = newSessionControl();
  const auth = fakeAuth(session);
  const pool = fakePool();
  const known = (): HostRecord[] => (arm.record ? [arm.record, ...arm.others] : arm.others);
  const repository = {
    find: (id: string) => Promise.resolve(known().find((record) => record.id === id) ?? null),
    list: () => Promise.resolve(known())
  } as unknown as HostRepository;
  // Eingespeist statt gesondet: die Erreichbarkeit ist hier eine Vorbedingung
  // des Falls und keine Messung.
  const probeHost = (): Promise<AgentHealth> => Promise.resolve(options.health ?? CURRENT);

  const written: string[] = [];
  const app = express();
  app.use((_request, response, next) => {
    const original = response.write.bind(response) as (...args: unknown[]) => boolean;
    response.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return original(chunk, ...rest);
    }) as typeof response.write;
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  if (options.schedule) {
    const router = Router({ caseSensitive: true });
    registerShellRoutes(router, {
      auth,
      pool,
      repository,
      agentSecret: "unbenutzt",
      probeHost,
      schedule: options.schedule
    });
    app.use("/api", router);
  } else {
    app.use(
      "/api",
      createApiRouter({
        auth,
        pool,
        repository,
        enrollment: {} as unknown as Enrollment,
        agentSecret: "unbenutzt",
        config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 },
        probeHost
      })
    );
  }
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return {
    port: (server.address() as AddressInfo).port,
    arm,
    session,
    written,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

export function execUrl(hub: Hub, hostId = "host-1", containerId = CONTAINER_ID): string {
  return `http://127.0.0.1:${hub.port}/api/hosts/${hostId}/containers/${containerId}/exec`;
}

/** Eine der drei kurzen Routen, mit der Sitzungs-Id DES HUBS im Pfad. */
export function shortUrl(
  hub: Hub,
  session: string,
  tail: "input" | "size" | "close",
  hostId = "host-1",
  containerId = CONTAINER_ID
): string {
  return `${execUrl(hub, hostId, containerId)}/${encodeURIComponent(session)}/${tail}`;
}

// ⚠️ `sec-fetch-site: same-origin` gehört dazu: alle vier Routen dieser Fläche
// sind POSTs und damit ohnehin prüfpflichtig (`hasEffect` in
// `platform/http/request-origin.ts` gibt für jede nicht-sichere Methode `true` zurück —
// nachgemessen, deshalb steht keine von ihnen in `GET_ROUTES_WITH_EFFECT`).
// Dieser Aufrufer stellt den Browser der eigenen Oberfläche nach.
export function call(
  target: string,
  options: { role?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<globalThis.Response> {
  return fetch(target, {
    method: "POST",
    headers: {
      [ROLE_HEADER]: options.role ?? "admin",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    },
    body: JSON.stringify(options.body ?? {}),
    signal: options.signal
  });
}

/**
 * Liest so lange, bis der gesammelte Text die Bedingung erfüllt.
 *
 * ⚠️ Mit eigener Frist. Ohne sie hinge eine SAMMELNDE Fassung des Servers hier
 * bis zum Ende des ganzen Laufs, und der Befund läse sich als
 * „Zeitüberschreitung" statt als „der Strom ist keiner".
 */
export async function readUntil(
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
export async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    text += decoder.decode(step.value, { stream: true });
  }
  return text + decoder.decode();
}

/** Die `start`-Zeile, wie der Agent sie schickt (`exec-protokoll.md` §2). */
export function agentStart(agentSession = "agent-sitzung-geheim"): string {
  return `${JSON.stringify({ kind: "start", session: agentSession, shell: "bash", containerName: CONTAINER_NAME })}\n`;
}

/**
 * Öffnet eine Shell und liest ihre `start`-Zeile — der Weg jeder kurzen Route.
 *
 * Zurück kommt die Sitzungs-Id DES HUBS. Die des Agenten steht hier nur, weil
 * der Test wissen muss, was der Agent gleich im Pfad erwartet — durch den Hub
 * hinaus geht sie nie, und genau das prüft ein eigener Fall.
 */
export async function openShell(
  hub: Hub,
  agent: FakeAgent,
  options: { role?: string; agentSession?: string } = {}
): Promise<{
  session: string;
  agentSession: string;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  raw: string;
}> {
  const agentSession = options.agentSession ?? "agent-sitzung-geheim";
  const controller = new AbortController();
  const response = await call(execUrl(hub), { role: options.role, signal: controller.signal });
  assert.equal(response.status, 200, "die Shell ging nicht auf");
  const reader = response.body?.getReader();
  assert.ok(reader);
  agent.push(agentStart(agentSession));
  const raw = await readUntil(reader, (text) => text.includes('"start"'), "die start-Zeile kam nicht an");
  const start = envelopes(raw)[0];
  assert.equal(typeof start?.session, "string");
  return { session: String(start?.session), agentSession, controller, reader, raw };
}

/** Die Umschläge des Hubs aus einem gelesenen Strom. */
export function envelopes(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Werkzeug ────────────────────────────────────────────────────────────────

/**
 * Wartet auf eine Bedingung — mit Frist.
 *
 * ⚠️ Eine Attrappe, auf die ein Test wartet, braucht eine Frist. Ohne sie
 * stünde der ganze Lauf still, wenn das Ereignis nicht mehr eintritt, und der
 * Befund läse sich als Umgebungsfehler statt als der Fall, der er ist.
 */
export async function waitFor(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Frist abgelaufen: ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
