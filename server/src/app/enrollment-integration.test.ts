import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import type { Pool } from "pg";

import { createApiRouter } from "./router.js";
import type { Auth } from "../platform/auth/auth.js";
import { runAgentSimulator, type SimulatorConfig } from "../platform/testing/agent-simulator.js";
import {
  ARCHIVE_FILE_NAMES,
  SIDECAR_LISTEN_PORT,
  createEnrollment,
  createRegistrationApp,
  createRegistrationDeps,
  generateWireGuardKeyPair,
  type Enrollment,
  type EnrollmentConfig
} from "../features/hosts/index.js";
import {
  hashRegistrationToken,
  HostError,
  MAX_REGISTRATION_ATTEMPTS,
  MIN_REGISTRATION_TOKEN_LENGTH,
  normalizeTunnelAddress,
  type HostRecord,
  type HostRepository
} from "../domain/hosts/index.js";
import { CONTRACT_VERSION, DEFAULT_HOST_THEME, hostResponseSchema } from "contract";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die ganze Fläche einmal durch — vom angemeldeten Admin bis zum Peer-Eintrag
// in der wg0.conf, ohne Postgres, ohne Docker und ohne ein Netz außerhalb von
// 127.0.0.1.
//
// Was diese Ebene fängt und kein Bausteintest fängt:
//
//   1. Die Reihenfolge über Modulgrenzen hinweg. `enrollment.test.ts` prüft,
//      dass `regenerateArchive` die Peer-Liste neu schreibt; hier wird die
//      geschriebene DATEI nach einem echten `GET /hosts/:id/archive` gelesen.
//      Ein Weg, der an der Verdrahtung vorbei rotiert, ist dort grün und hier
//      rot — und im Betrieb ein Sidecar auf dem alten Schlüssel.
//   2. Dass beide Seiten dieselbe Anfrage meinen: der Anmelde-Client ist
//      nachgebaut (`platform/testing/agent-simulator.ts`, Vorlage v0.18.1) und
//      spricht über einen echten Socket. Ein Hub, der sein eigenes Protokoll
//      gegen sich selbst prüft, ist grün und trotzdem unerreichbar.
//   3. Dass das Archiv wirklich ein Archiv ist: es wird mit `tar -xzf`
//      ausgepackt, so wie der Betreiber es auspackt, und die `.env` daraus
//      gelesen. Ein Strom, den nur der eigene Leser versteht, fiele sonst erst
//      auf dem Zielhost auf.
//   4. Die Rolle. „User liest, Admin schreibt" an allen drei schreibenden
//      Routen, über echte Anfragen und nicht am Quelltext.
//
// ⚠️ Das Tunnelnetz dieses Tests IST das Loopback-Netz (127.0.0.0/8). Der
// Grund ist die Quelladresse: die Anmeldung läuft über einen echten Socket,
// und dessen Gegenstelle kann hier nichts anderes sein als 127.0.0.1. Ein Arm
// bekommt deshalb 127.0.0.1; der Hub sitzt auf einer anderen Adresse desselben
// Netzes, denn der Archiv-Erzeuger lehnt zwei gleiche Adressen ab.
//
// ⚠️ Am Wert aus dem Archiv wird für den Anmeldelauf GENAU EINES ersetzt: der
// Hostname der Anmelde-URL. Der Port ist der echte des Zuhörers, der Pfad
// kommt unverändert aus dem Archiv, und Hostname wie Port werden vorher
// ausdrücklich gegen die Konfiguration geprüft. Ein Hub, der die URL falsch
// zusammensetzt, fällt an dieser Prüfung und nicht an der Ersetzung.

const HUB_KEYS = generateWireGuardKeyPair();

const ROLE_HEADER = "x-integration-role";
const AGENT_VERSION = "0.32.0";
const DEFAULT_AGENT_PORT = 8099;

// Ein Netz, das 127.0.0.1 enthält, und ein Hub, der nicht darauf sitzt.
const TUNNEL = {
  cidr: "127.0.0.0/8",
  networkAddress: "127.0.0.0",
  prefixLength: 8,
  hubAddress: "127.255.255.254",
  firstArmOffset: 1,
  lastArmOffset: 250
} as const;

// Der Pool wird von den Routen dieser Fläche nicht angefasst — nur `/setup`
// braucht ihn. Ein Stummel, der laut wird, statt still etwas zu liefern.
const NO_POOL = {
  query: () => {
    throw new Error("Dieser Test fasst keine Datenbank an — hier ist eine Route auf den Pool ausgewichen.");
  }
} as unknown as Pool;

// ── Der Bestand im Arbeitsspeicher ────────────────────────────────────────
//
// Dieselbe Signatur wie `createPoolRepository` (domain/hosts/host-repository.ts, `HostRepository`)
// und dieselben Entscheidungen wie das SQL in hosts.ts:
//
//   * `consumeToken` prüft Kennung, Zustand, Abdruck, Quelladresse und
//     Fehlzähler in EINEM Schritt und schaltet im selben Schritt um. Kein
//     `await` dazwischen — das ist hier die Entsprechung der einen Anweisung,
//     mit der Postgres zwei gleichzeitige Anmeldungen auf derselben Zeile
//     serialisiert.
//   * `rotate` setzt Zustand, Fehlzähler, `registered_at` und `agent_url`
//     zurück und ersetzt den Abdruck. Das alte Token ist danach tot.
//   * `remove` und `recordFailure` lassen den lokalen Host aus.
//
// Was er NICHT prüft, steht in `domain/hosts/host-store.test.ts`: ob das SQL dasselbe tut.

type StoredHost = {
  record: HostRecord;
  tokenHash: string | null;
  agentSecret: string;
};

type Memory = {
  repository: HostRepository;
  hosts: StoredHost[];
  stored: (id: string) => StoredHost | undefined;
  addLocalHost: () => HostRecord;
  consumeRuns: number;
};

function addressAt(networkAddress: string, offset: number): string {
  const octets = networkAddress.split(".").map(Number);
  const base = octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3] + offset;
  return [Math.floor(base / 2 ** 24) % 256, Math.floor(base / 2 ** 16) % 256, Math.floor(base / 2 ** 8) % 256, base % 256].join(
    "."
  );
}

function createMemoryRepository(): Memory {
  const hosts: StoredHost[] = [];
  const stored = (id: string): StoredHost | undefined => hosts.find((entry) => entry.record.id === id);
  const copy = (entry: StoredHost): HostRecord => ({ ...entry.record });

  const memory: Memory = {
    hosts,
    stored,
    consumeRuns: 0,
    addLocalHost: () => {
      const record: HostRecord = {
        id: randomUUID(),
        name: "lokaler Host",
        agentUrl: "http://docker-agent:8099",
        kind: "local",
        state: "registered",
        tunnelAddress: null,
        wireguardPublicKey: null,
        endpointOverride: null,
        failedAttempts: 0,
        dockerGid: null,
        bindBasePath: null,
        display: DEFAULT_HOST_THEME,
        createdAt: new Date(),
        registeredAt: new Date(),
        lastSeenAt: null
      };
      hosts.push({ record, tokenHash: null, agentSecret: "x".repeat(MIN_REGISTRATION_TOKEN_LENGTH) });
      return { ...record };
    },
    repository: {
      list: async () => hosts.map(copy),
      find: async (id) => {
        const entry = stored(id);
        return entry ? copy(entry) : null;
      },
      findByTunnelAddress: async (address) => {
        const normalized = normalizeTunnelAddress(address);
        if (!normalized) return null;
        const entry = hosts.find((candidate) => candidate.record.tunnelAddress === normalized);
        return entry ? copy(entry) : null;
      },
      create: async (input) => {
        const name = input.name.trim();
        if (!name) throw new HostError("invalid-input", "Der Name des Hosts fehlt.");
        if (input.registrationToken.length < MIN_REGISTRATION_TOKEN_LENGTH) {
          throw new HostError("invalid-input", "Das Anmelde-Token ist zu kurz.");
        }
        if (hosts.some((entry) => entry.record.name === name)) {
          throw new HostError("name-taken", `Ein Host mit dem Namen „${name}" ist bereits eingetragen.`);
        }
        const taken = new Set(hosts.map((entry) => entry.record.tunnelAddress));
        let address: string | null = null;
        for (let offset = TUNNEL.firstArmOffset; offset <= TUNNEL.lastArmOffset; offset += 1) {
          const candidate = addressAt(TUNNEL.networkAddress, offset);
          if (!taken.has(candidate)) {
            address = candidate;
            break;
          }
        }
        if (!address) throw new HostError("address-pool-exhausted", "Im Tunnelnetz ist keine Adresse mehr frei.");

        const port = input.agentPort ?? DEFAULT_AGENT_PORT;
        const record: HostRecord = {
          id: randomUUID(),
          name,
          agentUrl: `http://${address}:${port}`,
          kind: input.kind,
          state: "pending",
          tunnelAddress: address,
          wireguardPublicKey: input.wireguardPublicKey,
          endpointOverride: input.endpointOverride ?? null,
          failedAttempts: 0,
          dockerGid: null,
          bindBasePath: null,
          display: DEFAULT_HOST_THEME,
          createdAt: new Date(),
          registeredAt: null,
          lastSeenAt: null
        };
        hosts.push({
          record,
          tokenHash: hashRegistrationToken(input.registrationToken),
          agentSecret: input.agentSecret
        });
        return { ...record };
      },
      rotate: async (id, input) => {
        const entry = stored(id);
        if (!entry || entry.record.kind === "local") return null;
        entry.record.wireguardPublicKey = input.wireguardPublicKey;
        entry.record.state = "pending";
        entry.record.failedAttempts = 0;
        entry.record.registeredAt = null;
        entry.record.agentUrl = `http://${entry.record.tunnelAddress}:${input.agentPort ?? DEFAULT_AGENT_PORT}`;
        entry.tokenHash = hashRegistrationToken(input.registrationToken);
        entry.agentSecret = input.agentSecret;
        return copy(entry);
      },
      remove: async (id) => {
        const index = hosts.findIndex((entry) => entry.record.id === id && entry.record.kind !== "local");
        if (index < 0) return false;
        hosts.splice(index, 1);
        return true;
      },
      consumeToken: async (claim) => {
        memory.consumeRuns += 1;
        const source = normalizeTunnelAddress(claim.sourceAddress);
        if (!source || !claim.token) return null;
        // Ab hier kein `await`: prüfen und umschalten sind ein Schritt.
        const entry = stored(claim.hostId);
        if (
          !entry ||
          entry.record.kind === "local" ||
          entry.record.state !== "pending" ||
          entry.tokenHash === null ||
          entry.tokenHash !== hashRegistrationToken(claim.token) ||
          entry.record.tunnelAddress !== source ||
          entry.record.failedAttempts >= MAX_REGISTRATION_ATTEMPTS
        ) {
          return null;
        }
        entry.record.state = "registered";
        entry.record.failedAttempts = 0;
        entry.record.registeredAt = new Date();
        entry.tokenHash = null;
        // Aus der VERGEBENEN Tunneladresse und dem gemeldeten Port — nie aus
        // dem `listenHost`, den der Aufrufer nennt.
        entry.record.agentUrl = `http://${entry.record.tunnelAddress}:${claim.listenPort}`;
        return copy(entry);
      },
      recordFailure: async (id) => {
        const entry = stored(id);
        if (!entry || entry.record.kind === "local") return null;
        entry.record.failedAttempts += 1;
        return entry.record.failedAttempts;
      }
    }
  };
  return memory;
}

// ── Sitzung, Zuhörer, Fake-Agent ──────────────────────────────────────────

/**
 * Eine Sitzung, die an einer Kopfzeile hängt — ausschließlich für diesen Test.
 *
 * `requireAdmin` und `withSession` lösen über `auth.api.getSession` auf; genau
 * diese eine Stelle wird hier ersetzt. Damit laufen die Zwischenschicht und
 * ihre Reihenfolge im Router unverändert mit — geprüft wird die Verdrahtung,
 * nicht better-auth.
 *
 * Fail closed wie das Original: was nicht als Rolle erkennbar ist, ist keine
 * Sitzung.
 */
function createRoleAuth(): Auth {
  return {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const role = headers.get(ROLE_HEADER);
        if (role !== "admin" && role !== "user") return null;
        return { user: { id: `${role}-1`, name: role, email: `${role}@example.org`, role } };
      }
    }
  } as unknown as Auth;
}

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

// Der kleine Fake-Agent: genau der eine Endpunkt, den die Gegenprobe befragt.
// Er liegt beim echten Agenten VOR der Secret-Prüfung und nennt die Version —
// deshalb kommt hier auch keine Kopfzeile mit einem Secret an, und es wird
// ausdrücklich geprüft, dass keine gesendet wird.
function createFakeAgent(): { server: http.Server; requests: string[]; secretHeaders: string[] } {
  const requests: string[] = [];
  const secretHeaders: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const secret = request.headers["x-docker-agent-secret"];
    if (typeof secret === "string") secretHeaders.push(secret);
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, version: AGENT_VERSION, contractVersion: CONTRACT_VERSION, readOnly: false }));
      return;
    }
    response.writeHead(404).end();
  });
  return { server, requests, secretHeaders };
}

// ── Der ganze Stapel, wie index.ts ihn verdrahtet ─────────────────────────

type Stack = {
  memory: Memory;
  enrollment: Enrollment;
  config: EnrollmentConfig;
  apiPort: number;
  registrationPort: number;
  agent: { requests: string[]; secretHeaders: string[]; port: number };
  log: string[];
  wireguardConfig: () => string;
  close: () => Promise<void>;
};

async function startStack(): Promise<Stack> {
  const memory = createMemoryRepository();
  const log: string[] = [];

  // Der Anmeldeweg zuerst: sein Port geht als `tunnelPort` in die Anmelde-URL
  // des Archivs, und die soll hier die echte sein und keine nachgebaute.
  const agent = createFakeAgent();
  const agentListener = await listen(agent.server);
  const registrationListener = await listen(
    http.createServer(
      createRegistrationApp(
        createRegistrationDeps({
          repository: memory.repository,
          log: (message) => log.push(message),
          probeTimeoutMs: 2_000
        })
      )
    )
  );

  const directory = mkdtempSync(join(tmpdir(), "hub-enrollment-"));
  const config: EnrollmentConfig = {
    wireguardEndpoint: "hub.example.org",
    // Absichtlich NICHT der Port im Container: läuft der veröffentlichte in
    // die wg0.conf, fällt es an der Marke unten auf.
    wireguardPort: 51999,
    wireguardConfigPath: join(directory, "wg0.conf"),
    tunnelPort: registrationListener.port,
    hubWireguardPrivateKey: HUB_KEYS.privateKey,
    hubWireguardPublicKey: HUB_KEYS.publicKey,
    tunnel: { ...TUNNEL }
  };

  const enrollment = createEnrollment({ repository: memory.repository, config });

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: createRoleAuth(),
      pool: NO_POOL,
      repository: memory.repository,
      enrollment,
      agentSecret: "y".repeat(MIN_REGISTRATION_TOKEN_LENGTH),
      config
    })
  );
  const apiListener = await listen(http.createServer(app));

  return {
    memory,
    enrollment,
    config,
    apiPort: apiListener.port,
    registrationPort: registrationListener.port,
    agent: { requests: agent.requests, secretHeaders: agent.secretHeaders, port: agentListener.port },
    log,
    wireguardConfig: () => readFileSync(config.wireguardConfigPath, "utf8"),
    close: async () => {
      await apiListener.close();
      await registrationListener.close();
      await agentListener.close();
    }
  };
}

type ApiResponse = { status: number; headers: Headers; text: string };

async function call(
  stack: Stack,
  method: string,
  path: string,
  options: { role?: "admin" | "user"; body?: unknown } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    // Was der Browser der eigenen Oberfläche bei jeder Anfrage
    // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
    // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
    // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
    // dieser Fall prüft etwas anderes.
    "sec-fetch-site": "same-origin"
  };
  if (options.role) headers[ROLE_HEADER] = options.role;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${stack.apiPort}/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function createArm(stack: Stack, name: string): Promise<{ id: string; tunnelAddress: string }> {
  const response = await call(stack, "POST", "/hosts", {
    role: "admin",
    // Seit 008 verlangt die Route beide Werte des Zielhosts. 281 ist die
    // Gruppe des Sockets auf dem unraid, an dem #4 gemessen wurde.
    body: { name, kind: "internal", dockerGid: 281, bindBasePath: "/mnt/user/appdata" }
  });
  assert.equal(response.status, 201, response.text);
  // The web parses this response against the contract (#248); a bare host
  // instead of `{ host }` was the D7a bug (#82).
  const body: unknown = JSON.parse(response.text);
  const parsed = hostResponseSchema.safeParse(body);
  assert.ok(parsed.success, `POST /hosts does not match hostResponseSchema: ${JSON.stringify(parsed.error?.issues)}`);
  assert.deepEqual(parsed.data, body);
  const { host } = parsed.data;
  assert.ok(host.tunnelAddress !== null, "an internal arm gets a tunnel address");
  return { id: host.id, tunnelAddress: host.tunnelAddress };
}

// ── Das Archiv, ausgepackt wie beim Betreiber ─────────────────────────────

type Unpacked = {
  directory: string;
  env: Map<string, string>;
  files: string[];
};

/**
 * Schreibt den Strom in eine Datei und packt ihn mit `tar -xzf` aus.
 *
 * ⚠️ Ausdrücklich das Werkzeug des Systems und kein eigener Leser. Ein tar, das
 * nur der eigene Parser versteht — falsche Blockgröße, fehlende Prüfsumme,
 * abgeschnittener Abschluss —, kommt sonst durch jeden Test und scheitert beim
 * Betreiber. `cwd` statt eines Pfades im Argument, weil ein Windows-Pfad mit
 * Laufwerksbuchstaben für manche tar-Fassungen wie eine entfernte Quelle
 * aussieht.
 */
function unpackArchive(body: Buffer): Unpacked {
  const directory = mkdtempSync(join(tmpdir(), "hub-archive-"));
  writeFileSync(join(directory, "archive.tar.gz"), body);
  execFileSync("tar", ["-xzf", "archive.tar.gz"], { cwd: directory, stdio: "pipe" });

  const env = new Map<string, string>();
  for (const line of readFileSync(join(directory, ".env"), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    env.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return { directory, env, files: [...ARCHIVE_FILE_NAMES] };
}

async function fetchArchive(stack: Stack, hostId: string): Promise<{ response: Response; unpacked: Unpacked }> {
  const response = await fetch(`http://127.0.0.1:${stack.apiPort}/api/hosts/${hostId}/archive`, {
    headers: {
      // Was der Browser der eigenen Oberfläche bei jeder Anfrage
      // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
      // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
      // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
      // dieser Fall prüft etwas anderes.
      "sec-fetch-site": "same-origin",
      [ROLE_HEADER]: "admin"
    }
  });
  assert.equal(response.status, 200);
  const unpacked = unpackArchive(Buffer.from(await response.arrayBuffer()));
  return { response, unpacked };
}

/**
 * Die Anmelde-URL aus dem Archiv — geprüft und dann auf den Zuhörer gelenkt.
 *
 * Geprüft wird alles, was der Hub entscheidet: Schema, Hostname, Port und
 * Pfad. Ersetzt wird nur der Hostname, weil 127.255.255.254 auf keinem der
 * beiden Betriebssysteme dieses Repos verlässlich erreichbar ist.
 */
function simulatorConfig(stack: Stack, unpacked: Unpacked, hostId: string, agentPort: number): SimulatorConfig {
  const raw = unpacked.env.get("DOCKER_AGENT_REGISTRATION_URL");
  assert.ok(raw, "im Archiv steht keine DOCKER_AGENT_REGISTRATION_URL");
  const url = new URL(raw);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, stack.config.tunnel.hubAddress);
  assert.equal(url.port, String(stack.config.tunnelPort));
  assert.equal(url.pathname, `/hosts/${hostId}/register`);
  assert.equal(url.search, "", "kein Token in der URL — die steht im Zugriffslog jedes Proxys");

  const token = unpacked.env.get("DOCKER_AGENT_REGISTRATION_TOKEN");
  assert.ok(token && token.length >= MIN_REGISTRATION_TOKEN_LENGTH);

  url.hostname = "127.0.0.1";
  return {
    registrationUrl: url.toString(),
    registrationToken: token,
    agentVersion: AGENT_VERSION,
    // Ein frisch aufgesetzter Arm meldet regelmäßig 0.0.0.0 — der Hub darf
    // darauf nichts stützen.
    listenHost: "0.0.0.0",
    listenPort: agentPort,
    readOnly: false
  };
}

// ── Der Regelweg ──────────────────────────────────────────────────────────

test("Admin legt einen Arm an, packt sein Archiv aus, der Agent meldet sich an", async () => {
  const stack = await startStack();
  try {
    const arm = await createArm(stack, "arm-eins");
    assert.equal(arm.tunnelAddress, "127.0.0.1");

    // Der Peer steht in der Datei, BEVOR das Archiv herausgeht — sonst kann
    // die Anmeldung gar nicht ankommen.
    const beforeArchive = stack.wireguardConfig();
    assert.match(beforeArchive, /^AllowedIPs = 127\.0\.0\.1\/32$/m);
    assert.match(beforeArchive, new RegExp(`^ListenPort = ${SIDECAR_LISTEN_PORT}$`, "m"));
    assert.ok(
      !beforeArchive.includes(String(stack.config.wireguardPort)),
      "der veröffentlichte Port hat in der wg0.conf des Hubs nichts zu suchen"
    );

    const { response, unpacked } = await fetchArchive(stack, arm.id);
    assert.equal(response.headers.get("content-type"), "application/gzip");
    // Drei Geheimnisse im Strom: er gehört in keinen Zwischenspeicher.
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="arm-eins-agent\.tar\.gz"/);
    for (const name of unpacked.files) {
      assert.ok(readFileSync(join(unpacked.directory, name), "utf8").length > 0, `${name} fehlt im Archiv`);
    }

    const secret = unpacked.env.get("DOCKER_AGENT_SECRET");
    assert.ok(secret && secret.length >= MIN_REGISTRATION_TOKEN_LENGTH);
    assert.equal(unpacked.env.get("DOCKER_AGENT_HOST"), "127.0.0.1");

    const result = await runAgentSimulator(simulatorConfig(stack, unpacked, arm.id, stack.agent.port), {
      firstWaitMs: 5,
      maxAttempts: 3
    });
    assert.deepEqual(result, { outcome: "registered", attempts: 1 });

    const record = stack.memory.stored(arm.id);
    assert.equal(record?.record.state, "registered");
    // Das Token ist verbraucht, und die Adresse kommt aus der vergebenen
    // Tunneladresse und dem GEMELDETEN Port — nicht aus 0.0.0.0 und nicht aus
    // dem Vorgabe-Port 8099.
    assert.equal(record?.tokenHash, null);
    assert.equal(record?.record.agentUrl, `http://127.0.0.1:${stack.agent.port}`);
    assert.equal(stack.memory.consumeRuns, 1);

    // Die Gegenprobe hat stattgefunden, genau einmal — und ohne Secret, weil
    // `/health` beim Agenten vor der Secret-Prüfung liegt.
    assert.deepEqual(stack.agent.requests, ["GET /health"]);
    assert.deepEqual(stack.agent.secretHeaders, []);

    // Und was die Oberfläche danach sieht (§4).
    const list = await call(stack, "GET", "/hosts", { role: "user" });
    assert.equal(list.status, 200);
    const { hosts } = JSON.parse(list.text) as { hosts: Record<string, unknown>[] };
    assert.equal(hosts.length, 1);
    assert.deepEqual(Object.keys(hosts[0]).sort(), [
      // Seit #7: das Angebot des Knopfs „Agent aktualisieren“ — Zielfassung,
      // Ziel-Ref und Zustand, kein Geheimnis.
      "agentUpdate",
      "agentUrl",
      "agentVersion",
      // Seit D7a (#62): der Ton und die Stufe des Farbeinsatzes dieses Arms.
      "display",
      "id",
      "kind",
      // Seit #205: wann der Agent zuletzt geantwortet hat.
      "lastSeenAt",
      "name",
      "state",
      "status",
      "tunnelAddress"
    ]);
    assert.equal(hosts[0].status, "online");
    assert.equal(hosts[0].agentVersion, AGENT_VERSION);

    // Kein Token in irgendeiner Logzeile des Anmeldewegs.
    const token = unpacked.env.get("DOCKER_AGENT_REGISTRATION_TOKEN") ?? "";
    assert.deepEqual(stack.log.filter((line) => line.includes(token) || line.includes(secret)), []);
  } finally {
    await stack.close();
  }
});

test("ein frisch angelegter Arm steht als pending in der Liste und wird nicht befragt", async () => {
  const stack = await startStack();
  try {
    const arm = await createArm(stack, "arm-wartend");
    const list = await call(stack, "GET", "/hosts", { role: "user" });
    const { hosts } = JSON.parse(list.text) as { hosts: { id: string; status: string; agentVersion: null }[] };
    assert.deepEqual(hosts.map((host) => [host.id, host.status]), [[arm.id, "pending"]]);
    assert.equal(hosts[0].agentVersion, null);
    // Ein ausstehender Arm wird nicht befragt: die Liste wartete sonst je Arm
    // eine Frist lang.
    assert.deepEqual(stack.agent.requests, []);
  } finally {
    await stack.close();
  }
});

// ── Die Rotation ──────────────────────────────────────────────────────────

test("ein zweites Archiv macht das erste Token ungültig und schreibt die Peer-Liste neu", async () => {
  const stack = await startStack();
  try {
    const arm = await createArm(stack, "arm-rotierend");
    const first = await fetchArchive(stack, arm.id);
    const firstKey = stack.memory.stored(arm.id)?.record.wireguardPublicKey;
    assert.ok(firstKey);
    assert.ok(stack.wireguardConfig().includes(firstKey));

    const second = await fetchArchive(stack, arm.id);
    const secondKey = stack.memory.stored(arm.id)?.record.wireguardPublicKey;
    assert.ok(secondKey);
    assert.notEqual(secondKey, firstKey, "das zweite Archiv trägt dasselbe Schlüsselpaar wie das erste");

    // ⚠️ Der Punkt dieses Tests: die DATEI. Ohne den zweiten Schrieb behielte
    // der Sidecar den alten öffentlichen Schlüssel, das neue Archiv wäre
    // gültig, der Tunnel käme nie zustande — und kein Test, der die Datei
    // nicht liest, würde das zeigen.
    const written = stack.wireguardConfig();
    assert.ok(written.includes(secondKey), "die Peer-Liste trägt den neuen Schlüssel nicht");
    assert.ok(!written.includes(firstKey), "der alte Schlüssel steht noch in der Peer-Liste");

    assert.notEqual(
      first.unpacked.env.get("DOCKER_AGENT_REGISTRATION_TOKEN"),
      second.unpacked.env.get("DOCKER_AGENT_REGISTRATION_TOKEN")
    );
    assert.notEqual(first.unpacked.env.get("DOCKER_AGENT_SECRET"), second.unpacked.env.get("DOCKER_AGENT_SECRET"));

    // Der Agent aus dem ERSTEN Archiv kommt nicht mehr durch: 401 ist für ihn
    // endgültig, und er zählt als Fehlversuch.
    const stale = await runAgentSimulator(simulatorConfig(stack, first.unpacked, arm.id, stack.agent.port), {
      firstWaitMs: 5,
      maxAttempts: 3
    });
    assert.deepEqual(stale, { outcome: "rejected", attempts: 1, status: 401 });
    assert.equal(stack.memory.stored(arm.id)?.record.failedAttempts, 1);
    assert.equal(stack.memory.stored(arm.id)?.record.state, "pending");

    // Das zweite Archiv trägt durch.
    const fresh = await runAgentSimulator(simulatorConfig(stack, second.unpacked, arm.id, stack.agent.port), {
      firstWaitMs: 5,
      maxAttempts: 3
    });
    assert.deepEqual(fresh, { outcome: "registered", attempts: 1 });
    assert.equal(stack.memory.stored(arm.id)?.record.failedAttempts, 0);
  } finally {
    await stack.close();
  }
});

// ── Das Entfernen ─────────────────────────────────────────────────────────

test("DELETE schreibt die Peer-Liste ohne den Peer neu und lässt den anderen Arm stehen", async () => {
  const stack = await startStack();
  try {
    const first = await createArm(stack, "arm-bleibt");
    // Der Stand, auf den das Entfernen zurückführen muss — Zeichen für
    // Zeichen. Ein Vergleich auf „enthält den Schlüssel nicht mehr" ließe eine
    // Datei durchgehen, die daneben etwas anderes verloren hat.
    const withFirstOnly = stack.wireguardConfig();

    const second = await createArm(stack, "arm-geht");
    const firstKey = stack.memory.stored(first.id)?.record.wireguardPublicKey ?? "";
    const secondKey = stack.memory.stored(second.id)?.record.wireguardPublicKey ?? "";

    const before = stack.wireguardConfig();
    assert.ok(before.includes(firstKey) && before.includes(secondKey));
    assert.equal(before.match(/^\[Peer\]$/gm)?.length, 2);

    const removed = await call(stack, "DELETE", `/hosts/${second.id}`, { role: "admin" });
    assert.equal(removed.status, 204);
    assert.equal(removed.text, "");

    const after = stack.wireguardConfig();
    assert.ok(after.includes(firstKey), "der verbliebene Arm ist aus der Peer-Liste gefallen");
    assert.ok(!after.includes(secondKey), "der entfernte Arm steht noch im Tunnel");
    assert.ok(!after.includes(`AllowedIPs = ${second.tunnelAddress}/32`));
    assert.equal(after.match(/^\[Peer\]$/gm)?.length, 1);
    // Die Liste entsteht vollständig aus dem Bestand, nie aus einer Differenz:
    // die Datei ist wieder genau die von vor dem zweiten Arm.
    assert.equal(after, withFirstOnly);

    // Idempotent: der zweite Aufruf meldet 404, keinen Fehler.
    const again = await call(stack, "DELETE", `/hosts/${second.id}`, { role: "admin" });
    assert.equal(again.status, 404);
    assert.equal((JSON.parse(again.text) as { error: string }).error, "host-unknown");

    const list = await call(stack, "GET", "/hosts", { role: "user" });
    const { hosts } = JSON.parse(list.text) as { hosts: { id: string }[] };
    assert.deepEqual(hosts.map((host) => host.id), [first.id]);
  } finally {
    await stack.close();
  }
});

test("der lokale Host lässt sich weder entfernen noch als Archiv holen — 409, nicht 404", async () => {
  const stack = await startStack();
  try {
    const local = stack.memory.addLocalHost();
    const removed = await call(stack, "DELETE", `/hosts/${local.id}`, { role: "admin" });
    assert.equal(removed.status, 409);
    assert.equal((JSON.parse(removed.text) as { error: string }).error, "host-is-local");

    const archive = await call(stack, "GET", `/hosts/${local.id}/archive`, { role: "admin" });
    assert.equal(archive.status, 409);
    assert.equal(stack.memory.hosts.length, 1, "der lokale Host ist trotzdem verschwunden");
  } finally {
    await stack.close();
  }
});

// ── Die Rolle ─────────────────────────────────────────────────────────────

test("user liest, admin schreibt — an allen drei schreibenden Routen", async () => {
  const stack = await startStack();
  try {
    const arm = await createArm(stack, "arm-geschuetzt");
    const keyBefore = stack.memory.stored(arm.id)?.record.wireguardPublicKey;

    const attempts: [string, string, unknown][] = [
      ["POST", "/hosts", { name: "arm-von-user", kind: "internal" }],
      ["GET", `/hosts/${arm.id}/archive`, undefined],
      ["DELETE", `/hosts/${arm.id}`, undefined]
    ];

    for (const [method, path, body] of attempts) {
      const asUser = await call(stack, method, path, { role: "user", body });
      assert.equal(asUser.status, 403, `${method} ${path} steht einem user offen`);
      assert.equal((JSON.parse(asUser.text) as { error: string }).error, "admin-required");

      // Ohne Sitzung: 401 und ebenfalls keine Wirkung.
      const anonymous = await call(stack, method, path, { body });
      assert.equal(anonymous.status, 401, `${method} ${path} steht ohne Sitzung offen`);
      assert.equal((JSON.parse(anonymous.text) as { error: string }).error, "unauthenticated");
    }

    // ⚠️ Die Antwort allein genügt nicht: eine Zwischenschicht HINTER dem
    // Handler antwortete ebenfalls mit 403 — nachdem die Wirkung eingetreten
    // ist. Deshalb wird der Bestand nachgesehen.
    assert.equal(stack.memory.hosts.length, 1, "eine abgelehnte Anfrage hat trotzdem einen Arm angelegt oder entfernt");
    assert.equal(stack.memory.stored(arm.id)?.record.wireguardPublicKey, keyBefore, "ein abgelehnter Abruf hat rotiert");

    // Lesen darf der user.
    const list = await call(stack, "GET", "/hosts", { role: "user" });
    assert.equal(list.status, 200);
  } finally {
    await stack.close();
  }
});

// ── Zwei gleichzeitige Läufe ──────────────────────────────────────────────

test("zwei Arme gleichzeitig angelegt: beide stehen in der Peer-Liste", async () => {
  const stack = await startStack();
  try {
    // ⚠️ Der Fall, für den `createEnrollment` seine Reihung hat: zwischen
    // „Arme lesen" und „Datei schreiben" läge sonst ein Fenster, in dem der
    // zweite Anleger seinen Peer einträgt und der erste ihn mit seinem
    // älteren Stand überschreibt. Der zweite Arm wäre angelegt, sichtbar und
    // nicht im Tunnel — und nichts daran meldete sich von selbst.
    const [left, right] = await Promise.all([
      call(stack, "POST", "/hosts", {
        role: "admin",
        body: { name: "arm-links", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" }
      }),
      call(stack, "POST", "/hosts", {
        role: "admin",
        body: { name: "arm-rechts", kind: "external", dockerGid: 0, bindBasePath: "/srv/docker" }
      })
    ]);
    assert.equal(left.status, 201);
    assert.equal(right.status, 201);

    const written = stack.wireguardConfig();
    assert.equal(written.match(/^\[Peer\]$/gm)?.length, 2);
    for (const entry of stack.memory.hosts) {
      assert.ok(
        written.includes(entry.record.wireguardPublicKey ?? ""),
        `der Arm „${entry.record.name}" steht nicht in der Peer-Liste`
      );
    }
  } finally {
    await stack.close();
  }
});
