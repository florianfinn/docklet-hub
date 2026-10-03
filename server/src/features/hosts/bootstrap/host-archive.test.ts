import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { ARCHIVE_FILE_NAMES, buildHostArchive, type HostArchiveInput } from "./host-archive.js";
import { renderEnvFile } from "./host-archive-env.js";
import { DEFAULT_BIND_BASE_PATH } from "./host-archive-input.js";
import { renderTunnelConfig } from "./host-archive-wireguard.js";
import { generateWireGuardKeyPair } from "./wireguard-keys.js";

// Geprüft wird das ENTPACKTE Archiv, nicht die Vorlagen.
//
// Der Unterschied ist der Punkt: Dateimodi, Zeilenenden und die Frage, ob der
// tar-Kopf überhaupt lesbar ist, existieren nur im fertigen Strom. Ein Test
// gegen `renderComposeFile` wäre grün, während `tar -xzf` auf dem Zielhost
// abbricht.
//
// `tar` ist auf Windows 10+ und in Git Bash vorhanden, auf Linux ohnehin.

const HUB_PUBLIC_KEY = generateWireGuardKeyPair().publicKey;
const ARM = generateWireGuardKeyPair();

const SECRET = "a".repeat(48);
const TOKEN = "b".repeat(43);
const HOST_ID = "11111111-2222-3333-4444-555555555555";

function makeInput(): HostArchiveInput {
  return {
    host: {
      id: HOST_ID,
      name: "remote-host",
      kind: "external",
      tunnelAddress: "10.254.0.2",
      // Absichtlich NICHT die Vorgabe: ein Fall, in dem die Eingabe nur
      // durchgereicht wird, sagt nichts, solange sie zufällig gleich der
      // Vorgabe ist. 281 ist die Gruppe des Sockets auf dem unraid, an dem #4
      // gemessen wurde, und der Pfad ist der dortige Ablageort.
      dockerGid: 281,
      bindBasePath: "/mnt/user/appdata"
    },
    hub: {
      endpoint: "hub.example.test:51821",
      publicKey: HUB_PUBLIC_KEY,
      tunnelCidr: "10.254.0.0/24",
      hubAddress: "10.254.0.1"
    },
    // Bewusst KEINE ghcr.io-Referenz: so bleibt der Griff nach „ghcr.io" unten
    // eine Aussage über die Vorlagen und nicht über die Eingabe.
    agent: {
      image: "registry.example.test/docklet-hub-agent:v0.32.0@sha256:" + "c".repeat(64),
      port: 8099,
      secret: SECRET,
      privateKey: ARM.privateKey
    },
    registration: { url: `http://10.254.0.1:8080/api/hosts/${HOST_ID}/register`, token: TOKEN }
  };
}

type Unpacked = { directory: string; files: string[]; read: (name: string) => string };

const directories: string[] = [];

async function unpack(input: HostArchiveInput): Promise<Unpacked> {
  const archive = await buildHostArchive(input);
  // Der gzip-Kopf, direkt geprüft: eine Fassung, die versehentlich den rohen
  // tar-Strom zurückgibt, fiele sonst erst am Content-Type der Route auf.
  assert.equal(archive.subarray(0, 3).toString("hex"), "1f8b08");
  const directory = mkdtempSync(join(tmpdir(), "host-archive-"));
  directories.push(directory);
  writeFileSync(join(directory, "archive.tar.gz"), archive);
  // ⚠️ Relativer Name und `cwd`, kein absoluter Pfad: das `tar` aus Git Bash
  // liest „C:\…" als Angabe eines entfernten Rechners und meldet „Cannot
  // connect to C:". Mit `cwd` läuft derselbe Aufruf unter GNU tar wie unter
  // dem bsdtar von Windows.
  execFileSync("tar", ["-xzf", "archive.tar.gz"], { cwd: directory, stdio: "pipe" });
  rmSync(join(directory, "archive.tar.gz"));
  return {
    directory,
    files: readdirSync(directory).sort(),
    read: (name) => readFileSync(join(directory, name), "utf8")
  };
}

// Ein `tar`-Aufruf kostet auf einem Windows-Rechner ein Vielfaches dessen, was
// dieser ganze Testlauf sonst braucht. Das Archiv der Regeleingabe wird
// deshalb EINMAL entpackt und von allen Fällen gelesen, die nur lesen.
let shared: Promise<Unpacked> | null = null;
function unpackOnce(): Promise<Unpacked> {
  shared ??= unpack(makeInput());
  return shared;
}

after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

// Der Kopf einer ustar-Datei trägt den Modus als Oktalzahl an Byte 100. Er
// wird direkt aus dem Strom gelesen, weil das Dateisystem beim Entpacken
// dazwischensteht: unter Windows kommt jede Datei als 0666 heraus, egal was im
// Archiv stand — die Zusage „0600" wäre dort also ungeprüft.
function tarHeaders(raw: Buffer): Map<string, number> {
  const modes = new Map<string, number>();
  const field = (offset: number, length: number): string =>
    raw
      .subarray(offset, offset + length)
      .toString("ascii")
      .replace(/\0.*$/s, "")
      .trim();
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const name = field(offset, 100);
    if (name === "") break;
    modes.set(name, parseInt(field(offset + 100, 8), 8));
    offset += 512 + Math.ceil(parseInt(field(offset + 124, 12), 8) / 512) * 512;
  }
  return modes;
}

// Eine `docker-compose.yml` ohne YAML-Bibliothek: der Server-Workspace hat
// keine (`yaml` hängt an `web`), und eine Abhängigkeit für vier erzeugte
// Dateien wäre nicht zu rechtfertigen. Zerlegt wird nach Einrückung — genau
// die Struktur, die diese Vorlage erzeugt.
function serviceBlocks(compose: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] | null = null;
  let inServices = false;
  for (const line of compose.split("\n")) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:");
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (service) {
      current = [];
      blocks.set(service[1], current);
      continue;
    }
    if (current && /^ {4}\S/.test(line)) current.push(line.trim());
  }
  return blocks;
}

// Der `environment`-Block eines Dienstes als Zuordnung. `serviceBlocks` sieht
// nur die Ebene darunter (vier Leerzeichen); die Werte hier stehen eine Stufe
// tiefer und brauchen deshalb einen eigenen Griff.
function serviceEnvironment(compose: string, service: string): Map<string, string> {
  const values = new Map<string, string>();
  let inService = false;
  let inEnvironment = false;
  for (const line of compose.split("\n")) {
    if (/^ {2}\S/.test(line)) {
      inService = line.startsWith(`  ${service}:`);
      inEnvironment = false;
      continue;
    }
    if (!inService) continue;
    if (/^ {4}\S/.test(line)) {
      inEnvironment = line.trim() === "environment:";
      continue;
    }
    const entry = /^ {6}([A-Z_][A-Z0-9_]*): (.*)$/.exec(line);
    if (inEnvironment && entry) values.set(entry[1], entry[2].replace(/^"(.*)"$/, "$1"));
  }
  return values;
}

// Ein Zeichen, das in einer Base64-Zeichenkette vorkommt und in einem regulären
// Ausdruck etwas bedeutet, gehört maskiert — sonst wird jeder zwanzigste Lauf
// grün, ohne dass er etwas geprüft hat.
function quoted(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

test("das Archiv enthält genau die vier zugesagten Dateien", async () => {
  const unpacked = await unpackOnce();
  assert.deepEqual(unpacked.files, [...ARCHIVE_FILE_NAMES].sort());
  assert.equal(unpacked.files.length, 4);
});

test("jede Datei endet mit LF und trägt kein CR", async () => {
  // Die stille Falle: ein Template-Literal in einer CRLF-Datei nähme deren
  // Zeilenenden mit. `wg-quick` und der .env-Leser von Compose stolpern
  // darüber, und zwar erst auf dem Zielhost.
  const unpacked = await unpackOnce();
  for (const name of unpacked.files) {
    const content = unpacked.read(name);
    assert.equal(content.includes("\r"), false, `${name} trägt ein CR`);
    assert.match(content, /\n$/, `${name} endet ohne Zeilenumbruch`);
  }
});

test("die Modi im tar-Kopf sind 0600 für die Geheimnisse und 0644 für den Rest", async () => {
  const modes = tarHeaders(gunzipSync(await buildHostArchive(makeInput())));
  assert.deepEqual(Object.fromEntries([...modes].map(([name, mode]) => [name, mode.toString(8)])), {
    "docker-compose.yml": "644",
    ".env": "600",
    "wg0.conf": "600",
    "README.md": "644"
  });
});

test("die Compose-Datei trägt die drei Dienste in lesbarer Form", async () => {
  const unpacked = await unpackOnce();
  const compose = unpacked.read("docker-compose.yml");
  const services = serviceBlocks(compose);
  assert.deepEqual([...services.keys()].sort(), ["docker-agent", "watcher", "wireguard"]);
  // Kein Tabulator, keine ungerade Einrückung: beides macht YAML unlesbar,
  // ohne dass es beim Schreiben auffällt.
  for (const line of compose.split("\n")) {
    assert.equal(line.includes("\t"), false, `Tabulator in: ${line}`);
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    assert.equal(indent % 2, 0, `ungerade Einrückung in: ${line}`);
  }
});

test("der Agent hängt im Netz-Namespace des Sidecars, NET_ADMIN trägt nur der Sidecar", async () => {
  const unpacked = await unpackOnce();
  const services = serviceBlocks(unpacked.read("docker-compose.yml"));
  assert.ok(services.get("docker-agent")?.includes(`network_mode: "service:wireguard"`));
  const withNetAdmin = [...services].filter(([, block]) => block.some((line) => line.includes("NET_ADMIN")));
  assert.deepEqual(
    withNetAdmin.map(([name]) => name),
    ["wireguard"]
  );
  // Die Gegenprobe zur Zusage: die beiden anderen werfen alles weg.
  for (const name of ["docker-agent", "watcher"]) {
    assert.ok(services.get(name)?.includes("cap_drop: [ALL]"), `${name} ohne cap_drop`);
  }
});

test("der Agent ist im Archiv an den Tunnel gebunden", async () => {
  // ⚠️ Diese beiden Zeilen im Compose sind die ganze Tunnelbindung, und ihr
  // Wegfall ist still: der Agent startet dann anstandslos, lauscht aber auf
  // allen Adressen seines Namespaces statt nur auf der Tunneladresse — und die
  // Anmelde-URL wird gegen das Netz des Quellsystems geprüft. Kein anderer Fall
  // in dieser Datei fiele dadurch um.
  const input = makeInput();
  const unpacked = await unpackOnce();
  const environment = serviceEnvironment(unpacked.read("docker-compose.yml"), "docker-agent");
  assert.equal(environment.get("DOCKER_AGENT_REQUIRE_TUNNEL_BIND"), "true");
  // Der Wert kommt aus der Eingabe und ist nicht die Vorgabe des Agenten:
  // steht hier ein `:-`-Rückfall, ist es 10.253.0.0/24 und damit falsch.
  assert.equal(
    environment.get("DOCKER_AGENT_TUNNEL_CIDR"),
    `\${DOCKER_AGENT_TUNNEL_CIDR:?DOCKER_AGENT_TUNNEL_CIDR is missing}`
  );
  assert.equal(environment.get("DOCKER_AGENT_HOST"), "${DOCKER_AGENT_HOST:?DOCKER_AGENT_HOST is missing}");
  // Und die Gegenprobe am anderen Ende der Kette: was Compose dort einsetzt,
  // steht in der .env und ist das Netz DIESES Hubs.
  assert.ok(unpacked.read(".env").includes(`DOCKER_AGENT_TUNNEL_CIDR=${input.hub.tunnelCidr}`));
});

test("jedes Image ist gepinnt und einzeln übersteuerbar", async () => {
  const unpacked = await unpackOnce();
  const compose = unpacked.read("docker-compose.yml");
  const images = [...serviceBlocks(compose)].map(
    ([name, block]) => [name, block.find((line) => line.startsWith("image: "))] as const
  );
  for (const [name, image] of images) {
    assert.ok(image?.startsWith("image: ${DOCKER_AGENT_"), `${name}: ${image}`);
  }
  // Drei Dienste, drei eigene Variablen — der Rückweg auf eine ältere Fassung
  // ist damit je Dienst eine Zeile in der .env.
  assert.equal(new Set(images.map(([, image]) => image)).size, 3);
  assert.equal(compose.includes(":latest"), false);
  assert.match(unpacked.read(".env"), /^DOCKER_AGENT_IMAGE=\S+@sha256:[0-9a-f]{64}$/m);
});

test("die .env trägt jeden Schlüssel, den der Agent beim Start verlangt", async () => {
  const input = makeInput();
  const unpacked = await unpack(input);
  const values = new Map(
    unpacked
      .read(".env")
      .split("\n")
      .filter((line) => /^[A-Z]/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
  assert.deepEqual(
    [...values.keys()].sort(),
    [
      "DOCKER_AGENT_BIND_BASE_PATH",
      "DOCKER_AGENT_HOST",
      "DOCKER_AGENT_IMAGE",
      "DOCKER_AGENT_REGISTRATION_TOKEN",
      "DOCKER_AGENT_REGISTRATION_URL",
      "DOCKER_AGENT_SECRET",
      "DOCKER_AGENT_TUNNEL_CIDR",
      "DOCKER_GID"
    ]
  );
  // ⚠️ Der stille Fall: fehlt diese eine Zeile, nimmt der Agent 10.253.0.0/24
  // an und weist die Anmelde-URL beim Start ab. Kein Compose-Test sieht das.
  assert.equal(values.get("DOCKER_AGENT_TUNNEL_CIDR"), "10.254.0.0/24");
  assert.equal(values.get("DOCKER_AGENT_HOST"), "10.254.0.2");
  assert.equal(values.get("DOCKER_AGENT_SECRET"), SECRET);
  assert.equal(values.get("DOCKER_AGENT_REGISTRATION_TOKEN"), TOKEN);
  assert.equal(values.get("DOCKER_AGENT_REGISTRATION_URL"), input.registration.url);
  // Beide Werte kommen aus der EINGABE und nicht aus einer Vorgabe im Code
  // (008-host-setup.sql). Deshalb tragen sie hier andere Zahlen als die
  // Vorgabe: ein durchgereichter Wert, der zufällig gleich der Vorgabe ist,
  // beweist nichts.
  assert.equal(values.get("DOCKER_AGENT_BIND_BASE_PATH"), "/mnt/user/appdata");
  assert.equal(values.get("DOCKER_GID"), "281");
});

test("die README nennt bei abgelehnten Bind-Mounts denselben Pfad wie die .env", async () => {
  // #153: die README griff hier zur Vorgabe `DEFAULT_BIND_BASE_PATH` statt zum
  // Wert aus der Eingabe — mit `bindBasePath: "/mnt/user/appdata"` (makeInput,
  // absichtlich NICHT die Vorgabe) trug die .env diesen Pfad und die README
  // daneben `/home/docker`. Ein Fall mit der Vorgabe selbst bliebe grün, auch
  // wenn die README wieder die Konstante einsetzt statt der Eingabe.
  const input = makeInput();
  const unpacked = await unpack(input);
  assert.notEqual(input.host.bindBasePath, DEFAULT_BIND_BASE_PATH);
  const env = unpacked.read(".env");
  const readme = unpacked.read("README.md");
  const match = /^DOCKER_AGENT_BIND_BASE_PATH=(.+)$/m.exec(env);
  assert.ok(match, "die .env nennt keinen Bind-Base-Path");
  assert.equal(match[1], input.host.bindBasePath);
  assert.ok(readme.includes(`\`${input.host.bindBasePath}\` only`), "die README nennt einen anderen Pfad als die .env");
});

test("kennt der Hub die Gruppen-ID, prüft die README sie nur noch nach", async () => {
  // Seit 008 fragt der Hub beide Werte beim Anlegen ab. Der Handgriff aus
  // Schritt 2 entfällt damit — aber NICHT die Gegenprobe: was in der `.env`
  // steht, hat jemand vor Tagen in ein Formular geschrieben, und der Socket
  // auf dem Zielhost gehört, wem er gehört.
  const unpacked = await unpackOnce();
  const readme = unpacked.read("README.md");
  assert.match(readme, /Check the group id of the Docker socket/);
  assert.match(readme, /DOCKER_GID=281/);
  assert.ok(readme.includes("stat -c %g /var/run/docker.sock"), "die Gegenprobe fehlt");
  // ⚠️ Gegen den KOPF des Schritts und nicht gegen einen Satz aus seinem Rumpf.
  // Hier stand eine Verneinung über eine Zeichenkette, die im gerenderten Text
  // über einen Zeilenumbruch lief und deshalb in KEINER der beiden Fassungen
  // vorkam — die Zusicherung war immer wahr und hätte den Fall nie angehalten.
  // Vorbestehend seit dem deutschen Text, gefunden von der unabhängigen
  // Prüfung zu #92.
  assert.ok(!readme.includes("Enter the group id of the Docker socket"), "die README verlangt den Handgriff noch");
});

test("kennt der Hub sie nicht, bleibt der Handgriff — und die Zeile bleibt leer", async () => {
  // ⚠️ Der Fall ist keine Theorie: ein Arm, der vor 008 angelegt wurde, hat
  // beide Werte nicht, und `GET /hosts/:id/archive` erzeugt sein Paket neu.
  // Ein Vorgabewert an dieser Stelle wäre eine geratene Gruppen-ID — und ein
  // Agent, der startet und den Socket nicht lesen darf.
  const input = makeInput();
  const unpacked = await unpack({
    ...input,
    host: { ...input.host, dockerGid: null, bindBasePath: null }
  });
  const readme = unpacked.read("README.md");
  assert.match(readme, /Enter the group id of the Docker socket/);
  assert.ok(!readme.includes("Check the group id"), "die README behauptet, der Wert stünde schon da");

  const env = unpacked.read(".env");
  assert.match(env, /^DOCKER_GID=$/m);
  // Ohne Angabe gilt die Vorgabe des Agenten, und zwar sichtbar ausgeschrieben.
  assert.match(env, /^DOCKER_AGENT_BIND_BASE_PATH=\/home\/docker$/m);
});

test("die Gruppen-ID 0 steht als 0 in der .env und nicht als leere Zeile", async () => {
  // ⚠️ Der stille Fall dieser Änderung: `input.host.dockerGid || ""` sähe
  // richtig aus und schriebe für den Host, dessen Socket root gehört, genau
  // die leere Zeile, die der Betreiber vermeiden wollte.
  const input = makeInput();
  const unpacked = await unpack({ ...input, host: { ...input.host, dockerGid: 0 } });
  assert.match(unpacked.read(".env"), /^DOCKER_GID=0$/m);
  assert.match(unpacked.read("README.md"), /DOCKER_GID=0/);
});

test("wg0.conf beschreibt genau die Beziehung zum Hub", async () => {
  const unpacked = await unpackOnce();
  const config = unpacked.read("wg0.conf");
  assert.match(config, /^\[Interface\]$/m);
  assert.match(config, new RegExp(`^PrivateKey = ${quoted(ARM.privateKey)}$`, "m"));
  assert.match(config, /^Address = 10\.254\.0\.2\/24$/m);
  assert.match(config, /^\[Peer\]$/m);
  assert.match(config, new RegExp(`^PublicKey = ${quoted(HUB_PUBLIC_KEY)}$`, "m"));
  assert.match(config, /^Endpoint = hub\.example\.test:51821$/m);
  // /32 und nicht /24: dieser Arm spricht mit dem Hub und keinem anderen Arm.
  assert.match(config, /^AllowedIPs = 10\.254\.0\.1\/32$/m);
  assert.match(config, /^PersistentKeepalive = 25$/m);
});

test("der private Schlüssel steht an genau einer Stelle im Archiv", async () => {
  const input = makeInput();
  const unpacked = await unpack(input);
  const count = (needle: string): number =>
    unpacked.files.reduce((total, name) => total + unpacked.read(name).split(needle).length - 1, 0);
  assert.equal(count(input.agent.privateKey), 1);
  // Der öffentliche Schlüssel des Hubs ebenso: er gehört in den [Peer]-Block
  // und nicht zusätzlich in die .env.
  assert.equal(count(HUB_PUBLIC_KEY), 1);
});

test("keine Datei setzt eine Registry-Anmeldung voraus", async () => {
  // Das Beispiel-Compose des Agenten trägt einen langen Block für private
  // Registries. Er fällt vollständig weg — nicht auskommentiert: ein
  // auskommentierter Block wird beim nächsten Fehlerfall wieder eingeschaltet.
  const unpacked = await unpackOnce();
  const hits = unpacked.files.flatMap((name) =>
    unpacked
      .read(name)
      .split("\n")
      .filter((line) => /ghcr\.io|docker login|DOCKER_CONFIG|DOCKERCFG/.test(line))
      .map((line) => `${name}: ${line}`)
  );
  assert.deepEqual(hits, []);
});

test("eine echte ghcr.io-Referenz steht nur als Image und zieht keine Anmeldung nach sich", async () => {
  // Die Gegenprobe zum Test darüber: im Betrieb IST das Image eine
  // ghcr.io-Referenz. Verboten bleibt dann alles außer dem Verweis selbst.
  const image = `ghcr.io/florianfinn/docklet-hub-agent:v0.32.0@sha256:${"d".repeat(64)}`;
  const input = makeInput();
  const unpacked = await unpack({ ...input, agent: { ...input.agent, image } });
  const hits = unpacked.files.flatMap((name) =>
    unpacked
      .read(name)
      .split("\n")
      .filter((line) => /ghcr\.io|docker login|DOCKER_CONFIG|DOCKERCFG/.test(line))
      .map((line) => `${name}: ${line.trim()}`)
  );
  assert.deepEqual(hits, [`.env: DOCKER_AGENT_IMAGE=${image}`]);
});

test("ein Image mit SemVer-Tag ohne Digest ergibt ein Archiv (#279)", async () => {
  // Until the first release run there is no digest for the new image name, so
  // the hub pins its arms to the tag alone (`ARM_AGENT_IMAGE`).
  const image = "ghcr.io/florianfinn/docklet-hub-agent:v0.32.0";
  const input = makeInput();
  const unpacked = await unpack({ ...input, agent: { ...input.agent, image } });
  assert.match(unpacked.read(".env"), new RegExp(`^DOCKER_AGENT_IMAGE=${image}$`, "m"));
  assert.equal(unpacked.read("docker-compose.yml").includes(":latest"), false);
});

test("die README nennt die Handgriffe auf dem Zielhost", async () => {
  const unpacked = await unpackOnce();
  const readme = unpacked.read("README.md");
  for (const step of ["mkdir -p", "tar -xzf", "chmod 600 .env wg0.conf", "docker compose up -d", "docker compose ps"]) {
    assert.ok(readme.includes(step), `fehlt in der README: ${step}`);
  }
  // Der Nachweis der Anmeldung und der Weg zurück.
  assert.ok(readme.includes("registered"));
  assert.ok(readme.includes("given-up"));
});

test("die README beschreibt den Umstieg eines älteren Arms auf diesen Agenten (R38)", async () => {
  const input = makeInput();
  const unpacked = await unpack(input);
  const readme = unpacked.read("README.md");
  const section = readme.slice(readme.indexOf("## Moving an older installation to this agent"));
  assert.ok(section.length < readme.length, "der Abschnitt fehlt");
  // Der Ref steht nur in der .env (der Test mit der ghcr.io-Referenz oben): die
  // README verweist auf diese Zeile, statt sie ein zweites Mal zu tragen.
  assert.ok(section.includes("grep '^DOCKER_AGENT_IMAGE=' .env"), "der Verweis auf die Image-Zeile der .env fehlt");
  assert.ok(section.includes("`DOCKER_AGENT_IMAGE=` line"), "die Zeile, die zu ersetzen ist, fehlt");
  assert.ok(section.includes("sudo docker compose up -d"), "der Neustart fehlt");
  assert.ok(section.indexOf("grep '^DOCKER_AGENT_IMAGE=' .env") < section.indexOf("docker compose up -d"), "erst die Zeile, dann der Neustart");
  assert.ok(!section.includes(input.agent.image), "die README trägt den Ref ein zweites Mal");
  // Eine Aussage über die Oberfläche des Hubs altert auf dem fremden Host.
  assert.ok(!/outdated|dashboard shows|turns (green|red)/i.test(section), "die README spricht über die Anzeige des Hubs");
});

test("die README verlangt einen Ablageort, der einen Neustart überlebt", async () => {
  // ⚠️ Der Vorschlag `/opt` setzt eine dauerhafte Wurzel voraus. Gemessen am
  // 2026-09-06 auf einem unraid: `findmnt -no FSTYPE,SOURCE /` meldet dort
  // `rootfs rootfs` — die Wurzel liegt im RAM. Ein Arm unter /opt wäre nach
  // dem nächsten Neustart weg, samt privatem Schlüssel, und der Hub kann
  // dasselbe Archiv nicht noch einmal ausliefern.
  const unpacked = await unpackOnce();
  const readme = unpacked.read("README.md");
  assert.ok(readme.includes("survive a restart"), "die README nennt die Anforderung nicht");
  assert.ok(readme.includes("findmnt -no FSTYPE,SOURCE /"), "die README nennt die Gegenprobe nicht");
  // ⚠️ Die Reihenfolge ist die Aussage: eine Gegenprobe NACH dem Entpacken
  // beantwortet die Frage zu spät — die Geheimnisse liegen dann schon dort.
  assert.ok(
    readme.indexOf("findmnt -no FSTYPE,SOURCE /") < readme.indexOf("tar -xzf"),
    "die Gegenprobe steht hinter dem Entpacken"
  );
});

test("kennt der Hub das Arbeitsverzeichnis, schlägt die README es als Ablageort vor", async () => {
  // Der Vorschlag `/opt` stammt aus der Zeit, in der der Hub über den Zielhost
  // keinen einzigen Pfad wusste. Seit #89 nennt der Betreiber beim Anlegen den
  // Ort seiner Compose-Projekte — der Arm gehört dorthin und nicht in ein
  // Verzeichnis, das auf diesem Host vielleicht gar nicht vorgesehen ist.
  const unpacked = await unpackOnce();
  const readme = unpacked.read("README.md");
  assert.ok(
    readme.includes("sudo mkdir -p /mnt/user/appdata/dashboard-docker-agent"),
    "die README legt den Arm nicht unter dem genannten Arbeitsverzeichnis an"
  );
  assert.ok(!readme.includes("/opt/dashboard-docker-agent"), "die README schlägt weiterhin /opt vor");
});

test("auch mit bekanntem Pfad bleibt die Gegenprobe auf Dauerhaftigkeit stehen", async () => {
  // ⚠️ DIESER FALL IST DIE KORREKTUR AN EINEM EIGENEN FEHLGRIFF. Der erste
  // Entwurf des Vorschlags oben ließ die `findmnt`-Gegenprobe weg, sobald der
  // Hub einen Pfad kennt — mit der Begründung, der Betreiber habe damit ja
  // bereits einen dauerhaften Ort benannt.
  //
  // Das ist eine Zusage über einen FREMDEN Host, die dieser Hub nicht halten
  // kann: gefragt wird nach dem Ort der Compose-Projekte und nicht nach einem
  // Datenträger, und nichts hindert jemanden daran, dort einen Pfad unterhalb
  // einer Wurzel im RAM einzutragen. Der bekannte Pfad macht den VORSCHLAG
  // besser; die Prüfung macht er nicht überflüssig.
  const input = makeInput();
  const unpacked = await unpack({
    ...input,
    // Genau der Fall, den der Fehlgriff durchgelassen hätte: ein genannter
    // Pfad, der auf einem unraid trotzdem im RAM liegt.
    host: { ...input.host, bindBasePath: "/opt/docker" }
  });
  const readme = unpacked.read("README.md");
  assert.ok(readme.includes("sudo mkdir -p /opt/docker/dashboard-docker-agent"), "der Pfad wird übernommen");
  assert.ok(readme.includes("findmnt -no FSTYPE,SOURCE /"), "die Gegenprobe fehlt beim bekannten Pfad");
  assert.ok(
    readme.indexOf("findmnt -no FSTYPE,SOURCE /") < readme.indexOf("tar -xzf"),
    "die Gegenprobe steht hinter dem Entpacken"
  );
});

test("kennt der Hub ihn nicht, bleibt /opt der Vorschlag", async () => {
  const input = makeInput();
  const unpacked = await unpack({ ...input, host: { ...input.host, bindBasePath: null } });
  const readme = unpacked.read("README.md");
  assert.ok(readme.includes("sudo mkdir -p /opt/dashboard-docker-agent"), "der Rückfall auf /opt fehlt");
  assert.ok(readme.includes("findmnt -no FSTYPE,SOURCE /"), "die Gegenprobe fehlt");
});

test("die Docker-GID wird am Socket abgelesen und nicht über den Gruppennamen erfragt", async () => {
  // ⚠️ Der Unterschied ist kein Geschmack, sondern ein Host, auf dem es die
  // Gruppe `docker` nicht gibt: dort liefert `getent group docker` nichts,
  // `DOCKER_GID=` bliebe leer, und der Stack hielte beim Start an. Der Hub
  // liest für sich selbst längst den Socket (scripts/bootstrap.sh, „abgelesen,
  // nicht geraten") — das Paket, das ein Fremder auspackt, tat es nicht.
  //
  // Geprüft werden BEIDE Stellen, an denen die Anweisung steht: die README und
  // der Kommentar über der Zeile in der .env. Eine allein zurückzudrehen wäre
  // sonst still möglich.
  //
  // Getroffen wird die ANWEISUNG, nicht die Erwähnung: beide Dateien nennen
  // `getent` weiterhin, um zu sagen, warum es hier nicht taugt. Rot wird der
  // Fall an der Vorschrift — dem Rezept und jeder Zuweisung an DOCKER_GID.
  const unpacked = await unpackOnce();
  for (const name of ["README.md", ".env"]) {
    const text = unpacked.read(name);
    assert.ok(text.includes("stat -c %g /var/run/docker.sock"), `nennt den Socket nicht: ${name}`);
    assert.ok(!text.includes("getent group docker | cut"), `trägt wieder das alte Rezept: ${name}`);
    const setters = text.split("\n").filter((line) => line.includes("DOCKER_GID=$("));
    for (const line of setters) {
      assert.match(line, /stat -c %g \/var\/run\/docker\.sock/, `füllt DOCKER_GID anders: ${name}`);
    }
  }
});

test("ein zu kurzes Geheimnis ergibt kein Archiv, sondern einen Fehler", async () => {
  // Der Agent lehnt beides beim Start ab. Ein Archiv, das sich bauen lässt und
  // auf dem Zielhost nicht startet, fällt jemandem auf, der diesen Code nicht
  // hat — deshalb hier und nicht dort.
  const input = makeInput();
  await assert.rejects(
    () => buildHostArchive({ ...input, agent: { ...input.agent, secret: "x".repeat(31) } }),
    /DOCKER_AGENT_SECRET hat 31/
  );
  await assert.rejects(
    () => buildHostArchive({ ...input, registration: { ...input.registration, token: "x".repeat(31) } }),
    /REGISTRATION_TOKEN hat 31/
  );
});

test("eine Anmelde-URL, die der Agent ablehnen würde, ergibt kein Archiv", async () => {
  const input = makeInput();
  await assert.rejects(
    () => buildHostArchive({ ...input, registration: { ...input.registration, url: "https://10.254.0.1:8080/x" } }),
    /muss http sein/
  );
  await assert.rejects(
    () => buildHostArchive({ ...input, registration: { ...input.registration, url: "http://10.253.0.1:8080/x" } }),
    /nicht in 10\.254\.0\.0\/24/
  );
  await assert.rejects(
    () => buildHostArchive({ ...input, registration: { ...input.registration, url: "hub/register" } }),
    /keine URL/
  );
});

test("Adressen außerhalb des Tunnelnetzes ergeben kein Archiv", async () => {
  const input = makeInput();
  await assert.rejects(
    () => buildHostArchive({ ...input, host: { ...input.host, tunnelAddress: "192.168.1.5" } }),
    /liegt nicht in 10\.254\.0\.0\/24/
  );
  await assert.rejects(
    () => buildHostArchive({ ...input, hub: { ...input.hub, hubAddress: "10.254.0.2" } }),
    /dieselbe Tunneladresse/
  );
});

test("ein ungepinntes Image und ein Endpoint ohne Port ergeben kein Archiv", async () => {
  const input = makeInput();
  await assert.rejects(
    () => buildHostArchive({ ...input, agent: { ...input.agent, image: "docklet-hub-agent:latest" } }),
    /:latest/
  );
  await assert.rejects(
    () => buildHostArchive({ ...input, agent: { ...input.agent, image: "docklet-hub-agent" } }),
    /nicht gepinnt/
  );
  await assert.rejects(
    () => buildHostArchive({ ...input, hub: { ...input.hub, endpoint: "hub.example.test" } }),
    /keinen Port/
  );
});

test("zwei gleichzeitige Läufe kommen sich nicht ins Gehege", async () => {
  // Der Erzeuger hält keinen Zustand und schreibt nichts ins Dateisystem: zwei
  // Downloads zur selben Zeit dürfen sich nicht beeinflussen. Verglichen werden
  // die Inhalte und nicht die Bytes — im tar-Kopf steht die Uhrzeit.
  const input = makeInput();
  const [first, second] = await Promise.all([unpack(input), unpack(input)]);
  for (const name of first.files) {
    assert.equal(first.read(name), second.read(name), name);
  }
});

// The fixed synthetic input pins the public project identity and generic host.
// Changed by the public restart; later archive changes require a new baseline
// with an explicit reason. The rendered host comment changes with the synthetic host name.
test("wg0.conf und .env entsprechen der öffentlichen Installationsgrundlage", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const input: HostArchiveInput = {
    host: { id, name: "remote-host", kind: "external", tunnelAddress: "10.254.0.2", dockerGid: 281, bindBasePath: "/mnt/user/appdata" },
    hub: { endpoint: "hub.example.test:51821", publicKey: "H".repeat(43) + "=", tunnelCidr: "10.254.0.0/24", hubAddress: "10.254.0.1" },
    agent: {
      image: "registry.example.test/docklet-hub-agent:v0.32.0@sha256:" + "c".repeat(64),
      port: 8099,
      secret: "a".repeat(48),
      privateKey: "P".repeat(43) + "="
    },
    registration: { url: `http://10.254.0.1:8080/api/hosts/${id}/register`, token: "b".repeat(43) }
  };
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(sha256(renderEnvFile(input)), "df3139b6db32de7982ab8daf24dc43c051a25752da2139e12e4d9833aebb808c");
  assert.equal(sha256(renderTunnelConfig(input)), "8f015a4ad368e3861836c8a5196b68a3606abd2a04b2ab91aa47cd07d5e4194c");
});
