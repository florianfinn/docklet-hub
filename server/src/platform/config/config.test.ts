import test from "node:test";
import assert from "node:assert/strict";

import {
  ConfigError,
  endpointHost,
  isUnreachableFromOutside,
  loadConfig,
  parseTunnelCidr,
  resolveWireguardEndpoint
} from "./config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://hub:geheim@postgres:5432/docker_hub",
  DOCKER_AGENT_URL: "http://docker-agent:8099",
  DOCKER_AGENT_SECRET: "x".repeat(32),
  BETTER_AUTH_SECRET: "y".repeat(32)
};

test("vollständige Umgebung wird übernommen", () => {
  const config = loadConfig({ ...BASE_ENV, PORT: "9000" });
  assert.equal(config.port, 9000);
  assert.equal(config.databaseUrl, BASE_ENV.DATABASE_URL);
  assert.equal(config.agentBaseUrl, "http://docker-agent:8099");
});

test("ohne PORT gilt 8080", () => {
  assert.equal(loadConfig(BASE_ENV).port, 8080);
});

test("ein abschließender Schrägstrich an der Agent-URL wird entfernt", () => {
  // Sonst entstünde beim Zusammensetzen „…8099//health" — das trifft manche
  // Server und manche nicht, und der Unterschied fällt erst beim Fremdbetrieb auf.
  const config = loadConfig({ ...BASE_ENV, DOCKER_AGENT_URL: "http://docker-agent:8099/" });
  assert.equal(config.agentBaseUrl, "http://docker-agent:8099");
});

test("jeder Pflichtwert hält den Start an, wenn er fehlt", () => {
  for (const name of ["DATABASE_URL", "DOCKER_AGENT_URL", "DOCKER_AGENT_SECRET", "BETTER_AUTH_SECRET"]) {
    const env = { ...BASE_ENV };
    delete env[name];
    assert.throws(
      () => loadConfig(env),
      (error: unknown) => error instanceof ConfigError && (error as Error).message.startsWith(`${name} fehlt`),
      `${name} hätte den Start anhalten müssen`
    );
  }
});

test("jede Meldung nennt die Variable und sagt, woher der Wert kommt", () => {
  // Der Fehlstart bei einem Fremden ist die einzige Stelle, an der dieses
  // System sich selbst erklären muss (concept-and-plan.md §6). Eine Meldung,
  // die nur „ungültig" sagt, kostet dort den Betreiber.
  const env = { ...BASE_ENV };
  delete env.DOCKER_AGENT_SECRET;
  let caught: Error | null = null;
  try {
    loadConfig(env);
  } catch (error) {
    caught = error as Error;
  }
  assert.ok(caught, "loadConfig hätte werfen müssen");
  assert.match(caught.message, /DOCKER_AGENT_SECRET/);
  assert.match(caught.message, /bootstrap\.sh/);
});

test("ein zu kurzes Agent-Secret hält den Start an", () => {
  // Der Agent lehnt unter 32 Zeichen auf seiner Seite ab. Ohne diese Prüfung
  // startet der Hub und scheitert erst beim ersten Aufruf mit 401 — an der
  // Stelle, an der niemand die Ursache vermutet.
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DOCKER_AGENT_SECRET: "x".repeat(31) }),
    (error: unknown) => error instanceof ConfigError && /zu kurz/.test((error as Error).message)
  );
});

test("eine Datenbank-URL ohne postgres-Schema hält den Start an", () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DATABASE_URL: "mysql://hub:geheim@db:3306/hub" }),
    (error: unknown) => error instanceof ConfigError && /Postgres/.test((error as Error).message)
  );
});

test("postgresql:// wird ebenso akzeptiert wie postgres://", () => {
  const config = loadConfig({ ...BASE_ENV, DATABASE_URL: "postgresql://hub:geheim@postgres:5432/docker_hub" });
  assert.match(config.databaseUrl, /^postgresql:/);
});

test("eine unbrauchbare Portangabe hält den Start an", () => {
  for (const port of ["null", "0", "70000", "8080.5"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, PORT: port }),
      (error: unknown) => error instanceof ConfigError,
      `„${port}" hätte abgelehnt werden müssen`
    );
  }
});

test("ohne BETTER_AUTH_URL gilt localhost, und ein Schrägstrich am Ende fällt weg", () => {
  // Die Vorgabe passt zur Vorgabe von HUB_BIND_ADDRESS (127.0.0.1). Der
  // Schrägstrich fällt weg, weil better-auth die Herkunft einer Anmeldung
  // gegen diesen Wert vergleicht — und ein Vergleich, der an einem Zeichen
  // scheitert, meldet „falsche Herkunft" statt „Tippfehler".
  assert.equal(loadConfig(BASE_ENV).authBaseUrl, "http://localhost:8080");
  assert.equal(
    loadConfig({ ...BASE_ENV, BETTER_AUTH_URL: "https://docker.example.test/" }).authBaseUrl,
    "https://docker.example.test"
  );
});

test("ein zu kurzer Sitzungsschlüssel hält den Start an", () => {
  // Er gilt für ALLE Sitzungen gleichzeitig — ein kurzer Wert ist hier kein
  // kleineres Problem als ein kurzes Passwort, sondern ein größeres.
  assert.throws(
    () => loadConfig({ ...BASE_ENV, BETTER_AUTH_SECRET: "y".repeat(31) }),
    (error: unknown) => error instanceof ConfigError && /BETTER_AUTH_SECRET ist zu kurz/.test((error as Error).message)
  );
});

test("BETTER_AUTH_URL muss http oder https sein", () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, BETTER_AUTH_URL: "ftp://docker.example.test" }),
    (error: unknown) => error instanceof ConfigError
  );
});

test("ohne LOCAL_HOST_NAME trägt der lokale Host den Vorgabenamen", () => {
  // Eine Vorgabe und kein Pflichtfeld: ein frischer Betrieb soll ohne eine
  // einzige Angabe hochfahren (concept-and-plan.md §2).
  assert.equal(loadConfig(BASE_ENV).localHostName, "local");
  assert.equal(loadConfig({ ...BASE_ENV, LOCAL_HOST_NAME: "  hausserver  " }).localHostName, "hausserver");
});

// ── Tunnel: Endpoint, Port, Netz ───────────────────────────────────────────
//
// Die drei Werte tragen Phase 4a. Zwei davon haben eine Vorgabe, einer darf
// beim Start fehlen — und genau dieser eine ist der, der still fehlschlägt:
// ohne Prüfung beim Anlegen entstünde ein Archiv mit einer wg0.conf ohne
// Endpoint, und der Fehler fiele erst auf dem fremden Host auf.

test("ohne Angabe gelten die Vorgaben des Tunnels", () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.wireguardEndpoint, null);
  assert.equal(config.wireguardPort, 51821);
  assert.equal(config.tunnel.cidr, "10.254.0.0/24");
  assert.equal(config.tunnel.hubAddress, "10.254.0.1");
  assert.equal(config.tunnel.firstArmOffset, 2);
  assert.equal(config.tunnel.lastArmOffset, 254);
});

test("der Endpoint darf beim Start fehlen und wird beim Anlegen verlangt", () => {
  // concept-and-plan.md §2, „Einrichtungsaufwand": ein Pflichtwert beim Start
  // trifft jeden Betreiber, eine Frage beim ersten Arm nur den, der einen
  // anbindet.
  const config = loadConfig(BASE_ENV);
  assert.throws(
    () => resolveWireguardEndpoint(config),
    (error: unknown) =>
      error instanceof ConfigError &&
      /HUB_WIREGUARD_ENDPOINT/.test((error as Error).message) &&
      /\.env/.test((error as Error).message)
  );
});

test("ein gesetzter Endpoint bekommt den Port aus der Umgebung", () => {
  const config = loadConfig({ ...BASE_ENV, HUB_WIREGUARD_ENDPOINT: "hub.example.invalid" });
  assert.equal(resolveWireguardEndpoint(config), "hub.example.invalid:51821");
});

test("ein Endpoint mit eigenem Port behält ihn", () => {
  const config = loadConfig({ ...BASE_ENV, HUB_WIREGUARD_ENDPOINT: "hub.example.invalid:60000" });
  assert.equal(resolveWireguardEndpoint(config), "hub.example.invalid:60000");
});

test("der Wert je Arm sticht den aus der Umgebung", () => {
  const config = loadConfig({ ...BASE_ENV, HUB_WIREGUARD_ENDPOINT: "hub.example.invalid" });
  assert.equal(resolveWireguardEndpoint(config, "anders.example.invalid"), "anders.example.invalid:51821");
  // Und er genügt auch dann, wenn in der Umgebung gar nichts steht.
  assert.equal(
    resolveWireguardEndpoint(loadConfig(BASE_ENV), "anders.example.invalid:1234"),
    "anders.example.invalid:1234"
  );
});

test("eine URL als Endpoint hält den Start an", () => {
  // WireGuard meldet dazu nur „Invalid endpoint" — auf dem fremden Host, nach
  // dem Auspacken des Archivs.
  for (const value of ["https://hub.example.invalid", "hub.example.invalid/pfad"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, HUB_WIREGUARD_ENDPOINT: value }),
      (error: unknown) => error instanceof ConfigError && /HUB_WIREGUARD_ENDPOINT/.test((error as Error).message)
    );
  }
});

test("eine unbrauchbare Portangabe des Tunnels hält den Start an", () => {
  for (const value of ["0", "70000", "keine-zahl", "51821.5"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, HUB_WIREGUARD_PORT: value }),
      (error: unknown) => error instanceof ConfigError && /HUB_WIREGUARD_PORT/.test((error as Error).message)
    );
  }
});

test("ein eigenes Tunnelnetz wird übernommen, die Hub-Adresse folgt", () => {
  const config = loadConfig({ ...BASE_ENV, HUB_TUNNEL_CIDR: "192.168.77.0/25" });
  assert.equal(config.tunnel.hubAddress, "192.168.77.1");
  assert.equal(config.tunnel.lastArmOffset, 126);
});

test("eine Adresse innerhalb des Netzes wird auf das Netz maskiert", () => {
  // ⚠️ Ohne Maskierung läge der Hub auf .6 statt auf .1, und die Adressen im
  // ausgelieferten Archiv stimmten mit nichts überein, was jemand erwartet.
  const network = parseTunnelCidr("10.254.0.5/24");
  assert.equal(network.networkAddress, "10.254.0.0");
  assert.equal(network.cidr, "10.254.0.0/24");
  assert.equal(network.hubAddress, "10.254.0.1");
});

test("ein unbrauchbares Tunnelnetz hält den Start an", () => {
  for (const value of ["10.254.0.0", "10.254.0.0/33", "10.254.0.0/31", "10.254.0.0/4", "abc/24", "10.254.0.256/24", "010.254.0.0/24"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, HUB_TUNNEL_CIDR: value }),
      (error: unknown) => error instanceof ConfigError && /HUB_TUNNEL_CIDR/.test((error as Error).message),
      `„${value}" hätte den Start anhalten müssen`
    );
  }
});

test("der Schreibpfad der wg0.conf hat eine Vorgabe und muss absolut sein", () => {
  // Die Vorgabe ist der Mountpunkt des geteilten Volumes: ein frischer Betrieb
  // fährt ohne diese Zeile in der .env hoch.
  assert.equal(loadConfig(BASE_ENV).wireguardConfigPath, "/etc/wireguard/wg0.conf");
  assert.equal(
    loadConfig({ ...BASE_ENV, HUB_WIREGUARD_CONFIG_PATH: "/srv/wireguard/wg0.conf" }).wireguardConfigPath,
    "/srv/wireguard/wg0.conf"
  );
  // ⚠️ Ein relativer Pfad löst gegen das Arbeitsverzeichnis auf. Der Hub
  // schriebe dann klaglos ins Image, der Sidecar sähe die Datei nie, und
  // sichtbar wäre nur ein Arm, der in der Oberfläche steht und im Tunnel
  // fehlt — deshalb hält der Start hier an.
  for (const value of ["wg0.conf", "etc/wireguard/wg0.conf", "./wg0.conf"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, HUB_WIREGUARD_CONFIG_PATH: value }),
      (error: unknown) => error instanceof ConfigError && /HUB_WIREGUARD_CONFIG_PATH/.test((error as Error).message),
      `„${value}" hätte den Start anhalten müssen`
    );
  }
});

// ── Die Adresse des Hubs von außen (#4) ────────────────────────────────────

test("die externe Vorgabe steht zwischen dem Wert je Arm und dem der Umgebung", () => {
  const config = loadConfig({ ...BASE_ENV, HUB_WIREGUARD_ENDPOINT: "192.168.77.31" });
  // Ohne beides: die Umgebung.
  assert.equal(resolveWireguardEndpoint(config), "192.168.77.31:51821");
  // Nur die externe Vorgabe: sie sticht die Umgebung.
  assert.equal(resolveWireguardEndpoint(config, null, "hub.dyndns.invalid"), "hub.dyndns.invalid:51821");
  // ⚠️ Beides: der Wert AM ARM gewinnt. Stuende die Vorgabe davor, könnte ein
  // Betreiber einen einzelnen externen Arm nicht mehr anders anbinden als alle
  // übrigen — und genau dafür gibt es den Override.
  assert.equal(
    resolveWireguardEndpoint(config, "nur.dieser.invalid", "hub.dyndns.invalid"),
    "nur.dieser.invalid:51821"
  );
  // Leerzeichen sind kein Wert.
  assert.equal(resolveWireguardEndpoint(config, "   ", "hub.dyndns.invalid"), "hub.dyndns.invalid:51821");
});

test("der Host-Teil wird aus allen drei Schreibweisen gelesen", () => {
  assert.equal(endpointHost("hub.example.invalid"), "hub.example.invalid");
  assert.equal(endpointHost("hub.example.invalid:51821"), "hub.example.invalid");
  assert.equal(endpointHost("10.0.0.5"), "10.0.0.5");
  assert.equal(endpointHost("[2001:db8::1]:51821"), "2001:db8::1");
  assert.equal(endpointHost("[2001:db8::1]"), "2001:db8::1");
  // ⚠️ Ein bloßes IPv6 OHNE Klammern bleibt ganz. Die Form `host:port` hat
  // höchstens EINEN Doppelpunkt; wer hier nur am letzten trennte, machte aus
  // `::1` den Host `:` und hätte dessen Klasse verloren.
  assert.equal(endpointHost("::1"), "::1");
});

test("private Adressen gelten als nicht erreichbar, Namen nicht", () => {
  // Synthetic private addresses exercise reachability classification.
  for (const unreachable of [
    "192.168.77.31",
    "192.168.77.31:51821",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "[::1]:51821",
    "::1",
    "[fd00::1]:51821",
    "fe80::1"
  ]) {
    assert.equal(isUnreachableFromOutside(unreachable), true, `„${unreachable}" müsste abgewiesen werden`);
  }

  // ⚠️ Ein NAME gilt als erreichbar, und das ist die Aussage dieser Funktion:
  // sie beweist die Unerreichbarkeit, sie behauptet nicht die Erreichbarkeit.
  // Ein DynDNS-Name ist die normale Antwort für einen externen Arm, und dieser
  // Hub weiß nicht, worauf er zeigt.
  for (const allowed of [
    "hub.dyndns.invalid",
    "hub.dyndns.invalid:51821",
    "203.0.113.7",
    "172.32.0.1", // knapp NEBEN 172.16.0.0/12
    "172.15.255.255",
    "100.128.0.1", // knapp neben dem CGNAT-Bereich
    "11.0.0.1",
    "[2001:db8::1]:51821"
  ]) {
    assert.equal(isUnreachableFromOutside(allowed), false, `„${allowed}" dürfte nicht abgewiesen werden`);
  }
});

test("ohne HUB_HOST_CYCLE_INTERVAL_SECONDS läuft der Hintergrundlauf im Minutentakt", () => {
  assert.equal(loadConfig(BASE_ENV).hostCycleIntervalSeconds, 60);
  assert.equal(loadConfig({ ...BASE_ENV, HUB_HOST_CYCLE_INTERVAL_SECONDS: "  120 " }).hostCycleIntervalSeconds, 120);
  // Ein leerer Eintrag meint „nichts gesetzt" und nicht „abgeschaltet".
  assert.equal(loadConfig({ ...BASE_ENV, HUB_HOST_CYCLE_INTERVAL_SECONDS: "" }).hostCycleIntervalSeconds, 60);
});

test("HUB_HOST_CYCLE_INTERVAL_SECONDS auf 0 schaltet den Hintergrundlauf ab", () => {
  // ⚠️ Der Fall, den ein `||` still verschluckt hätte: „0" ist leer-gleich und
  // fiele damit auf die Vorgabe zurück — die Bremse ließe sich nicht ziehen,
  // und niemand sähe warum.
  assert.equal(loadConfig({ ...BASE_ENV, HUB_HOST_CYCLE_INTERVAL_SECONDS: "0" }).hostCycleIntervalSeconds, 0);
});

test("eine unbrauchbare Taktangabe hält den Start an", () => {
  for (const value of ["-1", "1.5", "abc", "86401", "60s"]) {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, HUB_HOST_CYCLE_INTERVAL_SECONDS: value }),
      (error: unknown) =>
        error instanceof ConfigError && error.message.startsWith("HUB_HOST_CYCLE_INTERVAL_SECONDS ist keine"),
      `„${value}" hätte den Start anhalten müssen`
    );
  }
});
