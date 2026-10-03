import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import type { Pool } from "pg";

import type { Auth } from "../platform/auth/auth.js";
import type { HostRecord, HostRepository } from "../domain/hosts/index.js";
import { DEFAULT_CONTAINER_VIEW_SETTINGS } from "../features/containers/index.js";
import { DEFAULT_LOG_SETTINGS } from "../features/logs/index.js";
import {
  DEFAULT_GLOBAL_THEME,
  DEFAULT_HOST_THEME,
  hostListSchema,
  hostResponseSchema,
  hostViewSchema,
  hubNetworkResponseSchema,
  settingsSchema,
  themeResponseSchema
} from "contract";
import { createApiRouter } from "./router.js";
import { listenOnFetchablePort } from "../platform/testing/port-test-support.js";

// Die drei Routen der Darstellung — über echte Anfragen durch den echten
// Router (D7a, #62). Muster: `agent-secret-routing.test.ts`.
//
// ⚠️ WAS OHNE POSTGRES GEPRÜFT WERDEN KANN und hier geprüft wird:
//   - dass die Routen unter den vereinbarten Pfaden ANGEMELDET sind;
//   - die ANTWORTFORM, gegen die die Oberfläche parallel gebaut wird;
//   - dass ein unbekannter Wert und ein unbekannter Schlüssel einen 400
//     ergeben und NICHT still zur Vorgabe werden;
//   - dass ein 400 NICHTS schreibt;
//   - dass JEDE Route, die eine HostView herausgibt, `display` mitträgt.
//
// ⚠️ DER LETZTE PUNKT IST DER, DEN SONST NICHTS FÄNGT — Befund der Oberfläche
// vom 2026-09-06: fehlt `display` in einer Serverantwort, wird nichts rot, die
// Liste steht dann still auf Grau. Ein fehlendes Feld ist kein Typfehler auf
// der Gegenseite und keine Ausnahme; es ist `undefined`. Der Fall unten hält
// deshalb die Feldliste der HostView gegen die Antwort JEDER Route, die eine
// herausgibt, und nicht nur gegen `toHostView` in einem Einzeltest.
//
// ⚠️ WAS OHNE POSTGRES UNGEPRÜFT BLEIBT und hier nicht behauptet wird: dass
// das SQL selbst richtig ist. Der erfundene Pool nimmt jede Anweisung an, die
// er wiedererkennt; ob das Einfügen mit `ON CONFLICT` in einer echten
// Datenbank die eine Zeile trifft, zeigt erst ein Postgres. Der `CHECK` der
// Spalten wird hier ebenso wenig ausgeführt — dass er dieselben Stufen trägt
// wie `THEME_KNOBS`, hält `platform/theme/theme-schema.test.ts` am Text der Migration.

// The fields a HostView carries outside, read from the schema in `contract`
// (#247) rather than listed by hand a second time. `domain/hosts/host-store.test.ts` holds
// `toHostView` against the same keys; here they are held against what really
// leaves a route. Which fields go out at all — and that none is a secret — is
// decided in `hostViewSchema`, the one list that is reviewed.
const HOST_VIEW_FIELDS = Object.keys(hostViewSchema.shape).sort();

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

function record(overrides: Partial<HostRecord> & { id: string; name: string }): HostRecord {
  return {
    agentUrl: "http://127.0.0.1:9/agent",
    kind: "internal",
    // `pending`: ein Arm in diesem Zustand wird nicht befragt. Dieser Test
    // braucht damit keinen Agenten und keine Frist.
    state: "pending",
    tunnelAddress: null,
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    registeredAt: null,
    lastSeenAt: null,
    ...overrides
  };
}

/**
 * WIE POSTGRES EINE ZEILE BENENNT — und warum diese Attrappe das nachmacht.
 *
 * ⚠️ Nachgetragen in B6/E4 (#5), und der Grund ist ein Fehler, den genau diese
 * Attrappe verdeckt hat: sie gab die Zeile bisher als `{ ...theme }` heraus,
 * also mit den Schlüsseln des Vorgabesatzes. Postgres tut das NICHT. Der Name
 * einer Ergebnisspalte ist der Bezeichner aus der Anweisung, und ein
 * Bezeichner OHNE Anführungszeichen wird dabei auf Kleinschreibung gefaltet:
 * aus `SELECT terminalScheme` kommt `terminalscheme` zurück.
 *
 * Solange alle Stellschrauben einwortig und klein hießen (`scheme`, `chroma`,
 * …), war der Unterschied nicht zu sehen. Mit `terminalScheme` ist er es:
 * `features/appearance/store.ts` liest die Zeile mit `row[knob]`, bekäme `undefined`, die
 * Oberfläche setzte `data-terminal-scheme="undefined"`, keine CSS-Regel
 * griffe — und die ganze Prüfkette bliebe grün, weil die Attrappe freundlicher
 * antwortet als das echte System.
 *
 * Eine Attrappe, die freundlicher antwortet als das System, das sie vertritt,
 * ist keine Attrappe, sondern eine Erlaubnis. In dieser Umgebung läuft kein
 * Postgres; sie ist damit die einzige Stelle, an der diese Wahrheit stehen
 * kann.
 *
 * Nachgebildet sind zwei Regeln, mehr braucht es hier nicht:
 *   - ein Bezeichner ohne Anführungszeichen kommt kleingeschrieben zurück,
 *   - `… AS "Name"` kommt wörtlich als `Name` zurück (das ist der Weg, auf dem
 *     `features/appearance/store.ts` seine Schlüssel wiederherstellt).
 * Eine Spalte, die es nicht gibt, ist hier ein Fehler — bei Postgres auch.
 */
function postgresRow(text: string, theme: Record<string, string>): Record<string, string> {
  const select = /SELECT\s+([\s\S]*?)\s+FROM\s+hub_theme/i.exec(text);
  const returning = /RETURNING\s+([\s\S]+?)\s*;?\s*$/i.exec(text);
  const list = select?.[1] ?? returning?.[1] ?? "";
  assert.ok(list.trim().length > 0, `Diese Attrappe findet in „${text}" keine Spaltenliste.`);

  const row: Record<string, string> = {};
  for (const item of list.split(",").map((part) => part.trim()).filter(Boolean)) {
    const parsed = /^([A-Za-z_]\w*)(?:\s+AS\s+"([^"]+)")?$/.exec(item);
    assert.ok(parsed, `Diese Attrappe versteht die Spaltenangabe „${item}" nicht.`);
    const column = parsed[1].toLowerCase();
    if (column === "singleton" || column === "updated_at") continue;
    const knob = Object.keys(theme).find((name) => name.toLowerCase() === column);
    assert.ok(knob, `hub_theme hat keine Spalte „${column}" — hier hätte Postgres einen Fehler gemeldet.`);
    row[parsed[2] ?? column] = theme[knob];
  }
  return row;
}

// Ein erfundener Pool mit genau dem Gedächtnis, das diese drei Routen
// anfassen: die eine Zeile der Hub-Darstellung und die zwei Spalten je Arm.
//
// ⚠️ Jede Anweisung, die er nicht wiedererkennt, ist hier ein Fehler und soll
// einer bleiben. Ein Pool, der auf alles mit einer leeren Antwort reagiert,
// machte einen Test grün, der die falsche Tabelle anspricht.
function fakePool(
  hosts: HostRecord[]
): Pool & { theme: Record<string, string>; network: { externalEndpoint: string | null }; logs: { tailLines: number } } {
  const theme: Record<string, string> = { ...DEFAULT_GLOBAL_THEME };
  // Die eine Zeile des Hub-Netzes (009). `GET /settings` liest sie mit, seit
  // dort neben `theme` auch `network` steht.
  const network: { externalEndpoint: string | null } = { externalEndpoint: null };
  // Die eine Zeile der Logansicht (010, Etappe G, #5). `GET /settings` liest
  // sie mit, seit dort neben `theme` und `network` auch `logs` steht.
  const logs: { tailLines: number } = { tailLines: DEFAULT_LOG_SETTINGS.tailLines };
  const pool = {
    theme,
    network,
    logs,
    query(text: string, values: unknown[] = []) {
      if (/SELECT .* FROM hub_theme/s.test(text)) {
        return Promise.resolve({ rows: [postgresRow(text, theme)], rowCount: 1 });
      }
      if (/^\s*INSERT INTO hub_theme/s.test(text)) {
        // Dieselbe Reihenfolge, in der `features/appearance/store.ts` die Werte bindet: die
        // Schlüssel des Vorgabesatzes.
        Object.keys(DEFAULT_GLOBAL_THEME).forEach((knob, index) => {
          const value = values[index];
          if (typeof value === "string") theme[knob] = value;
        });
        // Der Rückweg über `RETURNING` benennt die Spalten genauso wie das
        // Lesen — er ist derselbe Fall und nicht ein zweiter.
        return Promise.resolve({ rows: [postgresRow(text, theme)], rowCount: 1 });
      }
      if (/^\s*UPDATE docker_host/s.test(text)) {
        const found = hosts.find((entry) => entry.id === String(values[0]));
        if (!found) return Promise.resolve({ rows: [], rowCount: 0 });
        found.display = { hue: values[1] as never, ink: values[2] as never };
        return Promise.resolve({
          rows: [
            {
              id: found.id,
              name: found.name,
              agent_url: found.agentUrl,
              kind: found.kind,
              state: found.state,
              tunnel_address: found.tunnelAddress,
              wireguard_public_key: found.wireguardPublicKey,
              endpoint_override: found.endpointOverride,
              failed_attempts: found.failedAttempts,
              docker_gid: 996,
              bind_base_path: "/home/docker",
              hue: found.display.hue,
              ink: found.display.ink,
              created_at: found.createdAt,
              registered_at: found.registeredAt,
              last_seen_at: found.lastSeenAt
            }
          ],
          rowCount: 1
        });
      }
      if (/^\s*SELECT external_endpoint FROM hub_network/s.test(text)) {
        return Promise.resolve({ rows: [{ external_endpoint: network.externalEndpoint }], rowCount: 1 });
      }
      if (/^\s*INSERT INTO hub_network/s.test(text)) {
        network.externalEndpoint = (values[0] ?? null) as string | null;
        return Promise.resolve({ rows: [{ external_endpoint: network.externalEndpoint }], rowCount: 1 });
      }
      if (/^\s*SELECT show_system FROM container_view_settings/s.test(text)) {
        return Promise.resolve({ rows: [{ show_system: false }], rowCount: 1 });
      }
      if (/^\s*SELECT tail_lines FROM log_settings/s.test(text)) {
        return Promise.resolve({ rows: [{ tail_lines: logs.tailLines }], rowCount: 1 });
      }
      if (/^\s*INSERT INTO log_settings/s.test(text)) {
        logs.tailLines = values[0] as number;
        return Promise.resolve({ rows: [{ tail_lines: logs.tailLines }], rowCount: 1 });
      }
      throw new Error(`Unerwartete Abfrage in diesem Test: ${text}`);
    }
  };
  return pool as unknown as Pool & {
    theme: Record<string, string>;
    network: { externalEndpoint: string | null };
    logs: { tailLines: number };
  };
}

function fakeAuth(role: "admin" | "user"): Auth {
  return {
    api: {
      getSession: () =>
        Promise.resolve({ user: { id: "admin-1", name: "admin", email: "admin@example.org", role } })
    }
  } as unknown as Auth;
}

function fakeRepository(records: HostRecord[]): HostRepository {
  return {
    list: () => Promise.resolve(records),
    find: (id: string) => Promise.resolve(records.find((entry) => entry.id === id) ?? null)
  } as unknown as HostRepository;
}

type Running = {
  port: number;
  hosts: HostRecord[];
  theme: Record<string, string>;
  network: { externalEndpoint: string | null };
  logs: { tailLines: number };
  close: () => Promise<void>;
};

async function start(role: "admin" | "user" = "admin", wireguardEndpoint = "hub.test"): Promise<Running> {
  const hosts = [record({ id: "host-1", name: "local-host" }), record({ id: "host-2", name: "hub" })];
  const pool = fakePool(hosts);

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(
    "/api",
    createApiRouter({
      auth: fakeAuth(role),
      pool,
      repository: fakeRepository(hosts),
      enrollment: {} as never,
      agentSecret: "secret-der-umgebung",
      config: { wireguardEndpoint, wireguardPort: 51821 }
    })
  );
  const api = await listen(http.createServer(app));
  return { port: api.port, hosts, theme: pool.theme, network: pool.network, logs: pool.logs, close: api.close };
}

/** Der Umschlag  aus einer Antwort von , benannt. */
function networkOf(body: Record<string, unknown>): {
  externalEndpoint: string | null;
  internalTarget: string | null;
  externalTarget: string | null;
  externalTargetUnreachable: boolean;
} {
  return body.network as never;
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      // Was der Browser der eigenen Oberfläche bei jeder Anfrage
      // mitschickt. Seit Etappe B1 (#5) hängt die Herkunftsprüfung als
      // erste Zwischenschicht in `createApiRouter`; ohne diese Kopfzeile
      // wäre jede schreibende Anfrage hier ein 403 — richtig so, aber
      // dieser Fall prüft etwas anderes.
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("GET /settings gibt die Darstellung des Hubs unter „theme“ heraus", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "GET", "/settings");
    assert.equal(status, 200);
    // VOLLER Vergleich und keine Teilprüfung: eine neue Angabe unter
    // /settings soll hier auffallen und nicht durchrutschen. Sie geht an jeden
    // Angemeldeten heraus, und was das ist, gehört benannt.
    assert.deepEqual(body, {
      theme: DEFAULT_GLOBAL_THEME,
      logs: DEFAULT_LOG_SETTINGS,
      // Ob die Container des Leitstands selbst sichtbar sind — kein
      // Geheimnis, beide Container-Flächen brauchen es für jeden Benutzer.
      containers: DEFAULT_CONTAINER_VIEW_SETTINGS,
      network: {
        externalEndpoint: null,
        internalTarget: "hub.test:51821",
        externalTarget: "hub.test:51821",
        externalTargetUnreachable: false
      }
    });
  } finally {
    await running.close();
  }
});

test("PUT /settings/theme nimmt den vollen Satz unter „theme“ und antwortet mit ihm", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/theme", { theme: { ...DEFAULT_GLOBAL_THEME, scheme: "light" } });
    assert.equal(status, 200);
    // The web parses this response against the contract (#248).
    const parsed = themeResponseSchema.safeParse(body);
    assert.ok(parsed.success, `PUT /settings/theme does not match themeResponseSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data, body);
    // Der volle Satz, nicht nur das Geschickte — sonst wüsste der Editor
    // nichts von dem, was ein zweiter Administrator gestellt hat.
    assert.deepEqual(body, { theme: { ...DEFAULT_GLOBAL_THEME, scheme: "light" } });
    assert.equal(running.theme.scheme, "light");
    assert.equal(running.theme.density, DEFAULT_GLOBAL_THEME.density);
  } finally {
    await running.close();
  }
});

test("jede Stellschraube kommt einzeln zurück — auch die mit Großbuchstaben im Namen", async () => {
  // ⚠️ DER FALL, DEN EIN `deepEqual` ÜBER DEN GANZEN SATZ ZWAR AUCH FÄNGT,
  // ABER NICHT ERKLÄRT (B6/E4, #5). Er nennt die Stellschraube beim Namen,
  // weil der Grund an ihrem Namen hängt: Postgres faltet einen Bezeichner ohne
  // Anführungszeichen auf Kleinschreibung, `features/appearance/store.ts` liest die Zeile
  // aber mit dem Schlüssel der Stellschraube. Für `scheme` ist beides
  // dasselbe Wort, für `terminalScheme` nicht.
  //
  // Was ohne den Alias in `features/appearance/store.ts` geschähe: `undefined` statt einer
  // Stufe, `data-terminal-scheme="undefined"` am `<html>`, keine passende
  // CSS-Regel — und ein Terminal ohne Farben, bei grüner Prüfkette.
  const running = await start();
  try {
    for (const route of ["GET", "PUT"] as const) {
      const { status, body } =
        route === "GET"
          ? await call(running.port, "GET", "/settings")
          : await call(running.port, "PUT", "/settings/theme", { theme: { ...DEFAULT_GLOBAL_THEME } });
      assert.equal(status, 200, `${route} antwortete mit ${status}`);
      const theme = (body as { theme?: Record<string, unknown> }).theme;
      assert.ok(theme, `${route}: die Antwort trägt kein „theme“`);
      for (const knob of Object.keys(DEFAULT_GLOBAL_THEME)) {
        assert.equal(
          theme[knob],
          DEFAULT_GLOBAL_THEME[knob as keyof typeof DEFAULT_GLOBAL_THEME],
          `${route}: die Stellschraube „${knob}“ kommt als ${JSON.stringify(theme[knob])} zurück. ` +
            "Postgres benennt die Ergebnisspalte kleingeschrieben, solange die Anweisung sie nicht " +
            `mit einem gequoteten Alias zurückholt (\`SELECT ${knob} AS "${knob}"\`).`
        );
      }
    }
  } finally {
    await running.close();
  }
});

test("PUT /settings/theme lehnt einen unbekannten Wert ab und schreibt nichts", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/theme", { theme: { ...DEFAULT_GLOBAL_THEME, scheme: "sepia" } });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
    // ⚠️ Die eigentliche Aussage: „sepia" ist nicht heimlich zur Vorgabe
    // geworden, und die Ablage steht unverändert.
    assert.equal(running.theme.scheme, DEFAULT_GLOBAL_THEME.scheme);
  } finally {
    await running.close();
  }
});

test("PUT /settings/theme lehnt einen unbekannten Schlüssel ab", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/theme", { theme: { ...DEFAULT_GLOBAL_THEME, shceme: "dark" } });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/display antwortet mit der HostView dieses Arms", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/display", {
      display: { hue: "teal", ink: "card" }
    });
    assert.equal(status, 200);
    // The web parses this response against the contract (#248).
    const parsed = hostResponseSchema.safeParse(body);
    assert.ok(parsed.success, `PUT …/display does not match hostResponseSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data, body);
    const host = body.host as Record<string, unknown>;
    assert.ok(host, "die Antwort trägt kein Feld „host“");
    assert.deepEqual(host.display, { hue: "teal", ink: "card" });
    // Die übrigen Felder der HostView stehen weiterhin da — die Oberfläche
    // ersetzt ihre Zeile damit, statt sie zusammenzusetzen.
    assert.equal(host.id, "host-1");
    assert.equal(host.name, "local-host");
    assert.equal(host.status, "pending");
    assert.deepEqual(running.hosts[0].display, { hue: "teal", ink: "card" });
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/display lehnt einen Ton ab, den es nicht gibt, und schreibt nichts", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/hosts/host-1/display", {
      display: { hue: "red", ink: "card" }
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
    assert.deepEqual(running.hosts[0].display, DEFAULT_HOST_THEME);
  } finally {
    await running.close();
  }
});

test("PUT /hosts/:hostId/display meldet einen unbekannten Arm als 404", async () => {
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/hosts/gibt-es-nicht/display", {
      display: { hue: "teal", ink: "card" }
    });
    assert.equal(status, 404);
    assert.equal(body.error, "host-unknown");
  } finally {
    await running.close();
  }
});

test("GET /hosts trägt das display jedes Arms mit", async () => {
  const running = await start();
  try {
    await call(running.port, "PUT", "/hosts/host-1/display", { display: { hue: "violet", ink: "edge" } });
    const { status, body } = await call(running.port, "GET", "/hosts");
    assert.equal(status, 200);
    const hosts = body.hosts as Record<string, unknown>[];
    assert.equal(hosts.length, 2);
    assert.deepEqual(hosts[0].display, { hue: "violet", ink: "edge" });
    // Der zweite Arm wurde nicht angefasst und steht auf der Vorgabe aus
    // `DEFAULT_HOST_THEME` — nicht auf einem gerechneten Ton (#75).
    assert.deepEqual(hosts[1].display, DEFAULT_HOST_THEME);
  } finally {
    await running.close();
  }
});

test("Antwort von GET /hosts erfüllt das Schema", async () => {
  // The web parses this response against `hostListSchema` (#247) and fails on
  // a mismatch. This is the same check on the side that builds it.
  const running = await start();
  // One arm with a last contact, so the ISO instant is on the wire and not
  // only `null`.
  running.hosts[1].lastSeenAt = new Date("2026-09-30T12:34:56.789Z");
  try {
    const { status, body } = await call(running.port, "GET", "/hosts");
    assert.equal(status, 200);
    const parsed = hostListSchema.safeParse(body);
    assert.ok(parsed.success, `GET /hosts does not match hostListSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.hosts.length, 2);
    assert.equal(parsed.data.hosts[1].lastSeenAt, "2026-09-30T12:34:56.789Z");
    // Nothing the server sends is stripped by the parse: the schema knows
    // every field the route hands out.
    assert.deepEqual(parsed.data, body);
  } finally {
    await running.close();
  }
});

test("die drei schreibenden Routen verlangen Adminrechte", async () => {
  // `web/tests/api-read-only.test.mjs` hält das am TEXT des Routers fest;
  // hier steht dieselbe Zusage als Verhalten. Ein Wächter, der nur den Text
  // liest, sagt nichts darüber, ob die Zwischenschicht wirkt.
  const running = await start("user");
  try {
    const theme = await call(running.port, "PUT", "/settings/theme", { theme: { ...DEFAULT_GLOBAL_THEME, scheme: "light" } });
    assert.equal(theme.status, 403);
    const display = await call(running.port, "PUT", "/hosts/host-1/display", { display: { hue: "teal", ink: "card" } });
    assert.equal(display.status, 403);
    // Die dritte seit #4: sie entscheidet, ob ein externer Arm einen Tunnel
    // aufbauen kann, und gehört deshalb erst recht hinter die Rolle.
    const net = await call(running.port, "PUT", "/settings/network", { network: { externalEndpoint: "hub.example.net" } });
    assert.equal(net.status, 403);
    assert.equal(running.network.externalEndpoint, null, "nichts davon ist angekommen");

    // Und nichts davon ist angekommen.
    assert.equal(running.theme.scheme, DEFAULT_GLOBAL_THEME.scheme);
    assert.deepEqual(running.hosts[0].display, DEFAULT_HOST_THEME);

    // Lesen darf er: nach #17 schreibt ein Administrator, lesen alle.
    assert.equal((await call(running.port, "GET", "/settings")).status, 200);
  } finally {
    await running.close();
  }
});

test("ein unvollständiger Satz ist ein 400 und wird NICHT mit dem Gespeicherten zusammengeführt", async () => {
  // ⚠️ Der Fall, der die Kehrtwende im Vertrag festhält (Fassung vom
  // 2026-09-06). Ein halber Satz hinterließe eine Mischung aus altem und
  // neuem Stand, die niemand mehr benennen kann.
  const running = await start();
  try {
    const { status, body } = await call(running.port, "PUT", "/settings/theme", { theme: { scheme: "light" } });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid-input");
    assert.equal(running.theme.scheme, DEFAULT_GLOBAL_THEME.scheme);
  } finally {
    await running.close();
  }
});

test("ein Rumpf ohne den Umschlag ist ein 400", async () => {
  const running = await start();
  try {
    const theme = await call(running.port, "PUT", "/settings/theme", { ...DEFAULT_GLOBAL_THEME });
    assert.equal(theme.status, 400);
    const display = await call(running.port, "PUT", "/hosts/host-1/display", { hue: "teal", ink: "card" });
    assert.equal(display.status, 400);
    assert.deepEqual(running.hosts[0].display, DEFAULT_HOST_THEME);
  } finally {
    await running.close();
  }
});

test("jede Route, die eine HostView herausgibt, trägt display", async () => {
  // ⚠️ Der Befund der Oberfläche: ein fehlendes `display` macht nichts rot.
  // Deshalb wird hier nicht „irgendwo steht display" geprüft, sondern die
  // GANZE Feldliste jeder herausgegebenen HostView — ein Feld, das jemand aus
  // `toHostView` entfernt, fällt damit an vier Stellen auf einmal auf.
  const running = await start();
  const views: { where: string; view: Record<string, unknown> }[] = [];
  try {
    const list = await call(running.port, "GET", "/hosts");
    for (const view of list.body.hosts as Record<string, unknown>[]) {
      views.push({ where: "GET /hosts", view });
    }

    const overview = await call(running.port, "GET", "/overview");
    for (const entry of overview.body.hosts as Record<string, unknown>[]) {
      views.push({ where: "GET /overview", view: entry.host as Record<string, unknown> });
    }

    const containers = await call(running.port, "GET", "/hosts/host-1/containers");
    views.push({ where: "GET /hosts/:hostId/containers", view: containers.body.host as Record<string, unknown> });

    const written = await call(running.port, "PUT", "/hosts/host-1/display", {
      display: { hue: "rose", ink: "none" }
    });
    views.push({ where: "PUT /hosts/:hostId/display", view: written.body.host as Record<string, unknown> });

    // Der Wächter darf nicht dadurch grün werden, dass er nichts eingesammelt
    // hat: zwei Arme in der Liste, zwei in der Übersicht, einer aus den
    // Containern, einer aus dem Schreiben.
    assert.equal(views.length, 6, "nicht jede Route hat eine HostView geliefert");

    for (const { where, view } of views) {
      assert.ok(view, `${where}: gar keine HostView in der Antwort`);
      assert.deepEqual(
        Object.keys(view).sort(),
        HOST_VIEW_FIELDS,
        `${where}: die HostView trägt nicht genau die zugesagten Felder`
      );
      const display = view.display as Record<string, unknown>;
      assert.equal(typeof display.hue, "string", `${where}: „hue" fehlt oder ist keine Zeichenkette`);
      assert.equal(typeof display.ink, "string", `${where}: „ink" fehlt oder ist keine Zeichenkette`);
    }
  } finally {
    await running.close();
  }
});

// ── Das Netz des Hubs (#4) ──────────────────────────────────────────────────

test("eine private Adresse aus der Umgebung meldet sich als nicht erreichbar", async () => {
  // ⚠️ Genau der Stand des laufenden Hubs am 2026-09-07. Ohne diese Auskunft
  // kann der Anlege-Dialog nicht sagen, dass ein externer Arm hier ein Paket
  // bekaeme, das nie ankommt — und dann sagt es ihm niemand.
  const running = await start("admin", "192.168.77.31");
  try {
    const { body } = await call(running.port, "GET", "/settings");
    assert.equal(networkOf(body).internalTarget, "192.168.77.31:51821", "ein interner Arm wählt die Adresse im eigenen Netz");
    // Ohne abgelegte externe Adresse fällt ein EXTERNER Arm auf dieselbe zurück
    // — und genau das ist das Paket, das nie ankommt.
    assert.equal(networkOf(body).externalTarget, "192.168.77.31:51821");
    assert.equal(networkOf(body).externalTargetUnreachable, true);
    assert.equal(networkOf(body).externalEndpoint, null);
  } finally {
    await running.close();
  }
});

test("PUT /settings/network legt die Adresse ab, und eine leere nimmt sie zurück", async () => {
  const running = await start("admin", "192.168.77.31");
  try {
    const written = await call(running.port, "PUT", "/settings/network", {
      network: { externalEndpoint: "  hub.dyndns.invalid:51821  " }
    });
    assert.equal(written.status, 200);
    // The web parses this response against the contract (#248).
    const parsed = hubNetworkResponseSchema.safeParse(written.body);
    assert.ok(parsed.success, `PUT /settings/network does not match hubNetworkResponseSchema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.deepEqual(parsed.data, written.body);
    // Getrimmt abgelegt: der Wert steht unmaskiert in einer wg0.conf.
    assert.deepEqual(written.body, { network: { externalEndpoint: "hub.dyndns.invalid:51821" } });
    assert.equal(running.network.externalEndpoint, "hub.dyndns.invalid:51821");

    const read = await call(running.port, "GET", "/settings");
    // Both targets set and a stored endpoint: every field of the network
    // part carries a value, not only `null` (#248).
    const settings = settingsSchema.safeParse(read.body);
    assert.ok(settings.success, `GET /settings does not match settingsSchema: ${JSON.stringify(settings.error?.issues)}`);
    assert.deepEqual(settings.data, read.body);
    assert.equal(networkOf(read.body).externalEndpoint, "hub.dyndns.invalid:51821");
    assert.equal(networkOf(read.body).externalTarget, "hub.dyndns.invalid:51821");
    assert.equal(networkOf(read.body).externalTargetUnreachable, false);
    // ⚠️ Die Adresse aus der Umgebung bleibt daneben stehen und wird NICHT
    // ersetzt: sie gilt weiterhin für interne Arme.
    assert.equal(networkOf(read.body).internalTarget, "192.168.77.31:51821");

    const cleared = await call(running.port, "PUT", "/settings/network", { network: { externalEndpoint: "" } });
    assert.equal(cleared.status, 200);
    assert.equal(running.network.externalEndpoint, null, "leer heißt: wieder herausgenommen");
  } finally {
    await running.close();
  }
});

test("eine Adresse, die die wg0.conf zerlegen würde, ist ein 400", async () => {
  const running = await start();
  try {
    // ⚠️ Der Wert steht im Paket UNMASKIERT in `Endpoint = …`. Ein Leerzeichen
    // ergaebe dort eine zweite Angabe, ein Schrägstrich einen Pfad, den
    // WireGuard nicht kennt — und beides fällt erst auf dem fremden Host auf.
    for (const bad of ["hub example net", "http://hub.example.net", "hub.example.net/pfad", 51821]) {
      const { status, body } = await call(running.port, "PUT", "/settings/network", {
        network: { externalEndpoint: bad }
      });
      assert.equal(status, 400, `„${String(bad)}" hätte abgewiesen werden müssen`);
      assert.equal(body.error, "invalid-input");
      assert.equal(running.network.externalEndpoint, null, "nichts davon ist angekommen");
    }
    // Ein fehlender Umschlag ebenso.
    assert.equal((await call(running.port, "PUT", "/settings/network", { externalEndpoint: "x" })).status, 400);
  } finally {
    await running.close();
  }
});
