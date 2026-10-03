import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Wächter über den deploybaren Stack.
//
// Warum es ihn gibt: die Zusagen dieser Datei — gepinnte Images, kein
// veröffentlichter Agent-Port, der Hub ohne docker.sock, ein eigener
// Projektname neben einem fremden Agenten — sind Eigenschaften, die man einer
// Compose-Datei nicht ansieht, wenn man sie ändert. Sie fallen erst im Betrieb
// auf, und dort heißen sie „offener Port" und „Hub mit Root-Zugriff auf den
// Host".
//
// ⚠️ Dieser Wächter prüft die DATEI, nicht den laufenden Stack. Dass vier
// Dienste tatsächlich hochkommen, lässt sich hier nicht zeigen: es gibt keine
// CI, und eine Prüfung, die ein laufendes Docker verlangt, übersprünge sich auf
// einer frischen Arbeitskopie still (AGENTS.md, „Tests"). Der Nachweis am
// laufenden Stack gehört zum Deploy und damit zum Betreiber.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const compose = parse(readFileSync(new URL("docker-compose.yml", `file://${ROOT}`), "utf8"));
const template = readFileSync(new URL(".env.example", `file://${ROOT}`), "utf8");

const HUB = "hub";
const POSTGRES = "postgres";
const AGENT = "docker-agent";
const WIREGUARD = "wireguard";

test("der Stack besteht aus genau den vier zugesagten Diensten", () => {
  assert.deepEqual(Object.keys(compose.services).sort(), [AGENT, HUB, POSTGRES, WIREGUARD]);
});

test("das Compose-Projekt trägt einen eigenen, übersteuerbaren Namen", () => {
  // Ohne ihn heißt das Projekt nach dem Verzeichnis. Auf einem Host, auf dem
  // bereits ein Agent des Hauptdashboards läuft, entscheidet genau dieser Name
  // darüber, ob beide getrennte Container und getrennte Volumes bekommen.
  assert.match(String(compose.name), /^\$\{COMPOSE_PROJECT_NAME:-[a-z0-9-]+\}$/);
});

test("jede Image-Referenz ist über eine Umgebungsvariable übersteuerbar", () => {
  // AGENTS.md: der Rückweg auf eine ältere Fassung soll eine Zeile in der .env
  // plus `up -d` sein — kein Git-Vorgang und kein funktionierendes Dashboard.
  for (const [name, service] of Object.entries(compose.services)) {
    assert.match(String(service.image), /^\$\{[A-Z0-9_]+:-.+\}$/, `Dienst „${name}" hat keine übersteuerbare Image-Referenz`);
  }
});

test("kein Dienst zieht ein fließendes Image", () => {
  // `latest` hat keinen Punkt, auf den man zurückgehen kann.
  for (const [name, service] of Object.entries(compose.services)) {
    assert.doesNotMatch(String(service.image), /:latest\b/, `Dienst „${name}" zieht latest`);
  }
});

const defaultOf = (name) =>
  String(compose.services[name].image).replace(/^\$\{[A-Z0-9_]+:-/, "").replace(/\}$/, "");

test("Postgres ist auf Tag UND Digest gepinnt", () => {
  // Der Hub ist ausgenommen: für ihn ist der lokale Bau der Rückfall, solange
  // kein Image veröffentlicht ist. Sein `build` unten belegt das.
  assert.match(defaultOf(POSTGRES), /:[^@\s]+@sha256:[0-9a-f]{64}$/, `Dienst „${POSTGRES}" ist nicht auf Tag und Digest gepinnt`);
});

test("der Agent und der Sidecar sind auf einen SemVer-Tag im Agent-Repository gepinnt (#279)", () => {
  // The digest is optional until the first release run has produced one; the
  // tag is not. The name is the one the release workflow publishes.
  for (const name of [AGENT, WIREGUARD]) {
    assert.match(
      defaultOf(name),
      /^ghcr\.io\/florianfinn\/docklet-hub-agent:v\d+\.\d+\.\d+(@sha256:[0-9a-f]{64})?$/,
      `Dienst „${name}" ist nicht auf einen SemVer-Tag von docklet-hub-agent gepinnt`
    );
  }
});

test("der Hub lässt sich auch ohne Registry bauen", () => {
  // Ein Auschecken ohne Zugang zu einer Registry muss hochfahren (AGENTS.md).
  assert.ok(compose.services[HUB].build, "Dem Hub fehlt der lokale Bau als Rückfall");
});

test("der Agent und der Sidecar bauen das Image notfalls selbst, aus agent/Dockerfile (#279)", () => {
  for (const name of [AGENT, WIREGUARD]) {
    assert.equal(compose.services[name].build?.dockerfile, "agent/Dockerfile", `Dienst „${name}" hat keinen Rückfall`);
    assert.equal(compose.services[name].build?.context, ".", `Dienst „${name}" baut nicht aus der Wurzel`);
  }
});

test("weder Agent noch Datenbank veröffentlichen einen Port", () => {
  // Der Agent ist der einzige Weg zum docker.sock. Ein veröffentlichter Port
  // führte an der Anmeldung des Hubs vorbei; bei der Datenbank gibt es für
  // einen offenen Port schlicht keinen Anlass.
  for (const name of [AGENT, POSTGRES]) {
    assert.equal(compose.services[name].ports, undefined, `Dienst „${name}" veröffentlicht einen Port`);
  }
});

test("der Hub wird vorgabemäßig nur auf localhost veröffentlicht", () => {
  // SECURITY.md, Grundsatz 4: der Hub steht im eigenen Netz und nie
  // öffentlich. Daran hängt mehr als Vorsicht — weil es nur diesen einen
  // Zugriffsweg gibt, meldet sich der Hub beim Agenten konstant als intern,
  // und dessen zweite Linie ist damit für ihn erfüllt.
  //
  // ⚠️ Der Port steht seit der Netzvariante A beim SIDECAR und nicht mehr beim
  // Hub: der Hub teilt sich dessen Namensraum und kann selbst nichts
  // veröffentlichen (docs/design/phase-4-bootstrap-and-registration.md §6).
  // Die Zusage ist dieselbe geblieben, geprüft wird sie nur an der anderen
  // Stelle. Ein "ports" am Hub wäre ab jetzt ein Fehler, den Compose je nach
  // Fassung ablehnt oder stillschweigend ignoriert — deshalb steht er hier.
  //
  // ⚠️ Was dieser Fall prüfen kann, ist die VORGABE. Ob ein Betreiber davor
  // einen öffentlichen Reverse-Proxy stellt, sieht keine Datei in diesem Repo.
  // Die Vorgabe ist trotzdem die Stelle, an der die Entscheidung anfängt: sie
  // zwingt zu einer Zeile in der .env, statt sie zu ersparen.
  assert.equal(compose.services[HUB].ports, undefined, "Der Hub veröffentlicht selbst einen Port");
  assert.equal(
    compose.services[HUB].network_mode,
    `service:${WIREGUARD}`,
    "Der Hub hängt nicht im Namensraum des Sidecars"
  );

  const ports = (compose.services[WIREGUARD].ports ?? []).map(String);
  const web = ports.filter((entry) => !entry.endsWith("/udp"));
  assert.equal(web.length, 1, "Der Sidecar veröffentlicht nicht genau einen Port für den Hub");
  assert.match(
    web[0],
    /^\$\{HUB_BIND_ADDRESS:-127\.0\.0\.1\}:/,
    "Der Hub bindet vorgabemäßig nicht auf localhost"
  );
});

test("der Tunnel veröffentlicht genau einen UDP-Port, und nur der Sidecar tut das", () => {
  // Der einzige Port, den dieser Hub nach außen zeigt (SECURITY.md,
  // Grundsatz 5). Ein zweiter wäre eine Tür, von der niemand weiß.
  const udp = (compose.services[WIREGUARD].ports ?? []).map(String).filter((entry) => entry.endsWith("/udp"));
  assert.equal(udp.length, 1, "Der Sidecar veröffentlicht nicht genau einen UDP-Port");
  assert.match(
    udp[0],
    /^\$\{HUB_WIREGUARD_PORT:-51821\}:51821\/udp$/,
    "Der veröffentlichte UDP-Port ist nicht übersteuerbar oder trifft den ListenPort nicht"
  );
  for (const [name, service] of Object.entries(compose.services)) {
    if (name === WIREGUARD) continue;
    const own = (service.ports ?? []).map(String).filter((entry) => entry.endsWith("/udp"));
    assert.deepEqual(own, [], `Dienst „${name}" veröffentlicht einen UDP-Port`);
  }
});

test("NET_ADMIN trägt allein der Sidecar", () => {
  // Die Vorgabe aus §6, und der Grund, aus dem der Hub überhaupt in einen
  // fremden Namensraum zieht: eine Route zu setzen wäre genau die Fähigkeit,
  // die er nicht haben soll. Ein cap_add an einem anderen Dienst nähme dieser
  // Entscheidung ihren Sinn, ohne dass irgendetwas kaputtginge — es fiele also
  // nie auf.
  for (const [name, service] of Object.entries(compose.services)) {
    const capabilities = (service.cap_add ?? []).map(String);
    if (name === WIREGUARD) {
      assert.deepEqual(capabilities, ["NET_ADMIN"], "Der Sidecar trägt nicht genau NET_ADMIN");
    } else {
      assert.deepEqual(capabilities, [], `Dienst „${name}" bekommt eine Capability`);
    }
    assert.notEqual(service.privileged, true, `Dienst „${name}" läuft privilegiert`);
  }
});

test("Hub und Sidecar teilen sich genau ein Volume, und nur der Hub schreibt darin", () => {
  // Die einzige Verbindung zwischen beiden ist eine Datei. Fehlt das Volume an
  // einer der beiden Seiten, läuft alles weiter: der Hub schreibt, der Sidecar
  // liest seinen eigenen leeren Stand, und ein angebundener Arm steht in der
  // Oberfläche und nicht im Tunnel.
  const mountsOf = (name) => (compose.services[name].volumes ?? []).map(String);
  const hubMount = mountsOf(HUB).find((entry) => entry.startsWith("wireguard-config:"));
  const sidecarMount = mountsOf(WIREGUARD).find((entry) => entry.startsWith("wireguard-config:"));
  assert.equal(hubMount, "wireguard-config:/etc/wireguard", "Dem Hub fehlt das geteilte Volume");
  assert.equal(sidecarMount, "wireguard-config:/etc/wireguard:ro", "Der Sidecar hat das Volume nicht nur lesend");
  assert.ok("wireguard-config" in (compose.volumes ?? {}), "Das geteilte Volume ist nicht deklariert");

  // Der Schreibpfad des Hubs muss in diesem Mount liegen. Ein Pfad daneben
  // wäre eine Datei, die niemand liest.
  const path = String(compose.services[HUB].environment.HUB_WIREGUARD_CONFIG_PATH);
  assert.match(
    path,
    /^\$\{HUB_WIREGUARD_CONFIG_PATH:-\/etc\/wireguard\/[^}]+\}$/,
    `Der Schreibpfad liegt nicht im geteilten Mount: ${path}`
  );

  // Kein dritter Dienst sieht die Datei — in ihr steht der private Schlüssel
  // der Hub-Seite.
  for (const name of Object.keys(compose.services)) {
    if (name === HUB || name === WIREGUARD) continue;
    assert.deepEqual(
      mountsOf(name).filter((entry) => entry.startsWith("wireguard-config:")),
      [],
      `Dienst „${name}" sieht die wg0.conf`
    );
  }
});

test("Sidecar und Agent ziehen zwingend dasselbe Image", () => {
  // Beide Seiten desselben Tunnels. Zwei Einträge, die sich einzeln hochziehen
  // lassen, wären zwei Fassungen von wg, die sich erst im Betrieb
  // widersprechen — deshalb dieselbe Variable und derselbe Vorgabewert.
  assert.equal(String(compose.services[WIREGUARD].image), String(compose.services[AGENT].image));
});

test("der Sidecar lädt eine geänderte wg0.conf nach, und zwar gestrippt", () => {
  // ⚠️ Drei stille Fehler auf einmal, alle ohne laufenden Stack unsichtbar:
  //   * das Sidecar-Skript des Agent-Images ruft einmal wg-quick up und lädt
  //     nie nach (dashboard-docker-agent@v0.19.1, wireguard-sidecar.sh:11-18);
  //   * wg syncconf kennt die wg-quick-Direktiven nicht, ohne wg-quick strip
  //     bleibt das Interface still auf dem alten Stand;
  //   * Compose ersetzt eine Shell-Variable im command selbst, aus der .env
  //     heraus — nur die verdoppelte Form kommt in der Shell an.
  const command = (compose.services[WIREGUARD].command ?? []).map(String).join(" ");
  assert.match(command, /wg-quick strip wg0/, "Der Sidecar strippt die Datei nicht vor dem Nachladen");
  assert.match(command, /wg syncconf wg0/, "Der Sidecar lädt eine geänderte wg0.conf nicht nach");
  assert.doesNotMatch(command, /(^|[^$])\$[A-Za-z_{]/, "Eine Shell-Variable im command wird von Compose ersetzt");
  // Prozessersetzung kennt die busybox-Shell des Alpine-Images nicht.
  assert.doesNotMatch(command, /<\(/, "Prozessersetzung funktioniert in der busybox-Shell nicht");
});

test("der Hub wartet auf den Sidecar, aber nicht auf dessen Gesundheit", () => {
  // ⚠️ Gesund ist der Sidecar erst mit einer wg0.conf, und die schreibt der
  // Hub. service_healthy wäre hier ein Stack, der auf einer frischen Maschine
  // nie hochkommt — ohne Fehlermeldung, nur mit einem Container in "waiting".
  assert.equal(compose.services[HUB].depends_on[WIREGUARD].condition, "service_started");
});

test("nur der Agent sieht docker.sock, und zwar :ro", () => {
  // SECURITY.md, Grundsatz 3. Die naheliegende Abkürzung — „für den lokalen
  // Host genügt doch der Socket" — ist genau der Punkt, an dem die Aufteilung
  // ihren Zweck verlöre.
  for (const [name, service] of Object.entries(compose.services)) {
    const mounts = (service.volumes ?? []).map(String).filter((entry) => entry.includes("docker.sock"));
    if (name === AGENT) {
      assert.equal(mounts.length, 1, "Der Agent braucht genau einen Socket-Mount");
      assert.match(mounts[0], /:ro$/, "Der Socket-Mount des Agenten ist nicht :ro");
    } else {
      assert.deepEqual(mounts, [], `Dienst „${name}" sieht docker.sock`);
    }
  }
});

test("der Agent bekommt die Docker-GID als Pflichtwert, nicht als Vermutung", () => {
  // `:?` statt eines Vorgabewerts: eine geratene GID ergibt einen Agenten, der
  // startet und den Socket dann nicht lesen darf — ein Fehlerbild, das nach
  // „Docker kaputt" aussieht und keines ist.
  const groups = (compose.services[AGENT].group_add ?? []).map(String);
  assert.equal(groups.length, 1);
  assert.match(groups[0], /^\$\{DOCKER_GID:\?/);
});

test("jedes Geheimnis ist ein Pflichtwert ohne Vorgabe", () => {
  // Eine Vorgabe für ein Geheimnis wäre ein bekanntes Geheimnis. Fehlt der
  // Wert, soll Compose es sagen — nicht etwas einsetzen.
  const raw = readFileSync(new URL("docker-compose.yml", `file://${ROOT}`), "utf8");
  for (const name of ["POSTGRES_PASSWORD", "DOCKER_AGENT_SECRET", "BETTER_AUTH_SECRET"]) {
    const pattern = new RegExp(String.raw`\$\{${name}([^}]*)\}`, "g");
    const usages = [...raw.matchAll(pattern)].map((findings) => findings[1]);
    assert.ok(usages.length > 0, `${name} kommt in der Compose-Datei nicht vor`);
    for (const usage of usages) {
      assert.match(usage, /^:\?/, `${name} wird mit einer Vorgabe statt als Pflichtwert verwendet`);
    }
  }
});

test("der Agent hat ein eigenes State-Volume", () => {
  // Es hängt am Projektnamen und kann deshalb nicht mit dem eines bereits
  // laufenden Agenten des Hauptdashboards zusammenfallen (Issue #11).
  const mounts = (compose.services[AGENT].volumes ?? []).map(String);
  const state = mounts.find((entry) => entry.endsWith(":/state"));
  assert.ok(state, "Dem Agenten fehlt sein State-Volume");
  const volumeName = state.split(":")[0];
  assert.ok(volumeName in (compose.volumes ?? {}), `Das Volume „${volumeName}" ist nicht deklariert`);
});

test("die Datenbank wartet ab, bevor der Hub startet", () => {
  // Ohne diese Bedingung besteht das erste Log eines frischen Starts aus
  // Verbindungsfehlern — und die liest ein Fremder als kaputten Stack.
  assert.equal(compose.services[HUB].depends_on[POSTGRES].condition, "service_healthy");
});

test("jede Stellschraube der Compose-Datei steht in .env.example", () => {
  // Sonst gibt es Einstellungen, von denen ein neuer Betreiber nur erfährt,
  // wenn er die Compose-Datei liest — und das ist nicht der Ort, an dem er sucht.
  const raw = readFileSync(new URL("docker-compose.yml", `file://${ROOT}`), "utf8");
  const used = new Set([...raw.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:?}-]/g)].map((findings) => findings[1]));
  // Auch auskommentiert gilt: dort steht sie als Beispiel, mit ihrer Vorgabe.
  const documented = new Set(
    template
      .split("\n")
      .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter(Boolean)
  );
  const missing = [...used].filter((name) => !documented.has(name)).sort();
  assert.deepEqual(missing, [], `In docker-compose.yml verwendet, aber nicht in .env.example:\n${missing.join("\n")}`);
});

test("jede Umgebungsvariable, die der Hub liest, wird ihm auch übergeben", () => {
  // Die Lücke, aus der dieser Wächter entstanden ist (2026-09-06, erster
  // Start eines frischen Stacks auf einem Zielhost): sechs von zwölf Werten,
  // die `config.ts` liest, standen in `.env.example` und in der `.env` — aber
  // nicht im `environment`-Block des Dienstes. Der Prozess sah sie nie, und
  // „Arm anlegen" endete in `config-incomplete`, während alle Tests grün
  // blieben: sie setzen die Umgebung selbst.
  //
  // `env-template.test.mjs` prüft Code gegen Vorlage, dieser Fall prüft die
  // Strecke dahinter — Vorlage gegen Container.
  const configSource = readFileSync(new URL("server/src/platform/config/config.ts", `file://${ROOT}`), "utf8");
  const read = new Set([...configSource.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((findings) => findings[1]));
  const passed = new Set(Object.keys(compose.services[HUB].environment));

  const missing = [...read].filter((name) => !passed.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `Der Hub liest diese Variablen, bekommt sie aber nicht:\n${missing.join("\n")}`
  );
});

test("die Images laufen auf derselben Node-Fassung wie die Arbeitskopie", () => {
  // The local Node version and the container build must match.
  // Otherwise the local check verifies a different runtime than deployment.
  const nvmrc = readFileSync(new URL(".nvmrc", `file://${ROOT}`), "utf8").trim();
  for (const path of ["server/Dockerfile", "agent/Dockerfile"]) {
    const dockerfile = readFileSync(new URL(path, `file://${ROOT}`), "utf8");
    // Every external base counts, whatever the spelling; earlier stages are skipped.
    const stages = new Set();
    const bases = [];
    for (const [, base, stage] of dockerfile.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)) {
      if (!stages.has(base.toLowerCase())) bases.push(base);
      if (stage) stages.add(stage.toLowerCase());
    }
    assert.ok(bases.length > 0, `${path} nennt kein Basisimage`);
    for (const base of bases) {
      assert.match(base, /^node:\d+-alpine@sha256:[0-9a-f]{64}$/, `${path}: „${base}" ist nicht auf Tag und Digest gepinnt`);
      assert.equal(base.match(/^node:(\d+)-/)[1], nvmrc, `.nvmrc sagt Node ${nvmrc}, ${path} baut auf „${base}"`);
    }
  }
});

test("@types/node beschreibt dieselbe Node-Fassung wie .nvmrc", () => {
  // Newer types let tsc accept APIs that the Node runtime does not have.
  const nvmrc = readFileSync(new URL(".nvmrc", `file://${ROOT}`), "utf8").trim();
  for (const pkg of ["agent", "server", "web"]) {
    const manifest = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, `file://${ROOT}`), "utf8"));
    const ranges = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .map((field) => manifest[field]?.["@types/node"])
      .filter((range) => range !== undefined);
    assert.ok(ranges.length > 0, `${pkg}: @types/node fehlt`);
    for (const range of ranges) {
      assert.equal(range.match(/^\^(\d+)\./)?.[1], nvmrc, `${pkg}: @types/node „${range}" passt nicht zu Node ${nvmrc}`);
    }
  }
});

test("das Image bekommt die Migrationen mitkopiert", () => {
  // `tsc` übersetzt TypeScript und rührt .sql-Dateien nicht an. Ohne eine
  // eigene COPY-Zeile enthält das Image ein leeres Migrationsverzeichnis.
  //
  // Der Läufer hält deswegen inzwischen an (migration-plan.ts), das ist die
  // eigentliche Schranke. Dieser Fall hier fängt denselben Fehler eine Stufe
  // früher: beim Ändern des Dockerfiles statt beim Hochfahren des Containers.
  const dockerfile = readFileSync(new URL("server/Dockerfile", `file://${ROOT}`), "utf8");
  const copied = /^COPY\b.*db\/migrations/m.test(dockerfile);
  assert.ok(copied, "server/Dockerfile kopiert das Migrationsverzeichnis nicht ins Image");
});

test("das Image übergibt dem Hub-Benutzer das Verzeichnis des geteilten Volumes", () => {
  // ⚠️ Der stillste Fehler dieses Stacks. Ein BENANNTES Volume übernimmt
  // Besitzer und Rechte beim ersten Start aus dem Verzeichnis im Image; fehlt
  // es dort, legt Docker es als root:root 0755 an. Der Hub läuft als `node`
  // (uid 1000) und könnte dann nicht hineinschreiben — auffallen würde das
  // erst beim Anlegen des ersten Arms, und dort sieht es nach einem Fehler im
  // Hub aus statt nach einer fehlenden Zeile im Dockerfile.
  //
  // Compose kann das nicht nachholen: ein `chown` gibt es dort nicht. Deshalb
  // hängt diese Zusage am Dockerfile und wird hier geprüft, wo der Mount steht.
  const dockerfile = readFileSync(new URL("server/Dockerfile", `file://${ROOT}`), "utf8");

  const mount = (compose.services[HUB].volumes ?? [])
    .map(String)
    .find((entry) => entry.startsWith("wireguard-config:"));
  const mountPath = String(mount).split(":")[1];

  const lines = dockerfile.split("\n");
  const prepared = lines.findIndex(
    (line) => new RegExp(String.raw`^RUN\b.*\bchown\s+node:node\s+${mountPath}\b`).test(line)
  );
  assert.notEqual(prepared, -1, `Das Image übergibt ${mountPath} nicht dem Benutzer node`);

  const dropsRoot = lines.findIndex((line) => /^USER\s+node\b/.test(line));
  assert.notEqual(dropsRoot, -1, "Das Image wechselt nicht auf den Benutzer node");
  assert.ok(
    prepared < dropsRoot,
    `${mountPath} wird erst nach USER node angelegt — als node fehlt dafür das Recht`
  );
});
