import test from "node:test";
import assert from "node:assert/strict";

import type { Pool } from "pg";

import { DEFAULT_HOST_THEME } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { createHostAccess, deriveHostStatus, type HostRecord } from "./index.js";

// The door of `domain/hosts` without Postgres and without an agent: a store
// with a fixed list and a pool that answers only the one query the door makes,
// the secret of one row. Whether that SQL is right is `host-store.test.ts`.

const LOCAL_ENV_SECRET = "secret-der-umgebung-des-lokalen-arms";
const ROW_SECRET = "secret-aus-der-zeile-des-angebundenen-arms";

function record(overrides: Partial<HostRecord>): HostRecord {
  return {
    id: "arm-1",
    name: "arm-eins",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    tunnelAddress: "10.254.0.2",
    wireguardPublicKey: "public-key",
    endpointOverride: null,
    failedAttempts: 0,
    display: DEFAULT_HOST_THEME,
    dockerGid: 999,
    bindBasePath: "/srv/docker",
    createdAt: new Date("2026-10-01T10:00:00Z"),
    registeredAt: new Date("2026-10-01T10:05:00Z"),
    lastSeenAt: null,
    ...overrides
  };
}

const LOCAL = record({
  id: "local-1",
  name: "lokal",
  agentUrl: "http://docker-agent:8099",
  kind: "local",
  tunnelAddress: null,
  wireguardPublicKey: null
});
const ARM = record({});
const ARM_WITHOUT_SECRET = record({ id: "arm-2", name: "arm-ohne-secret", agentUrl: "http://10.254.0.3:8099" });
const PENDING = record({
  id: "arm-3",
  name: "arm-ausstehend",
  agentUrl: "http://10.254.0.4:8099",
  state: "pending",
  registeredAt: null
});

// The secrets as they stand in `docker_host.agent_secret`. The local row and
// the arm that never fetched an archive hold none.
const STORED_SECRETS = new Map<string, string>([
  [ARM.id, ROW_SECRET],
  [PENDING.id, "secret-des-ausstehenden-arms"]
]);

function access(records: HostRecord[]) {
  const queries: unknown[][] = [];
  const pool = {
    query: (_sql: string, params: unknown[]) => {
      queries.push(params);
      const secret = STORED_SECRETS.get(String(params[0]));
      // `readHostAgentSecret`: no row at all for an unknown id, a row with
      // `null` for a known one without a secret.
      if (!records.some((entry) => entry.id === params[0])) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ agent_secret: secret ?? null }] });
    }
  } as unknown as Pool;
  const repository = {
    find: (id: string) => Promise.resolve(records.find((entry) => entry.id === id) ?? null),
    list: () => Promise.resolve([...records])
  };
  return { hosts: createHostAccess({ repository, pool, agentSecret: LOCAL_ENV_SECRET }), queries };
}

test("Host unbekannt: `find` liefert null und liest kein Geheimnis", async () => {
  const { hosts, queries } = access([LOCAL, ARM]);
  assert.ok((await hosts.find("gibt-es-nicht")) === null, "ein unbekannter Host wurde gefunden");
  assert.deepEqual(queries, [], "für einen unbekannten Host lief eine Abfrage nach dem Geheimnis");
});

test("`find` liest kein Geheimnis, auch für einen bekannten Host", async () => {
  // Several routes decide between `find` and `connect` (503 for an arm that is
  // pending or offline); a secret read in `find` would be read for nothing.
  const { hosts, queries } = access([LOCAL, ARM]);
  assert.equal((await hosts.find(ARM.id))?.name, ARM.name);
  assert.deepEqual(queries, []);
});

test("angebundener Arm: der Weg zum Agenten trägt das Geheimnis aus SEINER Zeile", async () => {
  const { hosts } = access([LOCAL, ARM]);
  assert.deepEqual(await hosts.connect(ARM), { baseUrl: ARM.agentUrl, secret: ROW_SECRET });
});

test("lokaler Arm ohne Zeileneintrag: das Geheimnis kommt aus der Umgebung", async () => {
  const { hosts } = access([LOCAL, ARM]);
  assert.deepEqual(await hosts.connect(LOCAL), { baseUrl: LOCAL.agentUrl, secret: LOCAL_ENV_SECRET });
});

test("Host ohne Geheimnis: `AgentError` mit seinem Namen, kein Rückfall auf die Umgebung (#77)", async () => {
  const { hosts } = access([LOCAL, ARM_WITHOUT_SECRET]);
  await assert.rejects(
    () => hosts.connect(ARM_WITHOUT_SECRET),
    (error: unknown) => {
      assert.ok(error instanceof AgentError, "kein AgentError");
      assert.match(error.message, /arm-ohne-secret/);
      assert.ok(!error.message.includes(LOCAL_ENV_SECRET), "die Meldung trägt das Geheimnis der Umgebung");
      return true;
    }
  );
});

test("Host deaktiviert (`pending`): gefunden, gelistet und erreichbar wie bisher; die Entscheidung trifft der Aufrufer", async () => {
  // `docker_host.state` knows `pending` and `registered` only
  // (004-host-enrollment.sql); `pending` is the one state in which an arm has
  // no agent yet. The door does not filter it: the host list shows it, and the
  // file chain answers 503 for it after `find`, through `deriveHostStatus`.
  const { hosts } = access([LOCAL, ARM, PENDING]);
  const found = await hosts.find(PENDING.id);
  assert.equal(found?.state, "pending");
  assert.equal(deriveHostStatus({ state: "pending", reachable: true, agentVersion: "0.31.0", contractVersion: null }), "pending");
  assert.deepEqual(await hosts.connect(PENDING), {
    baseUrl: PENDING.agentUrl,
    secret: "secret-des-ausstehenden-arms"
  });
});

test("ausgeblendet (#208): `list` filtert nichts und hält die Reihenfolge des Bestands", async () => {
  // #208 hides the hub's own containers in the views, not hosts. A host on
  // which only those run is a host like any other here; hiding happens in
  // `domain/containers/system-containers.ts` and in the web.
  const { hosts } = access([LOCAL, ARM, PENDING, ARM_WITHOUT_SECRET]);
  assert.deepEqual(
    (await hosts.list()).map((entry) => entry.id),
    [LOCAL.id, ARM.id, PENDING.id, ARM_WITHOUT_SECRET.id]
  );
});
