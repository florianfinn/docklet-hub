import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { CONTRACT_VERSION } from "contract";

import {
  hashRegistrationToken,
  MAX_REGISTRATION_ATTEMPTS,
  normalizeTunnelAddress,
  probeAgent
} from "../../domain/hosts/index.js";
import { runAgentSimulator, type SimulatorConfig } from "../../platform/testing/agent-simulator.js";
import { createRegistrationApp, type RegistrationHost } from "./registration-app.js";

// Der ganze Weg einmal durch: ein nachgebauter Agent (agent-simulator.ts)
// meldet sich über einen echten Socket bei der echten App an, die Gegenprobe
// geht gegen einen kleinen Fake-Agenten mit `GET /health`, und der Speicher
// verhält sich wie die eine Anweisung in `domain/hosts/host-store.ts`.
//
// ⚠️ Was diese Ebene fängt und die Bedingungstests nicht: dass beide Seiten
// dieselbe Anfrage meinen. Methode, Kopfzeile, Rumpffelder und die Auswertung
// von `response.ok` stehen im Agenten und nicht hier — ein Hub, der sein
// eigenes Protokoll gegen sich selbst prüft, ist grün und trotzdem
// unerreichbar.
//
// Alles läuft über 127.0.0.1; die Tunneladresse des Arms IST hier 127.0.0.1,
// weil die Quelladresse einer echten Verbindung nichts anderes sein kann.

const TUNNEL_ADDRESS = "127.0.0.1";
const HOST_ID = "arm-1";
const TOKEN = `T${"7".repeat(39)}`;

type StoredHost = RegistrationHost & { tokenHash: string | null };

type Store = {
  host: StoredHost;
  // Wie oft die eine Anweisung überhaupt gelaufen ist — daran hängt die
  // Aussage, dass Bedingung 8 nichts verbraucht.
  consumeRuns: number;
  rotate: (token: string) => void;
};

function createStore(token: string): Store {
  const store: Store = {
    host: {
      id: HOST_ID,
      // Vor der Anmeldung steht hier der Vorgabe-Port; erst die Anmeldung
      // ersetzt ihn durch den gemeldeten.
      agentUrl: `http://${TUNNEL_ADDRESS}:8099`,
      state: "pending",
      tunnelAddress: TUNNEL_ADDRESS,
      failedAttempts: 0,
      tokenHash: hashRegistrationToken(token)
    },
    consumeRuns: 0,
    rotate: (next: string) => {
      // Was `GET /hosts/:id/archive` tut: neues Token, zurück auf `pending`,
      // Fehlzähler auf null.
      store.host.tokenHash = hashRegistrationToken(next);
      store.host.state = "pending";
      store.host.failedAttempts = 0;
    }
  };
  return store;
}

// Die Rückrufe, die `index.ts` in Welle 3 mit `domain/hosts/host-store.ts` verdrahtet — hier
// gegen einen Speicher im Arbeitsspeicher, aber mit derselben Entscheidung:
// EINE Anweisung, die Zustand, Abdruck, Quelladresse und Fehlzähler zusammen
// prüft und umschaltet. Ein `select` davor wäre ein Fenster, in dem dasselbe
// Token zweimal gilt.
function createDeps(store: Store, log: string[]) {
  return {
    findHostByTunnelAddress: async (address: string): Promise<RegistrationHost | null> => {
      const normalized = normalizeTunnelAddress(address);
      if (!normalized || normalized !== store.host.tunnelAddress) return null;
      // Eine Kopie, wie sie aus der Datenbank käme — kein Zeiger auf den
      // Speicher, sonst sähe die App Änderungen, die sie nicht abgefragt hat.
      const { tokenHash: _tokenHash, ...record } = store.host;
      return { ...record };
    },
    // Die echte Gegenprobe aus domain/hosts/health.ts, nicht eine nachgebaute:
    // genau sie wird der Hub verdrahten.
    probeAgent: async (baseUrl: string): Promise<boolean> => {
      const health = await probeAgent(baseUrl, { timeoutMs: 2_000 });
      return health.reachable;
    },
    consumeToken: async (claim: {
      hostId: string;
      token: string;
      sourceAddress: string;
      listenPort: number;
    }): Promise<RegistrationHost | null> => {
      store.consumeRuns += 1;
      const host = store.host;
      const matches =
        host.id === claim.hostId &&
        host.state === "pending" &&
        host.tokenHash !== null &&
        host.tokenHash === hashRegistrationToken(claim.token) &&
        host.tunnelAddress === normalizeTunnelAddress(claim.sourceAddress) &&
        host.failedAttempts < MAX_REGISTRATION_ATTEMPTS;
      if (!matches) return null;
      host.state = "registered";
      host.tokenHash = null;
      host.failedAttempts = 0;
      // `agent_url` aus der vergebenen Tunneladresse und dem gemeldeten Port —
      // nie aus `listenHost`.
      host.agentUrl = `http://${host.tunnelAddress}:${claim.listenPort}`;
      const { tokenHash: _tokenHash, ...record } = host;
      return { ...record };
    },
    recordFailure: async (hostId: string): Promise<void> => {
      if (store.host.id === hostId) store.host.failedAttempts += 1;
    },
    log: (message: string) => log.push(message)
  };
}

type Listener = { port: number; close: () => Promise<void> };

async function listen(server: http.Server, port = 0): Promise<Listener> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

// Der kleine Fake-Agent: genau der eine Endpunkt, den die Gegenprobe befragt.
// Er liegt beim echten Agenten VOR der Secret-Prüfung und nennt die Version.
function createFakeAgent(): { server: http.Server; paths: string[] } {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, version: "0.32.0", contractVersion: CONTRACT_VERSION, readOnly: false }));
      return;
    }
    response.writeHead(404).end();
  });
  return { server, paths };
}

function simulatorConfig(hubPort: number, token: string, agentPort: number): SimulatorConfig {
  return {
    // Die vollständige URL steht im Archiv des Arms.
    registrationUrl: `http://127.0.0.1:${hubPort}/hosts/${HOST_ID}/register`,
    registrationToken: token,
    agentVersion: "0.18.1",
    // Ein frisch aufgesetzter Arm meldet regelmäßig 0.0.0.0 — der Hub darf
    // darauf nichts stützen.
    listenHost: "0.0.0.0",
    listenPort: agentPort,
    readOnly: false
  };
}

test("ein Arm im Zustand pending meldet sich an und ist danach registriert", async () => {
  const store = createStore(TOKEN);
  const log: string[] = [];
  const agent = createFakeAgent();
  const agentListener = await listen(agent.server);
  const hub = await listen(http.createServer(createRegistrationApp(createDeps(store, log))));
  try {
    const result = await runAgentSimulator(simulatorConfig(hub.port, TOKEN, agentListener.port), {
      firstWaitMs: 5,
      maxAttempts: 3
    });
    assert.deepEqual(result, { outcome: "registered", attempts: 1 });
    assert.equal(store.host.state, "registered");
    // Das Token ist verbraucht: der Abdruck ist weg.
    assert.equal(store.host.tokenHash, null);
    assert.equal(store.host.failedAttempts, 0);
    // Die Adresse kommt aus der Tunneladresse und dem gemeldeten Port, nicht
    // aus `listenHost` (0.0.0.0) und nicht aus dem Vorgabe-Port 8099.
    assert.equal(store.host.agentUrl, `http://${TUNNEL_ADDRESS}:${agentListener.port}`);
    // Die Gegenprobe hat wirklich stattgefunden — genau einmal, vor dem
    // Verbrauch.
    assert.deepEqual(agent.paths, ["GET /health"]);
    assert.equal(store.consumeRuns, 1);
    // Kein Token in einer Logzeile des Hubs.
    assert.deepEqual(log.filter((line) => line.includes(TOKEN)), []);
  } finally {
    await hub.close();
    await agentListener.close();
  }
});

test("derselbe Arm meldet sich ein zweites Mal: 200, ohne noch einmal zu verbrauchen", async () => {
  const store = createStore(TOKEN);
  const log: string[] = [];
  const agent = createFakeAgent();
  const agentListener = await listen(agent.server);
  const hub = await listen(http.createServer(createRegistrationApp(createDeps(store, log))));
  try {
    const config = simulatorConfig(hub.port, TOKEN, agentListener.port);
    await runAgentSimulator(config, { firstWaitMs: 5, maxAttempts: 3 });
    // Der Agent konnte seinen Marker nicht schreiben und meldet sich beim
    // nächsten Start erneut — mit einem Token, das es nicht mehr gibt.
    const again = await runAgentSimulator(config, { firstWaitMs: 5, maxAttempts: 3 });
    assert.deepEqual(again, { outcome: "registered", attempts: 1 });
    assert.equal(store.host.state, "registered");
    assert.equal(store.host.failedAttempts, 0);
    // Bedingung 8 greift VOR der Gegenprobe und vor dem Verbrauch: nur der
    // erste Lauf hat beides ausgelöst.
    assert.equal(store.consumeRuns, 1);
    assert.deepEqual(agent.paths, ["GET /health"]);
  } finally {
    await hub.close();
    await agentListener.close();
  }
});

test("ein zweiter Versuch mit dem alten Token nach einer Rotation wird abgelehnt", async () => {
  const store = createStore(TOKEN);
  const log: string[] = [];
  const agent = createFakeAgent();
  const agentListener = await listen(agent.server);
  const hub = await listen(http.createServer(createRegistrationApp(createDeps(store, log))));
  try {
    await runAgentSimulator(simulatorConfig(hub.port, TOKEN, agentListener.port), {
      firstWaitMs: 5,
      maxAttempts: 3
    });
    assert.equal(store.host.state, "registered");

    // Ein neues Archiv rotiert alles und setzt den Datensatz zurück. Das alte
    // Token gilt danach nicht mehr — und ohne diese Zusage könnte ein Archiv,
    // das einmal aus der Hand gegeben wurde, dauerhaft anmelden.
    store.rotate("N".repeat(40));
    const stale = await runAgentSimulator(simulatorConfig(hub.port, TOKEN, agentListener.port), {
      firstWaitMs: 5,
      maxAttempts: 3
    });
    // 401 ist für den Agenten endgültig: er versucht es nicht noch elfmal.
    assert.deepEqual(stale, { outcome: "rejected", attempts: 1, status: 401 });
    assert.equal(store.host.state, "pending");
    // Genau ein Fehlversuch — der Zähler wächst nur an Bedingung 10.
    assert.equal(store.host.failedAttempts, 1);
    assert.deepEqual(log.filter((line) => line.includes(TOKEN)), []);
  } finally {
    await hub.close();
    await agentListener.close();
  }
});

test("ein Arm, dessen Agent noch nicht erreichbar ist, behält sein Token und kommt später durch", async () => {
  const store = createStore(TOKEN);
  const log: string[] = [];
  // Ein Port, auf dem gerade nichts lauscht: der Tunnel steht, der Agent
  // antwortet noch nicht.
  const idle = createFakeAgent();
  const idleListener = await listen(idle.server);
  const agentPort = idleListener.port;
  await idleListener.close();
  const hub = await listen(http.createServer(createRegistrationApp(createDeps(store, log))));
  try {
    const config = simulatorConfig(hub.port, TOKEN, agentPort);
    const early = await runAgentSimulator(config, { firstWaitMs: 5, maxAttempts: 3 });
    // 503 ist wiederholbar — der Agent gibt nicht auf, er wartet.
    assert.deepEqual(early, { outcome: "exhausted", attempts: 3, lastStatus: 503 });
    // ⚠️ Der Kern: nichts ist verbraucht. Läge die Gegenprobe hinter dem
    // Verbrauch, hätte dieser Arm sein Einmal-Token verloren, ohne angemeldet
    // zu sein — und der Weg zurück wäre ein neues Archiv.
    assert.equal(store.host.state, "pending");
    assert.equal(store.host.tokenHash, hashRegistrationToken(TOKEN));
    assert.equal(store.host.failedAttempts, 0);
    assert.equal(store.consumeRuns, 0);

    // Jetzt steht der Agent — derselbe Versuch mit demselben Token trägt.
    const agent = createFakeAgent();
    const agentListener = await listen(agent.server, agentPort);
    try {
      const late = await runAgentSimulator(config, { firstWaitMs: 5, maxAttempts: 3 });
      assert.deepEqual(late, { outcome: "registered", attempts: 1 });
      assert.equal(store.host.state, "registered");
      assert.equal(store.host.agentUrl, `http://${TUNNEL_ADDRESS}:${agentPort}`);
    } finally {
      await agentListener.close();
    }
  } finally {
    await hub.close();
  }
});
