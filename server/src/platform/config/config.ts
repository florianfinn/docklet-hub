// Konfiguration des Hubs aus der Umgebung.
//
// Bewusst von Hand geprüft statt über ein Schema-Werkzeug: die Meldungen sind
// hier das Produkt, nicht die Prüfung. Ein fremder Betreiber sieht beim
// Fehlstart genau diese Zeile und sonst nichts vom System — sie muss sagen,
// welcher Wert fehlt und woher er kommt, nicht nur, dass etwas ungültig war.
//
// Fail closed: fehlt ein Pflichtwert, startet der Hub nicht. Ein Hub, der ohne
// Agent-Secret hochfährt, ist kein halb funktionierender Hub, sondern einer,
// der beim ersten Zugriff unverständlich scheitert.

// Das Tunnelnetz, aufgeschlüsselt — einmal gerechnet statt an drei Stellen.
//
// Die Werte kommen aus EINER Angabe (`HUB_TUNNEL_CIDR`). Wer das Netz ändert,
// ändert eine Zeile; Hub-Adresse und Adressbereich der Arme folgen. Stünden
// sie einzeln in der Umgebung, wäre die zweite Zeile, die jemand vergisst, ein
// Tunnel, in dem der Hub sich selbst nicht findet.
export type TunnelNetwork = {
  // Wie es in der Umgebung steht — für Meldungen an den Betreiber.
  cidr: string;
  // Die Netzadresse, ohne Präfix. Die Vergabe der Arm-Adressen rechnet darauf
  // (domain/hosts/host-store.ts).
  networkAddress: string;
  prefixLength: number;
  // Immer die erste nutzbare Adresse des Netzes. Der Hub ist die eine Seite,
  // die es in jedem Tunnel gibt.
  hubAddress: string;
  // Die Arme beginnen hinter dem Hub und enden vor der Rundrufadresse.
  firstArmOffset: number;
  lastArmOffset: number;
};

export type Config = {
  port: number;
  databaseUrl: string;
  agentBaseUrl: string;
  agentSecret: string;
  authSecret: string;
  authBaseUrl: string;
  localHostName: string;
  // Wo ein Arm den Hub im Internet erreicht.
  //
  // ⚠️ Beim Start optional, beim Anlegen eines Arms Pflicht. Das ist die
  // Zusage aus concept-and-plan.md §2 („Einrichtungsaufwand"): ein Pflichtwert
  // beim Start trifft jeden Betreiber, eine Frage beim ersten Arm nur den, der
  // einen anbindet. Wer sie einlöst, ruft `resolveWireguardEndpoint` und
  // bekommt die Meldung, die der Betreiber lesen soll.
  wireguardEndpoint: string | null;
  wireguardPort: number;
  // Der Port, auf dem der Anmeldeweg im Tunnel lauscht — eine eigene, minimale
  // Anwendung neben der API (SECURITY.md, Grundsatz 2).
  tunnelPort: number;
  // Das Schlüsselpaar der Hub-Seite des Tunnels.
  //
  // ⚠️ Beim Start optional, aus demselben Grund wie der Endpoint: ein Betrieb
  // ohne Arme braucht keinen Tunnel. Gebraucht wird es, sobald die Peer-Liste
  // geschrieben oder ein Archiv erzeugt wird — dort meldet sein Fehlen sich
  // als Klartext an den Betreiber (features/hosts/enrollment.ts).
  //
  // Der öffentliche Teil steht daneben, obwohl er sich aus dem privaten
  // rechnen ließe: er reist in jedes Archiv, und ein Paar, das nicht
  // zusammengehört, ergibt einen Tunnel, der ohne Fehlermeldung nichts
  // überträgt. Beide Werte hier zu haben, macht diesen Vergleich möglich.
  hubWireguardPrivateKey: string | null;
  hubWireguardPublicKey: string | null;
  // Wohin die Peer-Liste des Tunnels geschrieben wird — dieselbe Datei, die
  // der WireGuard-Sidecar aus dem geteilten Volume liest.
  wireguardConfigPath: string;
  tunnel: TunnelNetwork;
  // Wie oft der Hintergrundlauf über alle Arme geht — in SEKUNDEN, weil
  // Millisekunden in einer `.env` niemand fehlerfrei abzählt.
  //
  // ⚠️ `0` schaltet den Lauf ab. Das ist die Bremse für den Fall, dass er sich
  // als Fehler erweist: der Betreiber setzt eine Zeile und startet neu, statt
  // auf einen neuen Bau zu warten. Bei `0` fragen die Leser wieder selbst
  // (domain/hosts/host-observation-store.ts, `createObservedProbe`) — die
  // Oberfläche wird langsamer und bleibt richtig.
  hostCycleIntervalSeconds: number;
};

// Eigene Fehlerklasse, damit der Aufrufer einen Konfigurationsfehler von einem
// Programmierfehler unterscheiden kann: der eine gehört als Klartext ins Log,
// der andere mit Stacktrace.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Dieselbe Mindestlänge, die der Agent auf seiner Seite erzwingt
// (`DOCKER_AGENT_SECRET`, min. 32 Zeichen). Sie steht hier noch einmal, weil
// ein zu kurzer Wert sonst erst beim ersten Aufruf auffiele — als 401 vom
// Agenten, also an der Stelle, an der niemand die Ursache vermutet.
const SECRET_MIN_LENGTH = 32;

// ⚠️ Jede Umgebungsvariable wird unten wörtlich über den Parameter gelesen,
// mit ausgeschriebenem Namen, nie über eine berechnete Zeichenkette. Das ist
// keine Stilfrage: der Wächter
// web/tests/env-template.test.mjs findet die Namen per Textsuche und gleicht
// sie gegen .env.example ab. Ein Wert, der über `env[name]` hereinkommt, wäre
// für ihn unsichtbar — und damit eine Einstellung, von der ein neuer Betreiber
// nie erfährt.
function required(name: string, value: string | undefined, hint: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigError(`${name} fehlt. ${hint}`);
  }
  return trimmed;
}

// Vorgaben des Tunnels. Sie stehen in concept-and-plan.md §2 und in
// SECURITY.md, Grundsatz 5 — hier als Code, damit ein frischer Betrieb ohne
// eine einzige Angabe hochfährt.
const DEFAULT_TUNNEL_CIDR = "10.254.0.0/24";
const DEFAULT_WIREGUARD_PORT = 51821;
// Der Mountpunkt des geteilten Volumes aus der docker-compose.yml. Wer ihn
// ändert, ändert ihn an beiden Diensten — sonst schreibt der Hub in eine
// Datei, die der Sidecar nie sieht.
const DEFAULT_WIREGUARD_CONFIG_PATH = "/etc/wireguard/wg0.conf";

// Der Port des Anmeldewegs im Tunnel. Vorgabe wie in der .env.example; er wird
// NICHT auf dem Host veröffentlicht (docs/design/phase-4-bootstrap-and-registration.md §6).
const DEFAULT_TUNNEL_PORT = 8099;

// Der Takt des Hintergrundlaufs. Eine Minute, und die Zahl ist nicht beliebig:
// die Sonde je Arm trägt eine Frist von 3 s (`features/containers/routes.ts`,
// `features/hosts/routes.ts`), ein Durchlauf über eine Handvoll Arme liegt damit im
// Bereich weniger Sekunden. Ein Takt darunter fragte häufiger, als sich etwas
// ändert; ein Takt darüber ließe die Erreichbarkeit in der Übersicht länger
// altern, als ein Betreiber es beim Neustart eines Arms erwartet.
const DEFAULT_HOST_CYCLE_INTERVAL_SECONDS = 60;

// Ein Tag. Wer mehr einträgt, meint keinen Hintergrundlauf mehr, sondern hat
// sich vertippt — und ein Tippfehler, der als „läuft nie" durchginge, wäre die
// stillste Art, diesen Lauf zu verlieren. Wer ihn wirklich abschalten will,
// trägt `0` ein; das steht als Bremse ausdrücklich in der Vorlage.
const MAX_HOST_CYCLE_INTERVAL_SECONDS = 86_400;

// Die Form, die `wg genkey` erzeugt: 32 Byte Base64, also 43 Zeichen und ein
// Füllzeichen. Ein Wert, der anders aussieht — allen voran der Platzhalter
// „wird-erzeugt" aus der Vorlage —, wird hier abgewiesen und nicht erst von
// `wg-quick` auf dem laufenden Sidecar, wo niemand mehr an diese Zeile denkt.
const WIREGUARD_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

function optionalWireguardKey(name: string, value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!WIREGUARD_KEY_PATTERN.test(trimmed)) {
    throw new ConfigError(
      `${name} ist kein WireGuard-Schlüssel. Erwartet werden 44 Zeichen Base64, wie sie „wg genkey" erzeugt; ` +
        "scripts/bootstrap.sh würfelt das Paar einmalig in die .env."
    );
  }
  return trimmed;
}

// Enger als /8 und weiter als /30: ein /30 trägt genau zwei Adressen, also den
// Hub und einen Arm, und ein /8 ist kein Heimnetz-Tunnel mehr, sondern ein
// Tippfehler, der 16 Millionen Adressen durchsuchen ließe.
const MIN_PREFIX_LENGTH = 8;
const MAX_PREFIX_LENGTH = 30;

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Führende Nullen werden je nach Werkzeug oktal gelesen — „010" ist für
    // manche 8. Eine Adresse, die zweideutig ist, wird abgelehnt und nicht
    // ausgelegt.
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function toDottedQuad(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/**
 * Liest `a.b.c.d/nn` und rechnet daraus alles, was der Tunnel braucht.
 *
 * ⚠️ Die Netzadresse wird MASKIERT, nicht übernommen. Wer „10.254.0.5/24"
 * einträgt, meint das Netz 10.254.0.0/24 — ohne die Maskierung läge der Hub
 * auf .6 und die Arme ab .7, und die Adressen im ausgelieferten Archiv
 * stimmten mit nichts überein, was jemand erwartet.
 */
export function parseTunnelCidr(raw: string): TunnelNetwork {
  const [addressPart, prefixPart, ...rest] = raw.split("/");
  const octets = parseIpv4(addressPart ?? "");
  if (!octets || rest.length > 0 || prefixPart === undefined || !/^\d{1,2}$/.test(prefixPart)) {
    throw new ConfigError(
      `HUB_TUNNEL_CIDR ist kein IPv4-Netz in CIDR-Schreibweise: „${raw}". Erwartet wird etwas wie ${DEFAULT_TUNNEL_CIDR}.`
    );
  }
  const prefixLength = Number(prefixPart);
  if (prefixLength < MIN_PREFIX_LENGTH || prefixLength > MAX_PREFIX_LENGTH) {
    throw new ConfigError(
      `HUB_TUNNEL_CIDR trägt die Präfixlänge /${prefixLength}. Zulässig ist /${MIN_PREFIX_LENGTH} bis /${MAX_PREFIX_LENGTH}.`
    );
  }

  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (value & mask) >>> 0;
  // Die letzte Adresse des Netzes ist der Rundruf und wird nicht vergeben; die
  // erste ist das Netz selbst.
  const lastArmOffset = 2 ** (32 - prefixLength) - 2;

  return {
    cidr: `${toDottedQuad(network)}/${prefixLength}`,
    networkAddress: toDottedQuad(network),
    prefixLength,
    hubAddress: toDottedQuad((network + 1) >>> 0),
    firstArmOffset: 2,
    lastArmOffset
  };
}

/**
 * Der Host-Teil eines Endpoints, ohne Port und ohne Klammern.
 *
 * ⚠️ Die drei Formen unterscheiden sich nur am Doppelpunkt, und genau der ist
 * in IPv6 auch Trennzeichen innerhalb der Adresse. Deshalb zuerst die
 * Klammerform: `[::1]:51821` und `[::1]` tragen ihren Host zwischen den
 * Klammern. Danach die Form `host:port`, die höchstens EINEN Doppelpunkt hat —
 * ein bloßes `::1` ohne Klammern fällt damit richtig durch und bleibt ganz.
 */
export function endpointHost(endpoint: string): string {
  const trimmed = endpoint.trim();
  const bracketed = /^\[([^\]]*)\]/.exec(trimmed);
  if (bracketed) return bracketed[1];
  const withPort = /^([^:]+):\d+$/.exec(trimmed);
  return withPort ? withPort[1] : trimmed;
}

// Die IPv4-Bereiche, die von außen nicht zu erreichen sind. Die Reihenfolge
// ist ohne Bedeutung, die Vollständigkeit nicht: was hier fehlt, gilt als
// erreichbar, und ein Arm bekäme dafür ein Paket, das nie ankommt.
const PRIVATE_IPV4: ((octets: number[]) => boolean)[] = [
  ([a]) => a === 10, // 10.0.0.0/8
  ([a]) => a === 127, // Loopback
  ([a]) => a === 0, // „dieses Netz"
  ([a, b]) => a === 172 && b >= 16 && b <= 31, // 172.16.0.0/12
  ([a, b]) => a === 192 && b === 168, // 192.168.0.0/16
  ([a, b]) => a === 169 && b === 254, // Link-local
  ([a, b]) => a === 100 && b >= 64 && b <= 127 // CGNAT, 100.64.0.0/10
];

/**
 * Ob dieser Endpoint aus einem FREMDEN Netz erwiesenermaßen nicht erreichbar ist.
 *
 * ⚠️ „Erwiesenermaßen" ist die ganze Aussage. Geprüft werden ausschließlich
 * LITERALE Adressen; ein Name gilt als erreichbar, weil dieser Hub nicht weiß,
 * worauf er zeigt — und ein DynDNS-Name ist die normale Antwort für einen
 * externen Arm. Ein `false` heißt also „kein Beweis dagegen" und nicht „geht".
 *
 * Umgekehrt ist ein `true` belastbar: eine 192.168er-Adresse im `Endpoint`
 * eines Arms auf einem VPS kann nicht funktionieren, und zwar unabhängig
 * davon, was sonst noch stimmt.
 */
export function isUnreachableFromOutside(endpoint: string): boolean {
  const host = endpointHost(endpoint).toLowerCase();
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets) {
    const parts = octets.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    return PRIVATE_IPV4.some((matches) => matches(parts));
  }
  // IPv6: Loopback, Unique Local (fc00::/7 — also fc.. und fd..) und
  // Link-local (fe80::/10). Ein Name enthält keinen Doppelpunkt und kommt hier
  // nicht an.
  if (!host.includes(":")) return false;
  if (host === "::1" || host === "::") return true;
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/**
 * Der Endpoint, den ein Arm in seine `wg0.conf` bekommt — als `host:port`.
 *
 * ⚠️ Hier wird der Wert eingelöst, der beim Start fehlen durfte. Die Meldung
 * ist das Produkt: sie fällt einem Betreiber vor die Füße, der gerade seinen
 * ersten Arm anlegt, und muss sagen, welche Zeile in der `.env` fehlt und was
 * hineingehört.
 *
 * DREI Quellen, in dieser Reihenfolge:
 *
 *   1. `override` — der Wert an genau DIESEM Arm, seine Ausnahme.
 *   2. `externalDefault` — die Adresse des Hubs von außen (`hub_network`),
 *      gereicht ausschließlich für Arme der Art `external`.
 *   3. `config.wireguardEndpoint` — die Adresse aus der Umgebung. Sie ist die
 *      Adresse des Hubs im EIGENEN Netz und damit die richtige für interne
 *      Arme.
 *
 * ⚠️ Die Reihenfolge ist die Aussage. Stünde der externe Vorgabewert vor dem
 * Override, könnte ein Betreiber einen einzelnen externen Arm nicht mehr
 * anders anbinden als alle übrigen — und genau dafür gibt es den Override.
 *
 * Trägt der gewählte Wert selbst einen Port, gilt dieser; sonst der aus der
 * Umgebung.
 */
export function resolveWireguardEndpoint(
  config: Pick<Config, "wireguardEndpoint" | "wireguardPort">,
  override?: string | null,
  externalDefault?: string | null
): string {
  const chosen = override?.trim() || externalDefault?.trim() || config.wireguardEndpoint;
  if (!chosen) {
    throw new ConfigError(
      "HUB_WIREGUARD_ENDPOINT fehlt. Ein Arm braucht die Adresse, unter der er diesen Hub von außen erreicht — " +
        "ein Hostname oder eine IP, ohne Schema und ohne Port. Sie steht in der .env neben der docker-compose.yml; " +
        "der Port kommt aus HUB_WIREGUARD_PORT. Für einen einzelnen Arm lässt sie sich beim Anlegen überschreiben."
    );
  }
  // Ein Port im Wert selbst gilt. `[::1]:51821` bleibt dabei erkennbar: nach
  // der schließenden Klammer steht der Doppelpunkt, davor nicht.
  const hasPort = /]:\d+$/.test(chosen) || (!chosen.includes("[") && /^[^:]+:\d+$/.test(chosen));
  return hasPort ? chosen : `${chosen}:${config.wireguardPort}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const portRaw = env.PORT?.trim() || "8080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT ist keine gültige Portnummer: „${portRaw}".`);
  }

  const databaseUrl = required(
    "DATABASE_URL",
    env.DATABASE_URL,
    "Sie wird von scripts/bootstrap.sh erzeugt und steht in der .env neben der docker-compose.yml."
  );
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new ConfigError("DATABASE_URL ist keine gültige URL. Erwartet wird postgres://benutzer:passwort@host:5432/datenbank.");
  }
  if (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") {
    throw new ConfigError(
      `DATABASE_URL zeigt auf „${parsedDatabaseUrl.protocol}" statt auf postgres:. Dieser Hub spricht ausschließlich Postgres.`
    );
  }

  const agentBaseUrl = required(
    "DOCKER_AGENT_URL",
    env.DOCKER_AGENT_URL,
    "Sie zeigt auf den Agenten des lokalen Hosts, im mitgelieferten Stack http://docker-agent:8099."
  );
  let parsedAgentUrl: URL;
  try {
    parsedAgentUrl = new URL(agentBaseUrl);
  } catch {
    throw new ConfigError("DOCKER_AGENT_URL ist keine gültige URL. Erwartet wird http://host:port ohne Pfad.");
  }
  if (parsedAgentUrl.protocol !== "http:" && parsedAgentUrl.protocol !== "https:") {
    throw new ConfigError(`DOCKER_AGENT_URL muss http oder https sein, nicht „${parsedAgentUrl.protocol}".`);
  }

  const agentSecret = required(
    "DOCKER_AGENT_SECRET",
    env.DOCKER_AGENT_SECRET,
    "Hub und Agent teilen sie sich; scripts/bootstrap.sh erzeugt sie einmalig für beide."
  );
  if (agentSecret.length < SECRET_MIN_LENGTH) {
    throw new ConfigError(
      `DOCKER_AGENT_SECRET ist zu kurz (${agentSecret.length} Zeichen, mindestens ${SECRET_MIN_LENGTH}). ` +
        "Der Agent lehnt einen kürzeren Wert auf seiner Seite ebenfalls ab."
    );
  }

  const authSecret = required(
    "BETTER_AUTH_SECRET",
    env.BETTER_AUTH_SECRET,
    "Er verschlüsselt die Sitzungen der Anmeldung; scripts/bootstrap.sh würfelt ihn einmalig."
  );
  if (authSecret.length < SECRET_MIN_LENGTH) {
    throw new ConfigError(
      `BETTER_AUTH_SECRET ist zu kurz (${authSecret.length} Zeichen, mindestens ${SECRET_MIN_LENGTH}). ` +
        "Ein kurzer Sitzungsschlüssel ist kein kleineres Problem als ein kurzes Passwort — er gilt für alle Sitzungen gleichzeitig."
    );
  }

  // Die Adresse, unter der der Browser den Hub erreicht.
  //
  // ⚠️ Sie ist nicht Kosmetik: better-auth prüft die Herkunft einer Anmeldung
  // gegen sie. Steht hier `localhost`, der Betreiber ruft den Hub aber über
  // seine LAN-Adresse auf, lehnt die Anmeldung ab — mit einer Meldung über die
  // Herkunft, die niemand mit dieser Zeile in Verbindung bringt. Die Vorgabe
  // passt zur Vorgabe von HUB_BIND_ADDRESS (127.0.0.1); wer die eine ändert,
  // ändert die andere mit.
  const authBaseUrlRaw = env.BETTER_AUTH_URL?.trim() || "http://localhost:8080";
  let parsedAuthUrl: URL;
  try {
    parsedAuthUrl = new URL(authBaseUrlRaw);
  } catch {
    throw new ConfigError("BETTER_AUTH_URL ist keine gültige URL. Erwartet wird http://host:port ohne Pfad.");
  }
  if (parsedAuthUrl.protocol !== "http:" && parsedAuthUrl.protocol !== "https:") {
    throw new ConfigError(`BETTER_AUTH_URL muss http oder https sein, nicht „${parsedAuthUrl.protocol}".`);
  }

  // Der Name, unter dem der lokale Host in der Oberfläche steht. Eine Vorgabe
  // und kein Pflichtfeld: ein frischer Betrieb soll ohne eine einzige Angabe
  // hochfahren (concept-and-plan.md §2).
  const localHostName = env.LOCAL_HOST_NAME?.trim() || "local";

  // Der Endpoint darf beim Start fehlen — er wird erst gebraucht, wenn ein Arm
  // angelegt wird (`resolveWireguardEndpoint`). Was hier trotzdem geprüft
  // wird: dass ein GESETZTER Wert brauchbar ist. Ein Schema oder ein Pfad
  // darin fiele sonst erst in der `wg0.conf` auf dem Zielhost auf, und dort
  // sagt WireGuard nur „Invalid endpoint".
  const endpointRaw = env.HUB_WIREGUARD_ENDPOINT?.trim() || null;
  if (endpointRaw !== null) {
    if (endpointRaw.includes("://") || endpointRaw.includes("/")) {
      throw new ConfigError(
        `HUB_WIREGUARD_ENDPOINT ist eine Adresse, keine URL: „${endpointRaw}". Erwartet wird ein Hostname oder eine IP, ohne Schema und ohne Pfad.`
      );
    }
    if (/\s/.test(endpointRaw)) {
      throw new ConfigError(`HUB_WIREGUARD_ENDPOINT enthält Leerzeichen: „${endpointRaw}".`);
    }
  }

  const wireguardPortRaw = env.HUB_WIREGUARD_PORT?.trim() || String(DEFAULT_WIREGUARD_PORT);
  const wireguardPort = Number(wireguardPortRaw);
  if (!Number.isInteger(wireguardPort) || wireguardPort < 1 || wireguardPort > 65535) {
    throw new ConfigError(`HUB_WIREGUARD_PORT ist keine gültige Portnummer: „${wireguardPortRaw}".`);
  }

  // ⚠️ Absolut, nicht relativ. Ein relativer Pfad löst gegen das
  // Arbeitsverzeichnis des Prozesses auf; der Hub schriebe die Datei dann
  // klaglos irgendwohin ins Image, der Sidecar sähe sie nie, und der Fehler
  // bestünde darin, dass ein frisch angebundener Arm in der Oberfläche steht
  // und im Tunnel nicht. Nichts daran meldet sich von selbst.
  const tunnelPortRaw = env.TUNNEL_PORT?.trim() || String(DEFAULT_TUNNEL_PORT);
  const tunnelPort = Number(tunnelPortRaw);
  if (!Number.isInteger(tunnelPort) || tunnelPort < 1 || tunnelPort > 65535) {
    throw new ConfigError(`TUNNEL_PORT ist keine gültige Portnummer: „${tunnelPortRaw}".`);
  }
  if (tunnelPort === port) {
    throw new ConfigError(
      `TUNNEL_PORT und PORT stehen beide auf ${port}. Der Anmeldeweg ist eine eigene Anwendung und lauscht ` +
        "auf einem eigenen Port; auf demselben käme genau eine der beiden hoch."
    );
  }

  const hubWireguardPrivateKey = optionalWireguardKey("HUB_WIREGUARD_PRIVATE_KEY", env.HUB_WIREGUARD_PRIVATE_KEY);
  const hubWireguardPublicKey = optionalWireguardKey("HUB_WIREGUARD_PUBLIC_KEY", env.HUB_WIREGUARD_PUBLIC_KEY);

  const wireguardConfigPath = env.HUB_WIREGUARD_CONFIG_PATH?.trim() || DEFAULT_WIREGUARD_CONFIG_PATH;
  if (!wireguardConfigPath.startsWith("/")) {
    throw new ConfigError(
      `HUB_WIREGUARD_CONFIG_PATH ist kein absoluter Pfad: „${wireguardConfigPath}". Erwartet wird der Ort im ` +
        `geteilten Volume, im mitgelieferten Stack ${DEFAULT_WIREGUARD_CONFIG_PATH}.`
    );
  }

  const tunnel = parseTunnelCidr(env.HUB_TUNNEL_CIDR?.trim() || DEFAULT_TUNNEL_CIDR);

  // ⚠️ `?? String(…)` und nicht `|| String(…)`: mit `||` wäre der eingetragene
  // Wert „0" leer-gleich und fiele auf die Vorgabe zurück — die Bremse ließe
  // sich dann nicht ziehen, und niemand sähe warum. Ein leerer Eintrag
  // (`HUB_HOST_CYCLE_INTERVAL_SECONDS=`) meint dagegen „nichts gesetzt" und
  // bekommt die Vorgabe.
  const hostCycleRaw = env.HUB_HOST_CYCLE_INTERVAL_SECONDS?.trim();
  const hostCycleIntervalSeconds = Number(
    hostCycleRaw === undefined || hostCycleRaw === "" ? String(DEFAULT_HOST_CYCLE_INTERVAL_SECONDS) : hostCycleRaw
  );
  if (
    !Number.isInteger(hostCycleIntervalSeconds) ||
    hostCycleIntervalSeconds < 0 ||
    hostCycleIntervalSeconds > MAX_HOST_CYCLE_INTERVAL_SECONDS
  ) {
    throw new ConfigError(
      `HUB_HOST_CYCLE_INTERVAL_SECONDS ist keine gültige Sekundenzahl: „${hostCycleRaw ?? ""}". Erwartet wird eine ` +
        `ganze Zahl von 0 bis ${MAX_HOST_CYCLE_INTERVAL_SECONDS}; ${DEFAULT_HOST_CYCLE_INTERVAL_SECONDS} ist die ` +
        "Vorgabe, und 0 schaltet den Hintergrundlauf ab."
    );
  }

  return {
    port,
    databaseUrl,
    // Ohne abschließenden Schrägstrich, damit das Zusammensetzen von Pfaden an
    // genau einer Stelle passiert und nicht zu `//health` führt.
    agentBaseUrl: agentBaseUrl.replace(/\/+$/, ""),
    agentSecret,
    authSecret,
    authBaseUrl: authBaseUrlRaw.replace(/\/+$/, ""),
    localHostName,
    wireguardEndpoint: endpointRaw,
    wireguardPort,
    tunnelPort,
    hubWireguardPrivateKey,
    hubWireguardPublicKey,
    wireguardConfigPath,
    tunnel,
    hostCycleIntervalSeconds
  };
}
