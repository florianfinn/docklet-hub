import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { MAX_REGISTRATION_ATTEMPTS, MIN_REGISTRATION_TOKEN_LENGTH } from "../../domain/hosts/index.js";
import { createRegistrationApp, type RegistrationDeps, type RegistrationHost } from "./registration-app.js";
import { ipv6LoopbackUnavailable, listenOnFetchablePort } from "../../platform/testing/port-test-support.js";

// Je Bedingung aus §1 des Entwurfs ein eigener Fall — und zwar jeweils der,
// der OHNE die Bedingung durchkäme. Ein Test, der eine Bedingung nur nicht
// auslöst, beweist nichts über sie.
//
// Geprüft wird über einen echten Socket (`http.createServer` auf Port 0,
// `fetch` gegen 127.0.0.1) und mit Rückrufen statt einer Datenbank. Der Socket
// ist kein Zierrat: die Quelladresse ist genau die Angabe, die in einer
// eingespeisten Anfrage frei erfunden wäre — und die Fehlerklasse dieser Datei
// ist die, bei der die Herkunft aus einer Kopfzeile statt aus dem Socket kommt.
// Über 127.0.0.1 hinaus geht nichts ins Netz.

const NO_IPV6 = await ipv6LoopbackUnavailable();

const TOKEN = "z".repeat(MIN_REGISTRATION_TOKEN_LENGTH);
const HOST_ID = "host-a";

function pendingHost(overrides: Partial<RegistrationHost> = {}): RegistrationHost {
  return {
    id: HOST_ID,
    agentUrl: "http://127.0.0.1:8099",
    state: "pending",
    tunnelAddress: "127.0.0.1",
    failedAttempts: 0,
    ...overrides
  };
}

type Claim = { hostId: string; token: string; sourceAddress: string; listenPort: number };

type Fake = {
  deps: RegistrationDeps;
  // Die Reihenfolge der Rückrufe. An ihr hängt die Zusage aus §1, dass die
  // Gegenprobe VOR dem Verbrauch des Tokens läuft.
  order: string[];
  addresses: string[];
  probes: { baseUrl: string; hostId: string }[];
  claims: Claim[];
  failures: string[];
  logs: string[];
};

function createFake(options: {
  host?: RegistrationHost | null;
  reachable?: boolean;
  consumed?: RegistrationHost | null;
  failWhenFinding?: Error;
} = {}): Fake {
  const fake: Fake = { deps: {} as RegistrationDeps, order: [], addresses: [], probes: [], claims: [], failures: [], logs: [] };
  fake.deps = {
    findHostByTunnelAddress: async (address) => {
      fake.order.push("find");
      fake.addresses.push(address);
      if (options.failWhenFinding) throw options.failWhenFinding;
      return options.host === undefined ? pendingHost() : options.host;
    },
    probeAgent: async (baseUrl, hostId) => {
      fake.order.push("probe");
      fake.probes.push({ baseUrl, hostId });
      return options.reachable ?? true;
    },
    consumeToken: async (claim) => {
      fake.order.push("consume");
      fake.claims.push(claim);
      if (options.consumed !== undefined) return options.consumed;
      return { ...pendingHost(), state: "registered" };
    },
    recordFailure: async (hostId) => {
      fake.order.push("failure");
      fake.failures.push(hostId);
    },
    log: (message) => fake.logs.push(message)
  };
  return fake;
}

type Attempt = {
  path?: string;
  method?: string;
  token?: string | null;
  body?: unknown;
  raw?: string;
  contentType?: string | null;
  extraHeaders?: Record<string, string>;
};

// Startet die App auf einem freien Port und ruft sie genau so auf, wie der
// Agent es täte. Lausch- und Zieladresse sind getrennt einspeisbar, weil zwei
// Fälle an der Adressfamilie hängen (Bedingung 3): ein Listener über beide
// Familien meldet eine Verbindung über 127.0.0.1 als „::ffff:127.0.0.1" und
// eine über ::1 als „::1".
//
// ⚠️ Both cases need an IPv6 loopback interface. Without one (cloud
// containers, #286) they are skipped with the reason in the output, not
// silently. The address handling itself stays covered without IPv6 by the
// `normalizeTunnelAddress` tests in `domain/hosts`; only the wiring through a
// real dual-stack socket goes unchecked there.
async function withApp(
  deps: RegistrationDeps,
  run: (call: (attempt?: Attempt) => Promise<{ status: number; body: string }>) => Promise<void>,
  where: { listen?: string; connect?: string } = {}
): Promise<void> {
  const listenHost = where.listen ?? "127.0.0.1";
  const connectHost = where.connect ?? (listenHost === "::" ? "[::1]" : listenHost);
  const server = http.createServer(createRegistrationApp(deps));
  await listenOnFetchablePort(server, listenHost);
  const { port } = server.address() as AddressInfo;
  const origin = `http://${connectHost}:${port}`;

  const call = async (attempt: Attempt = {}): Promise<{ status: number; body: string }> => {
    const headers: Record<string, string> = { ...attempt.extraHeaders };
    const contentType = attempt.contentType === undefined ? "application/json" : attempt.contentType;
    if (contentType !== null) headers["content-type"] = contentType;
    const token = attempt.token === undefined ? TOKEN : attempt.token;
    if (token !== null) headers["x-docker-host-registration"] = token;
    const body =
      attempt.raw ??
      JSON.stringify(
        attempt.body ?? { agentVersion: "0.18.1", listenHost: "10.254.0.2", listenPort: 8099, readOnly: false }
      );
    const response = await fetch(`${origin}${attempt.path ?? `/hosts/${HOST_ID}/register`}`, {
      method: attempt.method ?? "POST",
      headers,
      body: attempt.method === "GET" ? undefined : body
    });
    return { status: response.status, body: await response.text() };
  };

  try {
    await run(call);
  } finally {
    // Ohne das Kappen offener Verbindungen wartet `close` auf die
    // Keep-alive-Sockets von `fetch` und der Testlauf hinge.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("Bedingung 1: außer POST auf der einen Route gibt es nichts — 404 und kein Rückruf", async () => {
  const fake = createFake();
  await withApp(fake.deps, async (call) => {
    // Ohne die Zusage „genau eine Route" käme jeder dieser Aufrufe irgendwo an.
    const wrongMethod = await call({ method: "GET" });
    const wrongPath = await call({ path: `/hosts/${HOST_ID}/register/extra` });
    const bareCollection = await call({ path: "/hosts" });
    const root = await call({ path: "/" });
    assert.deepEqual(
      [wrongMethod.status, wrongPath.status, bareCollection.status, root.status],
      [404, 404, 404, 404]
    );
    assert.deepEqual(fake.order, []);
  });
});

test("Bedingung 2: ein Rumpf, der kein JSON ist, wird abgelehnt — 400 statt 500", async () => {
  const fake = createFake();
  await withApp(fake.deps, async (call) => {
    // Ohne content-type liest `express.json` gar nicht; der Rumpf bleibt leer.
    // Ohne diese Bedingung fiele der Zugriff darauf in den Fehlerbehandler und
    // der Aufrufer bekäme eine 500 — für den Agenten wiederholbar, und er
    // versuchte es eine Viertelstunde lang.
    const withoutType = await call({ contentType: null, raw: "hallo" });
    const brokenJson = await call({ raw: "{" });
    const notAnObject = await call({ raw: "[1,2,3]" });
    // Deutlich über 64 KB.
    const tooLarge = await call({ raw: JSON.stringify({ listenPort: 8099, pad: "x".repeat(200_000) }) });
    assert.deepEqual(
      [withoutType.status, brokenJson.status, notAnObject.status, tooLarge.status],
      [400, 400, 400, 400]
    );
    for (const answer of [withoutType, brokenJson, notAnObject, tooLarge]) {
      assert.deepEqual(JSON.parse(answer.body), { error: "kein JSON-Rumpf" });
    }
    // Kein Rückruf: ein Rumpf, der nicht lesbar ist, kostet weder eine Abfrage
    // noch einen Fehlversuch.
    assert.deepEqual(fake.order, []);
  });
});

test("Bedingung 2: ein unbrauchbarer listenPort wird abgelehnt, ohne einen Fehlversuch zu kosten", async () => {
  const fake = createFake();
  await withApp(fake.deps, async (call) => {
    // Ohne diese Prüfung ginge der Wert in die Gegenprobe („http://ip:0") und
    // von dort in die Datenbank — die Anmeldung schlüge fehl UND zählte einen
    // Fehlversuch, obwohl kein Geheimnis im Spiel war.
    const zero = await call({ body: { listenPort: 0 } });
    const missing = await call({ body: { agentVersion: "0.18.1" } });
    const text = await call({ body: { listenPort: "8099" } });
    const fraction = await call({ body: { listenPort: 80.5 } });
    assert.deepEqual([zero.status, missing.status, text.status, fraction.status], [400, 400, 400, 400]);
    assert.deepEqual(fake.order, []);
  });
});

test("Bedingung 3: eine Quelladresse, die keine IPv4 ist, wird abgelehnt", { skip: NO_IPV6 }, async () => {
  const fake = createFake();
  // Über ::1 kommt die Anfrage mit einer Adresse an, die sich nicht gegen eine
  // Tunneladresse vergleichen lässt. Ohne diese Bedingung ginge der Rohwert an
  // die Suche und von dort als `'::1'::inet` an Postgres.
  await withApp(
    fake.deps,
    async (call) => {
      const answer = await call();
      assert.equal(answer.status, 403);
      assert.deepEqual(fake.order, []);
    },
    { listen: "::" }
  );
});

test("Bedingung 3: die IPv4-abgebildete Form ::ffff: wird zurückgeführt", { skip: NO_IPV6 }, async () => {
  const fake = createFake();
  // Derselbe Listener über beide Adressfamilien, diesmal über 127.0.0.1
  // angesprochen: Node meldet dann „::ffff:127.0.0.1". Ohne die Rückführung
  // fände die Suche nichts, und JEDER Arm bekäme „unbekannte Herkunft" — im
  // Test mit einem eingespeisten Aufruf fiele das nie auf.
  await withApp(
    fake.deps,
    async (call) => {
      const answer = await call();
      assert.equal(answer.status, 200);
      assert.deepEqual(fake.addresses, ["127.0.0.1"]);
    },
    { listen: "::", connect: "127.0.0.1" }
  );
});

test("Bedingung 3: X-Forwarded-For bestimmt die Herkunft nicht", async () => {
  // Die stillste Falle dieser Fläche: mit `trust proxy` oder einem gelesenen
  // X-Forwarded-For nennt der Aufrufer seine eigene Quelladresse, und die
  // Bedingungen 3 und 4 sind wertlos — bei grünen Tests.
  const fake = createFake({ host: null });
  await withApp(fake.deps, async (call) => {
    const answer = await call({
      extraHeaders: { "x-forwarded-for": "10.254.0.2", "x-real-ip": "10.254.0.2", forwarded: "for=10.254.0.2" }
    });
    assert.equal(answer.status, 403);
    // Die Suche hat die Adresse des Sockets gesehen und nicht die genannte.
    assert.deepEqual(fake.addresses, ["127.0.0.1"]);
  });
});

test("Bedingung 4: zu einer Quelladresse ohne Host gibt es keine Anmeldung", async () => {
  const fake = createFake({ host: null });
  await withApp(fake.deps, async (call) => {
    const answer = await call();
    assert.equal(answer.status, 403);
    assert.deepEqual(JSON.parse(answer.body), { error: "unbekannte Herkunft" });
    // Ohne die Bedingung liefe der Ablauf mit einem leeren Host weiter — und
    // das Token ginge an die Datenbank.
    assert.deepEqual(fake.order, ["find"]);
  });
});

test("Bedingung 5: ein angebundener Arm meldet keinen anderen an", async () => {
  const fake = createFake({ host: pendingHost({ id: "host-a" }) });
  await withApp(fake.deps, async (call) => {
    // Die Quelladresse gehört host-a, der Pfad nennt host-b. Ohne die Bedingung
    // ginge genau dieser Anspruch an `consumeToken`.
    const answer = await call({ path: "/hosts/host-b/register" });
    assert.equal(answer.status, 403);
    assert.deepEqual(fake.order, ["find"]);
    assert.deepEqual(fake.claims, []);
  });
});

test("Bedingung 6: ohne Kopfzeile oder mit zu kurzem Token endet es mit 401", async () => {
  const fake = createFake();
  await withApp(fake.deps, async (call) => {
    const missing = await call({ token: null });
    const tooShort = await call({ token: "z".repeat(MIN_REGISTRATION_TOKEN_LENGTH - 1) });
    const empty = await call({ token: "" });
    assert.deepEqual([missing.status, tooShort.status, empty.status], [401, 401, 401]);
    // Ohne die Bedingung liefen Gegenprobe und Tokenverbrauch mit einer leeren
    // Zeichenkette los.
    assert.deepEqual(fake.claims, []);
    assert.deepEqual(fake.probes, []);
  });
});

test("Bedingung 7: ab zwölf Fehlversuchen nimmt der Hub das Token nicht mehr an", async () => {
  const fake = createFake({ host: pendingHost({ failedAttempts: MAX_REGISTRATION_ATTEMPTS }) });
  await withApp(fake.deps, async (call) => {
    // Der Fall, der ohne die Sperre durchkäme: ein Aufrufer, der weiter rät.
    const answer = await call();
    assert.equal(answer.status, 403);
    assert.deepEqual(JSON.parse(answer.body), { error: "Anmeldung gesperrt" });
    assert.deepEqual(fake.order, ["find"]);
  });
});

test("Bedingung 8: derselbe Arm meldet sich zweimal — 200 ohne zweiten Verbrauch", async () => {
  const fake = createFake({ host: pendingHost({ state: "registered" }) });
  await withApp(fake.deps, async (call) => {
    // Der Agent hat seinen Marker nicht schreiben können und meldet sich mit
    // einem Token, das es nicht mehr gibt. Ohne Bedingung 8 liefe er in
    // Bedingung 10, bekäme 401 — für ihn endgültig — und zählte einen
    // Fehlversuch, obwohl er der richtige Arm ist.
    const answer = await call();
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), { status: "registered", hostId: HOST_ID });
    assert.deepEqual(fake.order, ["find"]);
    assert.deepEqual(fake.failures, []);
  });
});

test("Bedingung 9: ein nicht erreichbarer Agent bekommt 503 — und behält sein Token", async () => {
  const fake = createFake({ reachable: false });
  await withApp(fake.deps, async (call) => {
    const answer = await call();
    assert.equal(answer.status, 503);
    assert.deepEqual(JSON.parse(answer.body), { error: "Agent nicht erreichbar" });
    // Der Kern der Reihenfolge aus §1: ohne die Gegenprobe VOR dem Verbrauch
    // hätte dieser Arm sein Einmal-Token verloren und könnte sich nie wieder
    // melden — der Weg zurück wäre ein neues Archiv.
    assert.deepEqual(fake.order, ["find", "probe"]);
    assert.deepEqual(fake.claims, []);
    // Und die vergebliche Probe kostet keinen Fehlversuch.
    assert.deepEqual(fake.failures, []);
  });
});

test("Bedingung 9: die Probe geht gegen die Quelladresse, nicht gegen listenHost", async () => {
  const fake = createFake();
  await withApp(fake.deps, async (call) => {
    // `listenHost` ist eine Angabe der Gegenseite. Ginge die Probe dorthin,
    // ließe sich der Hub auf eine beliebige Adresse schicken — und im Test
    // gegen einen eingespeisten Agenten fiele das nicht auf.
    const answer = await call({
      body: { agentVersion: "0.18.1", listenHost: "10.9.9.9", listenPort: 9099, readOnly: false }
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(fake.probes, [{ baseUrl: "http://127.0.0.1:9099", hostId: HOST_ID }]);
  });
});

test("Bedingung 10: ein Token ohne Treffer ergibt 401 und genau einen Fehlversuch", async () => {
  const fake = createFake({ consumed: null });
  await withApp(fake.deps, async (call) => {
    const answer = await call();
    assert.equal(answer.status, 401);
    assert.deepEqual(JSON.parse(answer.body), { error: "Anmeldung abgelehnt" });
    // Genau einmal: ein zweifach gezählter Fehlversuch sperrte einen Arm nach
    // sechs statt nach zwölf Versuchen aus.
    assert.deepEqual(fake.failures, [HOST_ID]);
    assert.deepEqual(fake.order, ["find", "probe", "consume", "failure"]);
  });
});

test("Bedingung 11: der Erfolgsfall verbraucht das Token genau einmal, nach der Gegenprobe", async () => {
  const fake = createFake();
  await withApp(fake.deps, async (call) => {
    const answer = await call({
      body: { agentVersion: "0.18.1", listenHost: "0.0.0.0", listenPort: 8099, readOnly: false }
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), { status: "registered", hostId: HOST_ID });
    assert.deepEqual(fake.claims, [
      { hostId: HOST_ID, token: TOKEN, sourceAddress: "127.0.0.1", listenPort: 8099 }
    ]);
    assert.deepEqual(fake.order, ["find", "probe", "consume"]);
    assert.deepEqual(fake.failures, []);
    // Die Antwort trägt kein Geheimnis.
    assert.ok(!answer.body.includes(TOKEN));
  });
});

test("der eigene Fehlerbehandler: Stacktrace ins Log, nach draußen nur ein kurzer Text", async () => {
  const fake = createFake({ failWhenFinding: new Error("Verbindung zur Datenbank fehlgeschlagen") });
  await withApp(fake.deps, async (call) => {
    const answer = await call();
    assert.equal(answer.status, 500);
    assert.deepEqual(JSON.parse(answer.body), { error: "interner Fehler" });
    // Nach draußen nichts über das Innere: weder Meldung noch Stacktrace.
    assert.ok(!answer.body.includes("Datenbank"));
    assert.ok(!answer.body.includes("registration-app"));
    const logged = fake.logs.join("\n");
    assert.match(logged, /Verbindung zur Datenbank fehlgeschlagen/);
    // Ein Stacktrace und nicht nur die Meldung: ohne ihn ist ein 500 im
    // Betrieb eine Zeile ohne Fundstelle.
    assert.match(logged, /\n\s+at /);
  });
});

test("kein Token in irgendeiner Logzeile — auch nicht aus Pfad oder Rumpf", async () => {
  // Ein Token im Zugriffslog ist so gut wie keines. Der Fall kommt grün durch
  // jeden Test, der die Logzeilen nicht liest.
  const secret = `S${"k".repeat(40)}`;
  const fake = createFake({ consumed: null });
  await withApp(fake.deps, async (call) => {
    await call({ token: secret });
    // Ein Aufrufer, der sein Token in den Pfad legt: die Kennung aus dem Pfad
    // darf deshalb nirgends protokolliert werden.
    await call({ path: `/hosts/${secret}/register`, token: secret });
    // Und einer, der es in den Rumpf legt — auch der Fehlerfall des
    // Rumpf-Lesers darf ihn nicht zitieren.
    await call({ raw: `{"listenPort":8099,"token":"${secret}"` , token: secret });
    assert.ok(fake.logs.length >= 3, `zu wenige Logzeilen: ${fake.logs.length}`);
    const leaking = fake.logs.filter((line) => line.includes(secret));
    assert.deepEqual(leaking, [], `Token in Logzeile:\n${leaking.join("\n")}`);
  });
});

test("zwei gleichzeitige Anmeldungen desselben Arms verbrauchen das Token nicht doppelt", async () => {
  // Der Rückruf entscheidet, nicht die App: `consumeToken` ist EINE Anweisung
  // (domain/hosts/host-store.ts), und die zweite Anfrage findet nichts mehr. Hier wird geprüft,
  // dass die App diese Entscheidung nicht unterläuft — etwa durch einen
  // gemerkten Zustand zwischen zwei Aufrufen.
  let consumed = 0;
  const fake = createFake();
  const deps: RegistrationDeps = {
    ...fake.deps,
    consumeToken: async (claim) => {
      fake.claims.push(claim);
      consumed += 1;
      return consumed === 1 ? { ...pendingHost(), state: "registered" } : null;
    }
  };
  await withApp(deps, async (call) => {
    const [first, second] = await Promise.all([call(), call()]);
    const codes = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(codes, [200, 401]);
    assert.equal(fake.claims.length, 2);
    assert.equal(consumed, 2);
    assert.deepEqual(fake.failures, [HOST_ID]);
  });
});
