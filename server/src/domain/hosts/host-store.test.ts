import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import type { TunnelNetwork } from "../../platform/config/config.js";
import { hashRegistrationToken, type HostRecord } from "./host-record.js";
import {
  HostError,
  consumeRegistrationToken,
  createHost,
  deriveHostStatus,
  findHostByTunnelAddress,
  listHostRecords,
  markHostSeen,
  readHostAgentSecret,
  recordFailedRegistration,
  removeHost,
  rotateHostCredentials,
  toHostView
} from "./host-store.js";
import { CONTRACT_VERSION, DEFAULT_HOST_THEME, hostViewSchema } from "contract";

// Geprüft wird gegen einen erfundenen Pool: kein Postgres, keine Umgebung
// (AGENTS.md, „Tests"). Was damit NICHT geprüft ist, steht ausdrücklich hier,
// damit es niemand für geprüft hält: ob das SQL gegen echtes Postgres läuft.
// Was geprüft ist, ist die BAUART — und die ist es, die still bricht:
//
//   - dass das Token in EINER Anweisung verbraucht wird und nicht in zweien,
//   - dass die Bedingung dabei auf `pending` UND auf dem Abdruck steht,
//   - dass das Klartext-Token die Datenbank nie erreicht,
//   - dass eine Adresskollision zu einem neuen Versuch führt und nicht zu
//     einem Fehler,
//   - dass Secret und Token-Abdruck in keiner Leseabfrage vorkommen.

type Call = { text: string; values: unknown[] };
type Reply = { rows: unknown[]; rowCount?: number } | Error;

function fakePool(replies: (Reply | ((call: Call, index: number) => Reply))[]): {
  pool: Pool;
  calls: Call[];
} {
  const calls: Call[] = [];
  const pool = {
    query(text: string, values: unknown[] = []) {
      const index = calls.length;
      calls.push({ text, values });
      const entry = replies[index] ?? { rows: [] };
      const reply = typeof entry === "function" ? entry({ text, values }, index) : entry;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ rows: reply.rows, rowCount: reply.rowCount ?? reply.rows.length });
    }
  } as unknown as Pool;
  return { pool, calls };
}

const NETWORK: TunnelNetwork = {
  cidr: "10.254.0.0/24",
  networkAddress: "10.254.0.0",
  prefixLength: 24,
  hubAddress: "10.254.0.1",
  firstArmOffset: 2,
  lastArmOffset: 254
};

const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(40);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "host-1",
    name: "unraid",
    agent_url: "http://10.254.0.2:8099",
    kind: "internal",
    state: "pending",
    tunnel_address: "10.254.0.2",
    wireguard_public_key: "pub",
    endpoint_override: null,
    failed_attempts: 0,
    docker_gid: 996,
    bind_base_path: "/home/docker",
    // Wie sie eine frische Zeile trägt: aus dem DEFAULT der zwei Spalten aus
    // 006-hub-theme.sql, nicht aus dem Aufrufer.
    hue: "neutral",
    ink: "head",
    created_at: new Date("2026-09-04T10:00:00Z"),
    registered_at: null,
    last_seen_at: null,
    ...overrides
  };
}

function duplicate(constraint: string): Error {
  return Object.assign(new Error("duplicate key"), { code: "23505", constraint });
}

// ── Anlegen ────────────────────────────────────────────────────────────────

test("die Adresse kommt aus der Abfrage, nicht aus einem Zähler im Speicher", async () => {
  const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.7" }] }, { rows: [row()] }]);
  await createHost(pool, NETWORK, {
    name: "unraid",
    kind: "internal",
    wireguardPublicKey: "pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
    dockerGid: 996,
    bindBasePath: "/home/docker"
  });

  // Gesucht wird in SQL über den ganzen Bereich — damit auch die Lücke
  // gefunden wird, die ein entfernter Arm hinterlässt.
  assert.match(calls[0].text, /generate_series/);
  assert.deepEqual(calls[0].values, ["10.254.0.0", 2, 254]);
  assert.match(calls[1].text, /INSERT INTO docker_host/);
  assert.ok(calls[1].values.includes("10.254.0.7"), "die vorgeschlagene Adresse muss im INSERT stehen");
  assert.ok(calls[1].values.includes("http://10.254.0.7:8099"), "die Agent-Adresse folgt der Tunneladresse");
});

test("ein neuer Arm bekommt seinen Ton von der Spaltenvorgabe und nicht aus TypeScript", async () => {
  // Baustein 4 aus D7a (#62): `POST /hosts` legt einen Arm an, und der bekommt
  // die Vorgaben aus `DEFAULT_HOST_THEME` — mehr nicht.
  //
  // ⚠️ Die Zusicherung ist NICHT „der Wert stimmt", sondern „hier steht kein
  // Code, der ihn setzt". Was die Datenbank schon tut, schreibt man nicht noch
  // einmal in TypeScript: ein zweiter Ort, an dem der Vorgabewert steht, wäre
  // genau der, der beim nächsten Ändern vergessen wird.
  const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.2" }] }, { rows: [row()] }]);
  const created = await createHost(pool, NETWORK, {
    name: "unraid",
    kind: "internal",
    wireguardPublicKey: "pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
    dockerGid: 996,
    bindBasePath: "/home/docker"
  });

  // Die Spaltenliste des INSERT — und nicht der ganze Text: `RETURNING` nennt
  // beide Spalten sehr wohl, und daran hängt die Antwort.
  const columns = /INSERT INTO docker_host \(([\s\S]*?)\)/.exec(calls[1].text)?.[1] ?? "";
  assert.ok(columns.length > 0, "die Spaltenliste des INSERT ist nicht lesbar — dieser Fall prüft dann nichts");
  assert.ok(!/\bhue\b/.test(columns), `„hue" steht in der Spaltenliste des INSERT: ${columns}`);
  assert.ok(!/\bink\b/.test(columns), `„ink" steht in der Spaltenliste des INSERT: ${columns}`);
  assert.ok(!calls[1].values.includes("neutral"), "der Vorgabewert des Tons reist als Parameter mit");
  assert.ok(!calls[1].values.includes("head"), "der Vorgabewert des Farbeinsatzes reist als Parameter mit");

  // Und trotzdem trägt der Datensatz beides — aus `RETURNING`, also aus dem,
  // was die Spalte selbst eingesetzt hat.
  assert.deepEqual(created.display, DEFAULT_HOST_THEME);
});

test("nur der Abdruck des Tokens geht an die Datenbank", async () => {
  const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.2" }] }, { rows: [row()] }]);
  await createHost(pool, NETWORK, {
    name: "unraid",
    kind: "internal",
    wireguardPublicKey: "pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
    dockerGid: 996,
    bindBasePath: "/home/docker"
  });
  assert.ok(!calls[1].values.includes(TOKEN), "das Klartext-Token darf nirgends als Parameter stehen");
  assert.ok(calls[1].values.includes(hashRegistrationToken(TOKEN)));
});

test("eine Adresskollision führt zu einem neuen Versuch, nicht zu einem Fehler", async () => {
  // ⚠️ Der Wettlauf, den kein Test mit einem Aufrufer nach dem anderen zeigt:
  // zwei Anleger bekommen dieselbe freie Adresse vorgeschlagen. Entschieden
  // wird sie vom eindeutigen Index; der Verlierer sucht erneut.
  const { pool, calls } = fakePool([
    { rows: [{ address: "10.254.0.2" }] },
    duplicate("docker_host_tunnel_address_key"),
    { rows: [{ address: "10.254.0.3" }] },
    { rows: [row({ tunnel_address: "10.254.0.3" })] }
  ]);
  const created = await createHost(pool, NETWORK, {
    name: "unraid",
    kind: "internal",
    wireguardPublicKey: "pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
    dockerGid: 996,
    bindBasePath: "/home/docker"
  });
  assert.equal(created.tunnelAddress, "10.254.0.3");
  assert.equal(calls.length, 4);
});

test("ein vergebener Name wird nicht wiederholt, sondern gemeldet", async () => {
  // Derselbe Fehlercode wie oben — und trotzdem der andere Fall. Wer nur auf
  // 23505 prüft, wiederholt fünfmal denselben Namen.
  const { pool, calls } = fakePool([
    { rows: [{ address: "10.254.0.2" }] },
    duplicate("docker_host_name_key")
  ]);
  await assert.rejects(
    () =>
      createHost(pool, NETWORK, {
        name: "unraid",
        kind: "internal",
        wireguardPublicKey: "pub",
        agentSecret: SECRET,
        registrationToken: TOKEN,
        dockerGid: 996,
        bindBasePath: "/home/docker"
      }),
    (error: unknown) => error instanceof HostError && error.reason === "name-taken"
  );
  assert.equal(calls.length, 2, "nach einem vergebenen Namen wird nicht weitergesucht");
});

test("ein volles Netz meldet sich als eigener Fehler", async () => {
  const { pool } = fakePool([{ rows: [] }]);
  await assert.rejects(
    () =>
      createHost(pool, NETWORK, {
        name: "unraid",
        kind: "internal",
        wireguardPublicKey: "pub",
        agentSecret: SECRET,
        registrationToken: TOKEN,
        dockerGid: 996,
        bindBasePath: "/home/docker"
      }),
    (error: unknown) => error instanceof HostError && error.reason === "address-pool-exhausted"
  );
});

test("ein zu kurzes Token wird gar nicht erst angelegt", async () => {
  const { pool, calls } = fakePool([]);
  await assert.rejects(
    () =>
      createHost(pool, NETWORK, {
        name: "unraid",
        kind: "internal",
        wireguardPublicKey: "pub",
        agentSecret: SECRET,
        registrationToken: "kurz",
        dockerGid: 996,
        bindBasePath: "/home/docker"
      }),
    (error: unknown) => error instanceof HostError && error.reason === "invalid-input"
  );
  assert.equal(calls.length, 0, "ein unbrauchbares Archiv entsteht nicht erst");
});

test("ein zu kurzes Agent-Secret ebenso", async () => {
  const { pool } = fakePool([]);
  await assert.rejects(
    () =>
      createHost(pool, NETWORK, {
        name: "unraid",
        kind: "internal",
        wireguardPublicKey: "pub",
        agentSecret: "kurz",
        registrationToken: TOKEN,
        dockerGid: 996,
        bindBasePath: "/home/docker"
      }),
    (error: unknown) => error instanceof HostError && error.reason === "invalid-input"
  );
});

test("die zwei Werte des Zielhosts stehen im INSERT und nicht nur im Archiv", async () => {
  // ⚠️ Ohne die Spalten wäre die Eingabe beim ZWEITEN Archiv weg:
  // `GET /hosts/:id/archive` erzeugt neu und hat keine Eingabe mehr
  // (008-host-setup.sql). Das Paket käme dann wieder mit leerer Zeile heraus,
  // und zwar ohne Fehlermeldung.
  const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.7" }] }, { rows: [row()] }]);
  await createHost(pool, NETWORK, {
    name: "unraid",
    kind: "internal",
    wireguardPublicKey: "pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
    dockerGid: 281,
    bindBasePath: "/mnt/user/appdata"
  });

  const insert = calls[1];
  assert.match(insert.text, /docker_gid/);
  assert.match(insert.text, /bind_base_path/);
  assert.ok(insert.values.includes(281), "die Gruppen-ID muss im INSERT stehen");
  assert.ok(insert.values.includes("/mnt/user/appdata"), "der Basispfad muss im INSERT stehen");
});

test("die Gruppen-ID 0 wird angelegt und nicht als fehlend abgewiesen", async () => {
  // Der Host, dessen Socket root gehört. Eine Prüfung auf Wahrheitswert
  // ergäbe hier „Angabe fehlt" — für einen Wert, der dasteht.
  const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.2" }] }, { rows: [row()] }]);
  await createHost(pool, NETWORK, {
    name: "root-host",
    kind: "internal",
    wireguardPublicKey: "pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
    dockerGid: 0,
    bindBasePath: "/home/docker"
  });
  assert.ok(calls[1].values.includes(0), "0 muss als Wert im INSERT ankommen");
});

test("ein Basispfad, der die Compose-Zeile des Arms zerlegt, ergibt keinen Arm", async () => {
  // Abgewiesen wird VOR dem INSERT: eine Zeile, deren Paket auf dem Zielhost
  // nicht startet, ist ein Arm, den niemand bestellt hat — und der seine
  // Tunneladresse belegt.
  for (const bad of ["/mnt:/mnt", "/mnt/my data", "relativ/pfad", "/"]) {
    const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.2" }] }, { rows: [row()] }]);
    await assert.rejects(
      () =>
        createHost(pool, NETWORK, {
          name: "arm",
          kind: "internal",
          wireguardPublicKey: "pub",
          agentSecret: SECRET,
          registrationToken: TOKEN,
          dockerGid: 996,
          bindBasePath: bad
        }),
      (error: unknown) => error instanceof HostError && error.reason === "invalid-input",
      `durchgelassen: „${bad}"`
    );
    assert.deepEqual(calls, [], `es wurde trotzdem geschrieben: „${bad}"`);
  }
});

test("eine Gruppen-ID, die keine ist, ergibt keinen Arm", async () => {
  for (const bad of [-1, 1.5, Number.NaN]) {
    const { pool, calls } = fakePool([{ rows: [{ address: "10.254.0.2" }] }, { rows: [row()] }]);
    await assert.rejects(
      () =>
        createHost(pool, NETWORK, {
          name: "arm",
          kind: "internal",
          wireguardPublicKey: "pub",
          agentSecret: SECRET,
          registrationToken: TOKEN,
          dockerGid: bad,
          bindBasePath: "/home/docker"
        }),
      (error: unknown) => error instanceof HostError && error.reason === "invalid-input",
      `durchgelassen: ${String(bad)}`
    );
    assert.deepEqual(calls, [], `es wurde trotzdem geschrieben: ${String(bad)}`);
  }
});

// ── Archiv neu erzeugen ────────────────────────────────────────────────────

test("das Erneuern läuft in EINER Anweisung und setzt den Arm zurück", async () => {
  const { pool, calls } = fakePool([{ rows: [row({ state: "pending", registered_at: null })] }]);
  const result = await rotateHostCredentials(pool, "host-1", {
    wireguardPublicKey: "neuer-pub",
    agentSecret: SECRET,
    registrationToken: TOKEN,
  });

  assert.ok(result);
  assert.equal(calls.length, 1, "lesen-dann-schreiben gäbe zwei Archive, die beide gültig zu sein behaupten");

  const sql = calls[0].text;
  assert.match(sql, /^\s*UPDATE docker_host/);
  assert.match(sql, /state\s*=\s*'pending'/, "ein neues Archiv heißt: noch nicht angemeldet");
  assert.match(sql, /failed_attempts\s*=\s*0/, "das neue Archiv ist der Weg aus der Sperre");
  assert.match(sql, /registered_at\s*=\s*NULL/);
  assert.match(sql, /kind\s*<>\s*'local'/, "der lokale Host hat kein Archiv");
  // Der Abdruck geht in die Zeile, das Token nie.
  assert.equal(calls[0].values[3], hashRegistrationToken(TOKEN));
  assert.ok(!calls[0].values.includes(TOKEN));
});

test("ein unbekannter oder lokaler Host ergibt null statt eines Fehlers", async () => {
  const { pool } = fakePool([{ rows: [] }]);
  assert.equal(
    await rotateHostCredentials(pool, "gibt-es-nicht", {
      wireguardPublicKey: "pub",
      agentSecret: SECRET,
      registrationToken: TOKEN,
    }),
    null
  );
});

test("ein zu kurzes Token wird beim Erneuern genauso abgewiesen wie beim Anlegen", async () => {
  const { pool, calls } = fakePool([{ rows: [] }]);
  await assert.rejects(
    () =>
      rotateHostCredentials(pool, "host-1", {
        wireguardPublicKey: "pub",
        agentSecret: SECRET,
        registrationToken: "too-short",
      }),
    (error: unknown) => error instanceof HostError && error.reason === "invalid-input"
  );
  assert.equal(calls.length, 0, "die Datenbank wird dafür nicht angefasst");
});

// ── Anmelden ───────────────────────────────────────────────────────────────

test("das Token wird in EINER Anweisung verbraucht", async () => {
  const { pool, calls } = fakePool([{ rows: [row({ state: "registered", registered_at: new Date() })] }]);
  const result = await consumeRegistrationToken(pool, {
    hostId: "host-1",
    token: TOKEN,
    sourceAddress: "10.254.0.2",
    listenPort: 8099
  });

  assert.ok(result);
  assert.equal(calls.length, 1, "ein SELECT davor wäre ein Fenster, in dem dasselbe Token zweimal gilt");

  const sql = calls[0].text;
  assert.match(sql, /^\s*UPDATE docker_host/);
  assert.match(sql, /state\s*=\s*'pending'/, "ohne diese Bedingung gilt ein verbrauchtes Token weiter");
  assert.match(sql, /token_hash\s*=\s*\$2/);
  assert.match(sql, /tunnel_address\s*=\s*\$3::inet/);
  assert.match(sql, /failed_attempts\s*<\s*\$5/, "die Sperre gehört in dieselbe Anweisung");
  assert.match(sql, /RETURNING/, "ohne RETURNING lässt sich ein Treffer nicht von keinem unterscheiden");
  assert.ok(!/^\s*SELECT/m.test(sql));
});

test("verglichen wird der Abdruck, nicht das Token", async () => {
  const { pool, calls } = fakePool([{ rows: [] }]);
  await consumeRegistrationToken(pool, {
    hostId: "host-1",
    token: TOKEN,
    sourceAddress: "10.254.0.2",
    listenPort: 8099
  });
  assert.equal(calls[0].values[1], hashRegistrationToken(TOKEN));
  assert.ok(!calls[0].values.includes(TOKEN));
});

test("kein Treffer heißt abgelehnt", async () => {
  const { pool } = fakePool([{ rows: [] }]);
  const result = await consumeRegistrationToken(pool, {
    hostId: "host-1",
    token: TOKEN,
    sourceAddress: "10.254.0.2",
    listenPort: 8099
  });
  assert.equal(result, null);
});

test("die Quelladresse wird normalisiert, bevor sie in die Bedingung geht", async () => {
  const { pool, calls } = fakePool([{ rows: [] }]);
  await consumeRegistrationToken(pool, {
    hostId: "host-1",
    token: TOKEN,
    sourceAddress: "::ffff:10.254.0.2",
    listenPort: 8099
  });
  assert.equal(calls[0].values[2], "10.254.0.2");
});

test("eine unbrauchbare Quelladresse wird abgelehnt, ohne die Datenbank zu fragen", async () => {
  const { pool, calls } = fakePool([]);
  const result = await consumeRegistrationToken(pool, {
    hostId: "host-1",
    token: TOKEN,
    sourceAddress: "nicht-eine-adresse",
    listenPort: 8099
  });
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("ein unbrauchbarer Port des Agenten wird abgelehnt", async () => {
  const { pool, calls } = fakePool([]);
  for (const listenPort of [0, -1, 70000, 8099.5, Number.NaN]) {
    assert.equal(
      await consumeRegistrationToken(pool, {
        hostId: "host-1",
        token: TOKEN,
        sourceAddress: "10.254.0.2",
        listenPort
      }),
      null
    );
  }
  assert.equal(calls.length, 0);
});

test("die Agent-Adresse entsteht aus der Tunneladresse, nicht aus dem gemeldeten listenHost", async () => {
  const { pool, calls } = fakePool([{ rows: [row({ state: "registered" })] }]);
  await consumeRegistrationToken(pool, {
    hostId: "host-1",
    token: TOKEN,
    sourceAddress: "10.254.0.2",
    listenPort: 9000
  });
  // Der Agent meldet regelmäßig 0.0.0.0 als eigenen Listener. Was er sagen
  // darf, ist der Port — nicht, wo der Hub ihn suchen soll.
  assert.match(calls[0].text, /agent_url\s*=\s*'http:\/\/'\s*\|\|\s*host\(tunnel_address\)/);
  assert.equal(calls[0].values[3], 9000);
});

// ── Lesen, zählen, entfernen ───────────────────────────────────────────────

test("keine Leseabfrage holt Secret oder Token-Abdruck", async () => {
  const { pool, calls } = fakePool([{ rows: [row()] }, { rows: [row()] }]);
  await listHostRecords(pool);
  await findHostByTunnelAddress(pool, "10.254.0.2");
  for (const call of calls) {
    assert.ok(!/agent_secret/.test(call.text), `agent_secret steht in: ${call.text}`);
    assert.ok(!/token_hash/.test(call.text), `token_hash steht in: ${call.text}`);
  }
  // Und die Adresse kommt ohne Präfixlänge zurück — sonst wäre „10.254.0.2/32"
  // gegen eine Quell-IP nie gleich.
  assert.match(calls[0].text, /host\(tunnel_address\) AS tunnel_address/);
});

test("eine unbrauchbare Adresse wird gar nicht gesucht", async () => {
  const { pool, calls } = fakePool([]);
  assert.equal(await findHostByTunnelAddress(pool, "10.254.0.2/32"), null);
  assert.equal(calls.length, 0);
});

test("das Agent-Secret wird einzeln geholt und nie mit dem Datensatz", async () => {
  const { pool, calls } = fakePool([{ rows: [{ agent_secret: SECRET }] }]);
  assert.equal(await readHostAgentSecret(pool, "host-1"), SECRET);
  assert.match(calls[0].text, /SELECT agent_secret/);
});

test("der lokale Host hat kein eigenes Secret in der Tabelle", async () => {
  const { pool } = fakePool([{ rows: [{ agent_secret: null }] }]);
  assert.equal(await readHostAgentSecret(pool, "local-1"), null);
});

test("der Fehlzähler wird in der Datenbank erhöht, nicht im Speicher", async () => {
  const { pool, calls } = fakePool([{ rows: [{ failed_attempts: 3 }] }]);
  assert.equal(await recordFailedRegistration(pool, "host-1"), 3);
  assert.match(calls[0].text, /failed_attempts\s*=\s*failed_attempts\s*\+\s*1/);
});

test("der lokale Host lässt sich nicht entfernen", async () => {
  const { pool, calls } = fakePool([{ rows: [], rowCount: 0 }]);
  assert.equal(await removeHost(pool, "local-1"), false);
  assert.match(calls[0].text, /kind <> 'local'/);
});

test("ein zweites Entfernen meldet false statt zu werfen", async () => {
  const { pool } = fakePool([{ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 }]);
  assert.equal(await removeHost(pool, "host-1"), true);
  assert.equal(await removeHost(pool, "host-1"), false);
});

// ── Zustand ────────────────────────────────────────────────────────────────

test("0.31.0 ist zu alt, 0.32.0 ist online, keine Angabe ist zu alt", () => {
  const base = { state: "registered" as const, reachable: true, contractVersion: CONTRACT_VERSION };
  assert.equal(deriveHostStatus({ ...base, agentVersion: "0.31.0" }), "outdated");
  assert.equal(deriveHostStatus({ ...base, agentVersion: "0.32.0" }), "online");
  assert.equal(deriveHostStatus({ ...base, agentVersion: null }), "outdated");
});

test("ein Agent unter dem Vertrag des Hubs ist zu alt, auch mit passender Version (#278)", () => {
  // 0.32.0 built from this repository before #278 still sends the German
  // values of contract 5; only the contract number tells it apart.
  const base = { state: "registered" as const, reachable: true, agentVersion: "0.32.0" };
  assert.equal(deriveHostStatus({ ...base, contractVersion: CONTRACT_VERSION }), "online");
  assert.equal(deriveHostStatus({ ...base, contractVersion: CONTRACT_VERSION - 1 }), "outdated");
  assert.equal(deriveHostStatus({ ...base, contractVersion: null }), "outdated");
});

test("wer nicht antwortet, ist offline und nicht zu alt", () => {
  assert.equal(
    deriveHostStatus({ state: "registered", reachable: false, agentVersion: null, contractVersion: null }),
    "offline"
  );
});

test("ein ausstehender Host ist ausstehend, auch wenn sein Agent antwortet", () => {
  // Sonst hieße ein Arm, dessen Archiv noch beim Betreiber liegt, „offline" —
  // und der Betreiber suchte den Fehler am Host statt im Postfach.
  assert.equal(deriveHostStatus({ state: "pending", reachable: true, agentVersion: "0.32.0", contractVersion: CONTRACT_VERSION }), "pending");
  assert.equal(deriveHostStatus({ state: "pending", reachable: false, agentVersion: null, contractVersion: null }), "pending");
});

test("die Ansicht trägt genau die zugesagten Felder und kein Geheimnis", () => {
  const record: HostRecord = {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    tunnelAddress: "10.254.0.2",
    wireguardPublicKey: "pub",
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date(),
    registeredAt: new Date(),
    lastSeenAt: null
  };
  const view = toHostView(record, { reachable: true, version: "0.32.0", contractVersion: 10, readOnly: false, entries: null });
  // The promised fields are the keys of `hostViewSchema` (#247) — the one list
  // that decides what goes out, reviewed in `contract`, not a second copy here.
  assert.deepEqual(Object.keys(view).sort(), Object.keys(hostViewSchema.shape).sort());
  assert.equal(view.status, "online");
  assert.equal(view.agentVersion, "0.32.0");
  // Der öffentliche Schlüssel des Arms geht die Oberfläche nichts an — er
  // gehört in die wg0.conf und sonst nirgendwohin.
  assert.ok(!Object.keys(view).includes("wireguardPublicKey"));
});

test("jede Variante von toHostView erfüllt das Schema", () => {
  // The route test (`app/theme-routes.test.ts`) only sees pending arms, which
  // are never asked — `agentVersion` and `agentUpdate` are `null` there. The
  // branches that fill them are held here, without a network.
  const base: HostRecord = {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    tunnelAddress: "10.254.0.2",
    wireguardPublicKey: "pub",
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date(),
    registeredAt: new Date(),
    lastSeenAt: new Date("2026-09-29T20:15:00.000Z")
  };
  const variants = [
    { name: "reachable, older agent", view: toHostView(base, { reachable: true, version: "0.32.0", contractVersion: 6, readOnly: false, entries: null }) },
    { name: "reachable, no version", view: toHostView(base, { reachable: true, version: null, contractVersion: null, readOnly: null, entries: null }) },
    { name: "unreachable", view: toHostView(base, { reachable: false, error: "timeout" }) },
    { name: "local", view: toHostView({ ...base, kind: "local", tunnelAddress: null }, { reachable: true, version: "0.32.0", contractVersion: 10, readOnly: false, entries: null }) },
    { name: "pending", view: toHostView({ ...base, state: "pending", lastSeenAt: null }, null) }
  ];

  for (const { name, view } of variants) {
    const parsed = hostViewSchema.safeParse(view);
    assert.ok(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`);
    // Nothing replaced by a fallback, nothing stripped: the server sends
    // exactly what the schema reads.
    assert.deepEqual(parsed.data, view, `${name}: the parse changed the view`);
  }

  // The test only counts if the offer branch was really taken.
  assert.ok(variants[0].view.agentUpdate !== null, "the older reachable agent gets an offer");
  assert.ok(variants[1].view.agentUpdate !== null, "an agent without a version gets a manual offer");
});

test("ohne Gesundheitsauskunft gibt es keine Version und keinen Verdacht auf online", () => {
  const record: HostRecord = {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    tunnelAddress: "10.254.0.2",
    wireguardPublicKey: "pub",
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date(),
    registeredAt: new Date(),
    lastSeenAt: null
  };
  const view = toHostView(record, null);
  assert.equal(view.agentVersion, null);
  assert.equal(view.status, "offline");
  assert.equal(view.lastSeenAt, null, "ohne je eine Antwort gibt es keinen Zeitpunkt");
});

test("ein stiller Arm nennt den Zeitpunkt seiner letzten Antwort (#205)", () => {
  const lastSeenAt = new Date("2026-09-29T20:15:00.000Z");
  const record: HostRecord = {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    tunnelAddress: "10.254.0.2",
    wireguardPublicKey: "pub",
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date(),
    registeredAt: new Date(),
    lastSeenAt
  };
  const view = toHostView(record, { reachable: false, error: "timeout" });
  assert.equal(view.status, "offline");
  assert.equal(view.lastSeenAt, "2026-09-29T20:15:00.000Z");
});

test("markHostSeen setzt nur last_seen_at und nicht updated_at", async () => {
  const seen = new Date("2026-09-29T20:15:00.000Z");
  const queries: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return Promise.resolve({ rows: [{ last_seen_at: seen }] });
    }
  } as unknown as Pool;
  assert.equal(await markHostSeen(pool, "host-1"), seen);
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /SET last_seen_at = now\(\) WHERE id = \$1/);
  assert.ok(!queries[0].text.includes("updated_at"), "updated_at gehört der letzten Änderung des Datensatzes");
  assert.deepEqual(queries[0].values, ["host-1"]);
});
