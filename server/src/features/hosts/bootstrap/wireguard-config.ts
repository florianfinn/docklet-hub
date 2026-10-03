// Der wg0.conf-Renderer der Hub-Seite.
//
// Eine reine Funktion: sie schreibt keine Datei, liest keine Datenbank und
// kennt keine Uhrzeit. Aus denselben Werten fällt derselbe Text — sonst
// schriebe der Hub bei jedem Durchlauf eine „geänderte" Datei, der Sidecar
// lüde sie nach, und jeder Neustart des Tunnels wäre ein Vorgang ohne Anlass
// (docs/design/phase-4-bootstrap-and-registration.md §5).
//
// ⚠️ Was hier entsteht, ist eine KONFIGURATIONSDATEI, und jede Zeile darin ist
// eine Anweisung. Ein Wert aus der Datenbank, der einen Zeilenumbruch enthält,
// ist deshalb kein Schönheitsfehler, sondern eine eingeschleuste Anweisung:
// ein Hostname `arm\nAllowedIPs = 0.0.0.0/0` gäbe einem einzelnen Arm den
// gesamten Verkehr des Tunnels. Alles, was hier hineingeht, wird vorher
// geprüft und nicht bereinigt — ein stillschweigend entschärfter Wert wäre ein
// Datensatz, der im Hub anders aussieht als im Tunnel.

/** Die Hub-Seite: der eigene Schlüssel, die eigene Adresse, der eigene Port. */
export type WireGuardHub = {
  privateKey: string;
  /** Mit Präfix, z. B. `10.254.0.1/24` — so verlangt es `wg-quick`. */
  address: string;
  /**
   * Der Port INNERHALB des Containers, also `51821` aus der
   * `docker-compose.yml` (`… :51821/udp`).
   *
   * ⚠️ Nicht `config.wireguardPort`. Der ist der VERÖFFENTLICHTE Port auf dem
   * Host: er steht links vom Doppelpunkt und in dem Endpoint, den ein Arm
   * anwählt (`resolveWireguardEndpoint`). Beide dürfen auseinanderlaufen, und
   * sobald ein Betreiber `HUB_WIREGUARD_PORT` ändert, tun sie das auch. Wer
   * ihn hier durchreicht, lässt den Sidecar auf einem Port lauschen, auf den
   * keine Weiterleitung zeigt — der Tunnel kommt dann nie zustande, und keine
   * Zeile in irgendeinem Log nennt den Grund.
   */
  listenPort: number;
};

/** Ein angebundener Arm. Genau ein `[Peer]`-Block je Host. */
export type WireGuardPeer = {
  publicKey: string;
  /** Ohne Präfix, z. B. `10.254.0.2`. Das `/32` setzt der Renderer. */
  tunnelAddress: string;
  /** Nur für den Kommentar über dem Block — WireGuard liest ihn nie. */
  name: string;
};

/**
 * Ein unbrauchbarer Wert auf dem Weg in die Konfigurationsdatei.
 *
 * Eigene Klasse, damit der Aufrufer sie von einem Programmierfehler
 * unterscheiden kann: sie gehört als Klartext an den Betreiber, nicht mit
 * Stacktrace ins Log.
 */
export class WireGuardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireGuardConfigError";
  }
}

// Die Form, die `wg genkey` erzeugt: 32 Byte in Base64, also 43 Zeichen und
// ein Füllzeichen. Bewusst genau diese Form und nicht „irgendetwas ohne
// Zeilenumbruch": ein Schlüssel mit einem Leerzeichen darin wird von WireGuard
// abgelehnt, und das fiele erst beim Hochfahren des Sidecars auf — dort, wo
// niemand mehr an einen Datensatz im Hub denkt.
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

// Eine IPv4-Adresse ohne Präfix, ohne führende Nullen. Führende Nullen liest
// je nach Werkzeug jemand oktal — eine zweideutige Adresse wird abgelehnt und
// nicht ausgelegt (gleiche Regel wie in config.ts).
const IPV4_PATTERN = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/;

// Ein Name landet in einer Kommentarzeile. Alles, was eine Zeile beenden oder
// einen Terminal-Ausgabestrom umlenken könnte, ist damit unzulässig: C0, DEL
// und die beiden Zeilentrenner aus Unicode, die manche Leser ebenfalls als
// Umbruch werten.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

// Ein Name, der länger ist als eine Terminalzeile, ist kein Name mehr. Die
// Grenze ist großzügig; sie soll nur verhindern, dass ein einzelner Datensatz
// die Datei unlesbar macht.
const MAX_NAME_LENGTH = 200;

function checkKey(value: string, field: string): string {
  if (!KEY_PATTERN.test(value)) {
    throw new WireGuardConfigError(
      `${field} ist kein WireGuard-Schlüssel. Erwartet werden 44 Zeichen Base64, wie sie „wg genkey" erzeugt.`
    );
  }
  return value;
}

function checkOctets(value: string, field: string, raw: string): void {
  for (const part of value.split(".")) {
    if (Number(part) > 255) {
      throw new WireGuardConfigError(`${field} ist keine IPv4-Adresse: „${raw}".`);
    }
  }
}

function checkTunnelAddress(value: string): string {
  if (!IPV4_PATTERN.test(value)) {
    throw new WireGuardConfigError(
      `tunnelAddress ist keine IPv4-Adresse ohne Präfix: „${value}". Erwartet wird etwas wie 10.254.0.2.`
    );
  }
  checkOctets(value, "tunnelAddress", value);
  return value;
}

function checkHubAddress(value: string): string {
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || prefix === undefined || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) {
    throw new WireGuardConfigError(
      `address ist keine IPv4-Adresse mit Präfix: „${value}". Erwartet wird etwas wie 10.254.0.1/24.`
    );
  }
  if (!IPV4_PATTERN.test(address)) {
    throw new WireGuardConfigError(`address ist keine IPv4-Adresse mit Präfix: „${value}".`);
  }
  checkOctets(address, "address", value);
  return value;
}

function checkName(value: string): string {
  if (CONTROL_PATTERN.test(value)) {
    throw new WireGuardConfigError(
      "name enthält ein Steuerzeichen. In einer Kommentarzeile der wg0.conf wäre ein Zeilenumbruch der Anfang " +
        "einer eigenen Anweisung — ein Arm könnte sich darüber Rechte im Tunnel geben, die ihm niemand gegeben hat."
    );
  }
  if (value.trim().length === 0) {
    throw new WireGuardConfigError("name ist leer. Ein Peer ohne Namen ist in der Datei nicht zuzuordnen.");
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new WireGuardConfigError(`name ist länger als ${MAX_NAME_LENGTH} Zeichen (${value.length}).`);
  }
  return value;
}

function checkPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new WireGuardConfigError(`listenPort ist keine gültige Portnummer: „${String(value)}".`);
  }
  return value;
}

// Nach Zahlenwert, nicht nach Text: `10.254.0.10` steht hinter `10.254.0.9`
// und nicht davor. Eine Textsortierung sähe im Test mit zwei Armen richtig aus
// und würfelte die Datei erst ab dem zehnten Arm durcheinander — und ein
// Diff, der bei jedem Schreiben anders ausfällt, kostet den Betreiber die
// einzige Möglichkeit zu sehen, was sich geändert hat.
function addressValue(address: string): number {
  const octets = address.split(".").map(Number);
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

/**
 * Erzeugt den vollständigen Inhalt einer `wg0.conf` für die Hub-Seite.
 *
 * Die Peers stehen nach ihrer Tunneladresse sortiert; `hosts` darf in jeder
 * Reihenfolge kommen. Doppelte Adressen oder doppelte Schlüssel werden
 * abgelehnt: WireGuard nähme den zweiten Block stillschweigend nicht an, und
 * ein Arm wäre dann angelegt, sichtbar und nicht erreichbar.
 */
export function renderWireGuardConfig(hub: WireGuardHub, hosts: readonly WireGuardPeer[]): string {
  const lines: string[] = [
    "# Erzeugt vom Hub. Änderungen von Hand gehen beim nächsten Schreiben verloren.",
    "[Interface]",
    `PrivateKey = ${checkKey(hub.privateKey, "privateKey")}`,
    `Address = ${checkHubAddress(hub.address)}`,
    `ListenPort = ${checkPort(hub.listenPort)}`
  ];

  const peers = [...hosts]
    .map((peer) => ({
      publicKey: checkKey(peer.publicKey, "publicKey"),
      tunnelAddress: checkTunnelAddress(peer.tunnelAddress),
      name: checkName(peer.name)
    }))
    .sort((left, right) => addressValue(left.tunnelAddress) - addressValue(right.tunnelAddress));

  const seenAddresses = new Set<string>();
  const seenKeys = new Set<string>();
  for (const peer of peers) {
    if (seenAddresses.has(peer.tunnelAddress)) {
      throw new WireGuardConfigError(`Die Tunneladresse ${peer.tunnelAddress} ist zweimal vergeben.`);
    }
    if (seenKeys.has(peer.publicKey)) {
      throw new WireGuardConfigError(`Zwei Arme teilen sich denselben öffentlichen Schlüssel (${peer.name}).`);
    }
    seenAddresses.add(peer.tunnelAddress);
    seenKeys.add(peer.publicKey);

    lines.push("", `# ${peer.name}`, "[Peer]", `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.tunnelAddress}/32`);
  }

  // Abschließender Zeilenumbruch: eine Datei ohne ihn ist für zeilenweise
  // lesende Werkzeuge eine unvollständige letzte Zeile.
  return `${lines.join("\n")}\n`;
}
