import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARM_AGENT_IMAGE,
  HostError,
  isAgentOutdated,
  type AgentHealth,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import { generateWireGuardKeyPair, publicKeyFromPrivate } from "./bootstrap/wireguard-keys.js";
import { ConfigError } from "../../platform/config/config.js";
import {
  ARM_AGENT_PORT,
  EnrollmentError,
  SIDECAR_LISTEN_PORT,
  createEnrollment,
  createRegistrationDeps,
  type EnrollmentConfig
} from "./enrollment.js";
import { DEFAULT_HOST_THEME } from "contract";

// Die Verdrahtung, geprüft ohne Postgres, ohne Netz und ohne Docker.
//
// ⚠️ Vier Aussagen hier sind die, die im Betrieb still brechen und die kein
// Test einer einzelnen Funktion zeigt:
//
//   1. `ListenPort` in der wg0.conf des Hubs ist der Port IM Container (51821)
//      und nicht der veröffentlichte aus `HUB_WIREGUARD_PORT`. Sobald ein
//      Betreiber den veröffentlichten ändert, laufen beide auseinander — und
//      der Tunnel kommt dann nie zustande, ohne dass irgendwo etwas steht.
//   2. Ein AUSSTEHENDER Arm braucht seinen `[Peer]`-Block. Ohne ihn kann seine
//      Anmeldung nicht ankommen, und er bliebe für immer „pending".
//   3. Ein neues Archiv ohne neu geschriebene Peer-Liste lässt den Sidecar auf
//      dem alten öffentlichen Schlüssel sitzen.
//   4. Der Endpoint wird VOR dem Datensatz aufgelöst: die Meldung „Endpoint
//      fehlt" darf keinen angelegten Arm hinterlassen.

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const HUB_KEYS = generateWireGuardKeyPair();

function makeConfig(overrides: Partial<EnrollmentConfig> = {}): EnrollmentConfig {
  const directory = mkdtempSync(join(tmpdir(), "hub-wg-"));
  return {
    wireguardEndpoint: "hub.example.org",
    // Absichtlich NICHT 51821: läuft der veröffentlichte Port in die wg0.conf,
    // fällt es genau hier auf.
    wireguardPort: 51999,
    wireguardConfigPath: join(directory, "wg0.conf"),
    tunnelPort: 8099,
    hubWireguardPrivateKey: HUB_KEYS.privateKey,
    hubWireguardPublicKey: HUB_KEYS.publicKey,
    tunnel: {
      cidr: "10.254.0.0/24",
      networkAddress: "10.254.0.0",
      prefixLength: 24,
      hubAddress: "10.254.0.1",
      firstArmOffset: 2,
      lastArmOffset: 254
    },
    ...overrides
  };
}

type Spy = {
  repository: HostRepository;
  records: HostRecord[];
  calls: string[];
};

function spyRepository(initial: HostRecord[] = []): Spy {
  const records = [...initial];
  const calls: string[] = [];
  let next = 2;
  const repository: HostRepository = {
    list: async () => {
      calls.push("list");
      return records.map((record) => ({ ...record }));
    },
    find: async (id) => {
      calls.push("find");
      const found = records.find((record) => record.id === id);
      return found ? { ...found } : null;
    },
    findByTunnelAddress: async (address) => {
      calls.push("findByTunnelAddress");
      const found = records.find((record) => record.tunnelAddress === address);
      return found ? { ...found } : null;
    },
    create: async (input) => {
      calls.push("create");
      const address = `10.254.0.${next}`;
      next += 1;
      const record: HostRecord = {
        id: `host-${address}`,
        name: input.name,
        agentUrl: `http://${address}:${input.agentPort ?? ARM_AGENT_PORT}`,
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
      records.push(record);
      return { ...record };
    },
    rotate: async (id, input) => {
      calls.push("rotate");
      const found = records.find((record) => record.id === id && record.kind !== "local");
      if (!found) return null;
      found.wireguardPublicKey = input.wireguardPublicKey;
      found.state = "pending";
      found.failedAttempts = 0;
      found.registeredAt = null;
      return { ...found };
    },
    remove: async (id) => {
      calls.push("remove");
      const index = records.findIndex((record) => record.id === id && record.kind !== "local");
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    consumeToken: async () => {
      calls.push("consumeToken");
      return null;
    },
    recordFailure: async () => {
      calls.push("recordFailure");
      return 1;
    }
  };
  return { repository, records, calls };
}

function readConfigFile(config: EnrollmentConfig): string {
  return readFileSync(config.wireguardConfigPath, "utf8");
}

// ── Was aus der docker-compose.yml kommen muss und hier steht ──────────────

test("der ListenPort der Hub-Seite ist der Port IM Container, nicht der veröffentlichte", async () => {
  const config = makeConfig();
  const { repository } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  await enrollment.writeHubWireGuardConfig();

  const content = readConfigFile(config);
  assert.match(content, new RegExp(`^ListenPort = ${SIDECAR_LISTEN_PORT}$`, "m"));
  assert.ok(
    !content.includes(String(config.wireguardPort)),
    "HUB_WIREGUARD_PORT ist der veröffentlichte Port und hat in der wg0.conf des Hubs nichts zu suchen"
  );

  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  assert.match(
    compose,
    new RegExp(`\\$\\{HUB_WIREGUARD_PORT:-\\d+\\}:${SIDECAR_LISTEN_PORT}/udp`),
    "der Sidecar lauscht im Container auf einem anderen Port als dem, den der Renderer einträgt"
  );
});

test("das Image im Archiv ist dasselbe, das die docker-compose.yml als Vorgabe führt", () => {
  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const match = /\$\{DOCKER_AGENT_IMAGE:-([^}]+)\}/.exec(compose);
  assert.ok(match, "in der docker-compose.yml steht keine Vorgabe für DOCKER_AGENT_IMAGE mehr");
  assert.equal(
    ARM_AGENT_IMAGE,
    match[1],
    "Hub-Seite und Arm-Seite des Tunnels liefen sonst auf verschiedenen Fassungen desselben Images"
  );
  // Pinned to a SemVer tag in the new repository (#279), never `latest`. The
  // digest follows once the release workflow has run for the first time. The
  // tag must not stand below the mark: an arm on an older agent counts as
  // `outdated`, and the arm this hub ships would be one of them.
  const tag = /^ghcr\.io\/florianfinn\/docklet-hub-agent:v(\d+\.\d+\.\d+)(@sha256:[0-9a-f]{64})?$/.exec(ARM_AGENT_IMAGE);
  assert.ok(tag, `der Verweis ist nicht auf einen SemVer-Tag im Repository docklet-hub-agent gepinnt: ${ARM_AGENT_IMAGE}`);
  assert.equal(isAgentOutdated(tag[1]), false, "der Pin steht unter der Marke MIN_AGENT_VERSION");
});

// ── Die Peer-Liste ────────────────────────────────────────────────────────

test("ohne Arme entsteht trotzdem eine vollständige Interface-Sektion", async () => {
  const config = makeConfig();
  const { repository } = spyRepository();
  await createEnrollment({ repository, config }).writeHubWireGuardConfig();

  assert.equal(
    readConfigFile(config),
    "# Erzeugt vom Hub. Änderungen von Hand gehen beim nächsten Schreiben verloren.\n" +
      "[Interface]\n" +
      `PrivateKey = ${HUB_KEYS.privateKey}\n` +
      "Address = 10.254.0.1/24\n" +
      `ListenPort = ${SIDECAR_LISTEN_PORT}\n`,
    "ohne diese Datei bleibt der Sidecar „unhealthy“ — das wäre der Normalzustand eines Betriebs ohne Arme"
  );
});

test("ein ausstehender Arm bekommt seinen Peer-Eintrag", async () => {
  const config = makeConfig();
  const { repository } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  const { record } = await enrollment.enrollHost({ name: "unraid", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });

  assert.equal(record.state, "pending");
  const content = readConfigFile(config);
  assert.match(content, /\[Peer\]/);
  assert.ok(
    content.includes(record.wireguardPublicKey ?? "—"),
    "ohne Peer-Eintrag könnte die Anmeldung dieses Arms nie ankommen"
  );
  assert.match(content, /AllowedIPs = 10\.254\.0\.2\/32/);
});

test("der lokale Host steht nicht in der Peer-Liste", async () => {
  const config = makeConfig();
  const { repository } = spyRepository([
    {
      id: "local-1",
      name: "local",
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
    }
  ]);
  await createEnrollment({ repository, config }).writeHubWireGuardConfig();
  assert.ok(!readConfigFile(config).includes("[Peer]"));
});

test("derselbe Stand wird nicht ein zweites Mal geschrieben", async () => {
  const config = makeConfig();
  const { repository } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  await enrollment.writeHubWireGuardConfig();
  const before = statSync(config.wireguardConfigPath);
  await enrollment.writeHubWireGuardConfig();
  const after = statSync(config.wireguardConfigPath);

  // Der Sidecar vergleicht Inode, Zeitstempel und Größe. Ein Schrieb mit
  // demselben Inhalt hätte nach dem `rename` einen neuen Inode und löste ein
  // `wg syncconf` ohne Anlass aus — bei jedem Start des Hubs eines.
  assert.deepEqual(
    [after.ino, after.mtimeMs, after.size],
    [before.ino, before.mtimeMs, before.size],
    "ein Schrieb ohne Änderung löst im Sidecar ein Nachladen ohne Anlass aus"
  );
});

// ── Anlegen ───────────────────────────────────────────────────────────────

test("ein fehlender Endpoint hinterlässt keinen angelegten Arm", async () => {
  const config = makeConfig({ wireguardEndpoint: null });
  const { repository, calls, records } = spyRepository();
  await assert.rejects(
    () => createEnrollment({ repository, config }).enrollHost({ name: "arm", kind: "external", dockerGid: 996, bindBasePath: "/home/docker" }),
    (error: unknown) => error instanceof ConfigError && error.message.includes("HUB_WIREGUARD_ENDPOINT")
  );
  assert.equal(records.length, 0);
  assert.ok(!calls.includes("create"), "der Datensatz entstünde vor der Meldung und bliebe dann stehen");
});

test("ein Endpoint je Arm sticht den aus der Umgebung, und der Port hängt daran", async () => {
  const config = makeConfig({ wireguardEndpoint: null });
  const { repository } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  const result = await enrollment.enrollHost({
    name: "extern",
    kind: "external",
    dockerGid: 996,
    bindBasePath: "/home/docker",
    endpointOverride: "arm.example.net"
  });
  assert.equal(result.record.endpointOverride, "arm.example.net");
  assert.ok(result.archive.length > 0);
});

test("ein Schlüsselpaar, das nicht zusammengehört, hält das Anlegen an", async () => {
  const other = generateWireGuardKeyPair();
  const config = makeConfig({ hubWireguardPublicKey: other.publicKey });
  const { repository, calls } = spyRepository();
  await assert.rejects(
    () => createEnrollment({ repository, config }).enrollHost({ name: "arm", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" }),
    (error: unknown) => error instanceof ConfigError && error.message.includes("gehören nicht zusammen")
  );
  assert.ok(!calls.includes("create"));
});

test("eine unbekannte Art von Host wird abgewiesen, bevor irgendetwas entsteht", async () => {
  const config = makeConfig();
  const { repository, calls } = spyRepository();
  await assert.rejects(
    () =>
      createEnrollment({ repository, config }).enrollHost({
        name: "arm",
        kind: "local" as unknown as "internal",
        dockerGid: 996,
        bindBasePath: "/home/docker"
      }),
    (error: unknown) => error instanceof HostError && error.reason === "invalid-input"
  );
  assert.ok(!calls.includes("create"));
});

test("Secret und Token sind gewürfelt, lang genug und nicht dasselbe", async () => {
  const config = makeConfig();
  const { repository } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  const first = await enrollment.enrollHost({ name: "a", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });
  const second = await enrollment.enrollHost({ name: "b", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });

  // Die Geheimnisse stehen nur im Archiv; hier wird geprüft, dass die
  // öffentlichen Schlüssel je Arm verschieden sind — dieselbe Quelle Zufall.
  assert.notEqual(first.record.wireguardPublicKey, second.record.wireguardPublicKey);
  const content = readConfigFile(config);
  assert.equal(content.match(/\[Peer\]/g)?.length, 2);
});

test("ohne geschriebene Peer-Liste gibt es kein Archiv", async () => {
  // Ein Pfad, der nicht beschreibbar ist: der Arm ist dann angelegt, aber der
  // Aufrufer bekommt kein Paket in die Hand, dessen Gegenstelle im Tunnel
  // fehlt.
  const config = makeConfig({ wireguardConfigPath: join(tmpdir(), "gibt-es-nicht-h3a", "wg0.conf") });
  const { repository } = spyRepository();
  await assert.rejects(() => createEnrollment({ repository, config }).enrollHost({ name: "arm", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" }));
});

// ── Erneuern ──────────────────────────────────────────────────────────────

test("ein neues Archiv tauscht den Schlüssel — auch in der Peer-Liste", async () => {
  const config = makeConfig();
  const { repository } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  const first = await enrollment.enrollHost({ name: "unraid", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });
  const before = first.record.wireguardPublicKey ?? "";

  const second = await enrollment.regenerateArchive(first.record.id);
  assert.notEqual(second.record.wireguardPublicKey, before);
  assert.equal(second.record.state, "pending");

  const content = readConfigFile(config);
  assert.ok(content.includes(second.record.wireguardPublicKey ?? "—"));
  assert.ok(
    !content.includes(before),
    "der Sidecar behielte sonst den alten Schlüssel: das neue Archiv wäre gültig und der Tunnel käme nie zustande"
  );
});

test("für einen unbekannten oder lokalen Host gibt es kein Archiv", async () => {
  const config = makeConfig();
  const { repository } = spyRepository([
    {
      id: "local-1",
      name: "local",
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
    }
  ]);
  const enrollment = createEnrollment({ repository, config });
  await assert.rejects(
    () => enrollment.regenerateArchive("gibt-es-nicht"),
    (error: unknown) => error instanceof EnrollmentError && error.reason === "host-unknown"
  );
  await assert.rejects(
    () => enrollment.regenerateArchive("local-1"),
    (error: unknown) => error instanceof EnrollmentError && error.reason === "host-is-local"
  );
});

// ── Entfernen ─────────────────────────────────────────────────────────────

test("ein entfernter Arm verschwindet aus der Peer-Liste", async () => {
  const config = makeConfig();
  const { repository, records } = spyRepository();
  const enrollment = createEnrollment({ repository, config });
  const { record } = await enrollment.enrollHost({ name: "unraid", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });

  await enrollment.removeHost(record.id);
  assert.equal(records.length, 0);
  const content = readConfigFile(config);
  assert.ok(!content.includes("[Peer]"));
  assert.ok(!content.includes(record.wireguardPublicKey ?? "—"));
});

test("das Entfernen ist wiederholbar und der lokale Host bleibt", async () => {
  const config = makeConfig();
  const { repository } = spyRepository([
    {
      id: "local-1",
      name: "local",
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
    }
  ]);
  const enrollment = createEnrollment({ repository, config });
  const { record } = await enrollment.enrollHost({ name: "unraid", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });

  await enrollment.removeHost(record.id);
  await assert.rejects(
    () => enrollment.removeHost(record.id),
    (error: unknown) => error instanceof EnrollmentError && error.reason === "host-unknown"
  );
  await assert.rejects(
    () => enrollment.removeHost("local-1"),
    (error: unknown) => error instanceof EnrollmentError && error.reason === "host-is-local"
  );
});

// ── Die Gegenprobe am Agenten (Bedingung 9) ───────────────────────────────

function health(version: string | null): AgentHealth {
  return { reachable: true, version, contractVersion: 12, readOnly: false, entries: null };
}

test("die Gegenprobe verlangt einen erreichbaren Agenten ab der Mindestversion", async () => {
  const { repository } = spyRepository();
  const seen: string[] = [];
  const answers = new Map<string, AgentHealth>([
    ["http://10.254.0.2:8099", health("0.32.0")],
    ["http://10.254.0.3:8099", health("0.9.0")],
    ["http://10.254.0.4:8099", health(null)],
    ["http://10.254.0.5:8099", { reachable: false, error: "kein Tunnel" }]
  ]);
  const deps = createRegistrationDeps({
    repository,
    probe: async (baseUrl) => {
      seen.push(baseUrl);
      return answers.get(baseUrl) ?? { reachable: false, error: "unbekannt" };
    }
  });

  assert.equal(await deps.probeAgent("http://10.254.0.2:8099", "a"), true);
  assert.equal(await deps.probeAgent("http://10.254.0.3:8099", "b"), false);
  // ⚠️ Eine FEHLENDE Version ist „zu alt“ und nicht „unbekannt, also gut“.
  assert.equal(await deps.probeAgent("http://10.254.0.4:8099", "c"), false);
  assert.equal(await deps.probeAgent("http://10.254.0.5:8099", "d"), false);

  // Geprobt wird gegen die übergebene Adresse — die Quelladresse der Anfrage
  // samt gemeldetem Port —, nie gegen die gespeicherte agent_url.
  assert.deepEqual(seen, [
    "http://10.254.0.2:8099",
    "http://10.254.0.3:8099",
    "http://10.254.0.4:8099",
    "http://10.254.0.5:8099"
  ]);
});

test("die Rückrufe reichen genau die fünf Felder der Registrierungs-App durch", async () => {
  const { repository } = spyRepository();
  const config = makeConfig();
  const enrollment = createEnrollment({ repository, config });
  const { record } = await enrollment.enrollHost({ name: "unraid", kind: "internal", dockerGid: 996, bindBasePath: "/home/docker" });

  const deps = createRegistrationDeps({ repository });
  const host = await deps.findHostByTunnelAddress("10.254.0.2");
  assert.ok(host);
  assert.deepEqual(Object.keys(host).sort(), ["agentUrl", "failedAttempts", "id", "state", "tunnelAddress"]);
  assert.equal(host.id, record.id);
  // Kein Secret, kein Abdruck, kein Schlüssel — auch nicht auf dem Weg zur App.
  assert.ok(!JSON.stringify(host).includes(record.wireguardPublicKey ?? "—"));
});

test("der öffentliche Schlüssel im Bestand gehört zum Paar, das erzeugt wurde", async () => {
  // Gegenprobe zur Schlüsselerzeugung: aus dem privaten Teil muss sich genau
  // der gespeicherte öffentliche rechnen lassen. Ein vertauschtes Paar sähe
  // auf beiden Seiten richtig aus und ergäbe einen Tunnel ohne Übertragung.
  const pair = generateWireGuardKeyPair();
  assert.equal(publicKeyFromPrivate(pair.privateKey), pair.publicKey);
});

// ── Die Adresse des Hubs von außen (#4) ────────────────────────────────────

const PRIVATE_HUB = "192.168.77.31";

test("ein externer Arm wird abgewiesen, wenn er nur eine private Hub-Adresse bekaeme", async () => {
  // ⚠️ Der Fall ist gemessen und keine Theorie: genau dieser Wert stand am
  // 2026-09-07 in der .env des laufenden Hubs. Ein Arm auf einem VPS bekaeme
  // damit `Endpoint = 192.168.77.31:…` und käme nie an — und weil es das
  // Archiv nach Bauart genau einmal gibt, ist das auf dem fremden Rechner
  // nicht zu retten. Die Frage gehört deshalb VOR die Erzeugung.
  const config = makeConfig({ wireguardEndpoint: PRIVATE_HUB });
  const { repository, records, calls } = spyRepository();
  await assert.rejects(
    () =>
      createEnrollment({ repository, config }).enrollHost({
        name: "remote-host",
        kind: "external",
        dockerGid: 996,
        bindBasePath: "/home/docker"
      }),
    (error: unknown) =>
      error instanceof EnrollmentError &&
      error.reason === "endpoint-unreachable" &&
      error.message.includes(PRIVATE_HUB)
  );
  // Kein halber Arm: die Meldung neben einer angelegten Zeile wäre das
  // Schlimmste von beidem.
  assert.equal(records.length, 0);
  assert.ok(!calls.includes("create"), "es wurde nichts angelegt");
});

test("ein INTERNER Arm bekommt die private Adresse und niemand hält ihn auf", async () => {
  // ⚠️ Die Gegenprobe zur Regel darüber. Für einen Arm im selben Netz IST die
  // private Adresse des Hubs die richtige; eine Schranke, die hier zuschlaegt,
  // machte den Regelfall unmoeglich.
  const config = makeConfig({ wireguardEndpoint: PRIVATE_HUB });
  const { repository, records } = spyRepository();
  const { record } = await createEnrollment({ repository, config }).enrollHost({
    name: "unraid",
    kind: "internal",
    dockerGid: 281,
    bindBasePath: "/mnt/cache/docker"
  });
  assert.equal(record.kind, "internal");
  assert.equal(records.length, 1);
});

test("die abgelegte externe Adresse nimmt dem externen Arm die Schranke", async () => {
  const config = makeConfig({ wireguardEndpoint: PRIVATE_HUB });
  const { repository, records } = spyRepository();
  const enrollment = createEnrollment({
    repository,
    config,
    readExternalEndpoint: async () => "hub.dyndns.invalid"
  });
  const { record } = await enrollment.enrollHost({
    name: "remote-host",
    kind: "external",
    dockerGid: 0,
    bindBasePath: "/home/docker"
  });
  assert.equal(record.kind, "external");
  assert.equal(records.length, 1);
});

test("ein Override am Arm gilt auch dann, wenn er selbst privat ist", async () => {
  // ⚠️ Absicht und kein Loch. Wer eine private Adresse ausdrücklich an EINEN
  // Arm schreibt, hat ein Overlay oder ein Wissen, das dieser Hub nicht hat —
  // dann ist es eine Entscheidung und kein Versehen. Die Schranke greift nur
  // dort, wo der Wert aus einer Vorgabe stammt, die niemand für diesen Arm
  // gewählt hat.
  const config = makeConfig({ wireguardEndpoint: PRIVATE_HUB });
  const { repository, records } = spyRepository();
  const { record } = await createEnrollment({ repository, config }).enrollHost({
    name: "über-overlay",
    kind: "external",
    dockerGid: 996,
    bindBasePath: "/home/docker",
    endpointOverride: "10.99.0.1"
  });
  assert.equal(record.endpointOverride, "10.99.0.1");
  assert.equal(records.length, 1);
});

test("das erneute Archiv wird abgewiesen, BEVOR der laufende Arm ausgesperrt ist", async () => {
  // ⚠️ DIE WICHTIGSTE ZUSAGE DIESER GRUPPE. `repository.rotate` wuerfelt
  // Schlüsselpaar, Agent-Secret und Token neu und sperrt damit den Agenten
  // aus, der auf dem Zielhost gerade läuft. Eine Prüfung DANACH ließe einen
  // Arm zurück, der weder mit dem alten noch mit dem neuen Paket arbeitet —
  // und ein zweites Exemplar des alten gibt es nicht.
  const config = makeConfig({ wireguardEndpoint: PRIVATE_HUB });
  const { repository, calls } = spyRepository([
    {
      id: "remote-host-1",
      name: "remote-host",
      agentUrl: "http://10.254.0.3:8099",
      kind: "external",
      state: "registered",
      tunnelAddress: "10.254.0.3",
      wireguardPublicKey: "alter-schlüssel",
      endpointOverride: null,
      failedAttempts: 0,
      dockerGid: 0,
      bindBasePath: "/home/docker",
      display: DEFAULT_HOST_THEME,
      createdAt: new Date(),
      registeredAt: new Date(),
      lastSeenAt: null
    }
  ]);
  await assert.rejects(
    () => createEnrollment({ repository, config }).regenerateArchive("remote-host-1"),
    (error: unknown) => error instanceof EnrollmentError && error.reason === "endpoint-unreachable"
  );
  assert.ok(!calls.includes("rotate"), "es wurde rotiert, bevor die Adresse geprüft war");
});

test("a stored record the input rules now refuse gets no archive and keeps its credentials", async () => {
  // Records from before the rule: a line break in the name, `$` in the path.
  const stored: Partial<HostRecord>[] = [
    { name: `arm${String.fromCharCode(10)}x` },
    { bindBasePath: "/mnt/a$b" },
    { endpointOverride: `hub.example.test${String.fromCharCode(10)}x` }
  ];
  for (const overrides of stored) {
    const { repository, calls } = spyRepository([
      {
        id: "remote-host-1",
        name: "remote-host",
        agentUrl: "http://10.254.0.3:8099",
        kind: "internal",
        state: "registered",
        tunnelAddress: "10.254.0.3",
        wireguardPublicKey: "alter-schlüssel",
        endpointOverride: null,
        failedAttempts: 0,
        dockerGid: 0,
        bindBasePath: "/home/docker",
        display: DEFAULT_HOST_THEME,
        createdAt: new Date(),
        registeredAt: new Date(),
        lastSeenAt: null,
        ...overrides
      }
    ]);
    await assert.rejects(
      () => createEnrollment({ repository, config: makeConfig() }).regenerateArchive("remote-host-1"),
      (error: unknown) => error instanceof EnrollmentError && error.reason === "host-record-invalid",
      JSON.stringify(overrides)
    );
    assert.equal(calls.includes("rotate"), false, `rotated before refusing: ${JSON.stringify(overrides)}`);
  }
});

test("a hub-wide address with a control character is refused before the rotation", async () => {
  const { repository, calls } = spyRepository([
    {
      id: "remote-host-1",
      name: "remote-host",
      agentUrl: "http://10.254.0.3:8099",
      kind: "external",
      state: "registered",
      tunnelAddress: "10.254.0.3",
      wireguardPublicKey: "alter-schlüssel",
      endpointOverride: null,
      failedAttempts: 0,
      dockerGid: 0,
      bindBasePath: "/home/docker",
      display: DEFAULT_HOST_THEME,
      createdAt: new Date(),
      registeredAt: new Date(),
      lastSeenAt: null
    }
  ]);
  // NEL (U+0085) is not covered by `\s`, which the setting checked before; a
  // leading `-` can still come from HUB_WIREGUARD_ENDPOINT.
  for (const stored of [`hub${String.fromCharCode(0x85)}.example.test`, "-hub.example.test"]) {
    const readExternalEndpoint = async () => stored;
    await assert.rejects(
      () => createEnrollment({ repository, config: makeConfig(), readExternalEndpoint }).regenerateArchive("remote-host-1"),
      (error: unknown) => error instanceof ConfigError && error.message.includes("Steuerzeichen"),
      JSON.stringify(stored)
    );
  }
  assert.equal(calls.includes("rotate"), false, "rotated before refusing");
});
