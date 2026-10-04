import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { hasControlOrLineSeparator } from "contract";

import { renderComposeFile } from "./host-archive-compose.js";
import { renderEnvFile } from "./host-archive-env.js";
import { renderReadme } from "./host-archive-readme.js";
import { writeTar, type TarEntry } from "./host-archive-tar.js";
import { renderTunnelConfig } from "./host-archive-wireguard.js";
import type { HostArchiveInput } from "./host-archive-input.js";

export type { HostArchiveInput } from "./host-archive-input.js";

// Der Archiv-Erzeuger (docs/design/phase-4-bootstrap-and-registration.md §5).
//
// Eine reine Funktion: keine Route, kein Listener, kein Zugriff auf die
// Datenbank und kein Schreiben ins Dateisystem. Alles, was das Archiv trägt,
// kommt als Eingabe herein — und alles, was der Agent beim Start prüft, wird
// HIER geprüft, nicht dort.
//
// ⚠️ Das ist der Punkt dieser Datei. Ein Archiv mit einem 20-Zeichen-Secret
// baut sich anstandslos, lädt sich anstandslos herunter und ergibt auf dem
// Zielhost einen Agenten, der mit einer Fehlermeldung gar nicht erst startet —
// gefunden von jemandem, der neben dem Server steht und diesen Code nicht hat.
// Deshalb wirft der Erzeuger, statt ein kaputtes Archiv zu liefern.

const gzipAsync = promisify(gzip);

// Die Mindestlänge stammt aus dashboard-docker-agent@v0.18.1, src/config.ts:
// der Agent lehnt kürzere Werte für BEIDE Geheimnisse beim Start ab.
const MIN_SECRET_LENGTH = 32;

// 0600 für die beiden Dateien mit Geheimnissen, 0644 für den Rest. Der Modus
// steht IM Archiv: `tar -xzf` übernimmt ihn, und damit hängt der Schutz nicht
// an der umask dessen, der entpackt.
const MODE_SECRET = 0o600;
const MODE_PLAIN = 0o644;

export const ARCHIVE_FILE_NAMES = ["docker-compose.yml", ".env", "wg0.conf", "README.md"] as const;

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

// Dieselbe Rechnung wie `ipv4InCidr` im Agenten. Sie steht hier nach, weil der
// Agent sie beim Start anwendet: was er dort ablehnt, soll hier gar nicht erst
// in ein Archiv geraten.
function inCidr(address: string, cidr: string): boolean {
  const [network, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const addressNumber = ipv4ToNumber(address);
  const networkNumber = ipv4ToNumber(network ?? "");
  if (addressNumber === null || networkNumber === null) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
  return (addressNumber & mask) >>> 0 === (networkNumber & mask) >>> 0;
}

function check(input: HostArchiveInput): void {
  // Second guard behind `createHost`: name, path and endpoint end up in comment
  // lines and copyable commands of every file below. Records from before that
  // rule fail here instead of shipping an injected line. The message leaves the
  // name out on purpose.
  if (hasControlOrLineSeparator(input.host.name)) {
    throw new Error("Archiv nicht erzeugt: der Hostname enthält ein Steuerzeichen.");
  }
  if (input.host.bindBasePath !== null && hasControlOrLineSeparator(input.host.bindBasePath)) {
    throw new Error(`Archiv für „${input.host.name}" nicht erzeugt: der Basispfad enthält ein Steuerzeichen.`);
  }
  if (hasControlOrLineSeparator(input.hub.endpoint)) {
    throw new Error(`Archiv für „${input.host.name}" nicht erzeugt: der Endpoint enthält ein Steuerzeichen.`);
  }
  const fail = (message: string): never => {
    throw new Error(`Archiv für „${input.host.name}" nicht erzeugt: ${message}`);
  };

  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(input.hub.tunnelCidr) || ipv4ToNumber(input.hub.tunnelCidr.split("/")[0]) === null) {
    fail(`hub.tunnelCidr ist kein IPv4-Netz: „${input.hub.tunnelCidr}"`);
  }
  if (!inCidr(input.host.tunnelAddress, input.hub.tunnelCidr)) {
    fail(`die Tunneladresse ${input.host.tunnelAddress} liegt nicht in ${input.hub.tunnelCidr}`);
  }
  if (!inCidr(input.hub.hubAddress, input.hub.tunnelCidr)) {
    fail(`die Hub-Adresse ${input.hub.hubAddress} liegt nicht in ${input.hub.tunnelCidr}`);
  }
  if (input.hub.hubAddress === input.host.tunnelAddress) {
    fail("Hub und Arm hätten dieselbe Tunneladresse");
  }
  if (input.agent.secret.length < MIN_SECRET_LENGTH) {
    fail(`DOCKER_AGENT_SECRET hat ${input.agent.secret.length} statt mindestens ${MIN_SECRET_LENGTH} Zeichen`);
  }
  if (input.registration.token.length < MIN_SECRET_LENGTH) {
    fail(
      `DOCKER_AGENT_REGISTRATION_TOKEN hat ${input.registration.token.length} statt mindestens ${MIN_SECRET_LENGTH} Zeichen`
    );
  }

  let url: URL;
  try {
    url = new URL(input.registration.url);
  } catch {
    return fail(`registration.url ist keine URL: „${input.registration.url}"`);
  }
  // Beides prüft der Agent ebenfalls, und beides ist unsichtbar, solange
  // niemand ein Archiv auf einem echten Host auspackt: bei `https` hält er mit
  // der Meldung an, der Anmelde-Endpunkt sei per http anzusprechen, bei einer
  // Adresse außerhalb des Tunnelnetzes mit der, er müsse darin liegen.
  if (url.protocol !== "http:") {
    fail(`die Anmelde-URL muss http sein, nicht „${url.protocol}"`);
  }
  if (!inCidr(url.hostname, input.hub.tunnelCidr)) {
    fail(`die Anmelde-URL zeigt auf ${url.hostname} und damit nicht in ${input.hub.tunnelCidr}`);
  }
  if (!input.agent.image.includes(":")) {
    fail(`das Agent-Image ist nicht gepinnt: „${input.agent.image}"`);
  }
  if (input.agent.image.endsWith(":latest")) {
    fail("das Agent-Image steht auf :latest — ein fließender Stand hat keinen Punkt, auf den man zurückgeht");
  }
  // Ohne Port endet der Endpoint in wg-quick als „Invalid endpoint", und zwar
  // erst auf dem Zielhost. Der Auflöser des Hubs hängt den Port an; fehlt er
  // hier, ist der Wert an einer Stelle vorbeigelaufen, die es tun sollte.
  if (!/]:\d+$/.test(input.hub.endpoint) && !/^[^:[]+:\d+$/.test(input.hub.endpoint)) {
    fail(`der Endpoint trägt keinen Port: „${input.hub.endpoint}"`);
  }
  if (!Number.isInteger(input.agent.port) || input.agent.port < 1 || input.agent.port > 65535) {
    fail(`agent.port ist keine Portnummer: ${input.agent.port}`);
  }
}

/**
 * Das herunterladbare Archiv eines Arms als gzip-komprimierter tar-Strom.
 *
 * `Promise<Buffer>` und nicht `Buffer`: gzip ist in Node asynchron, und eine
 * synchrone Fassung hielte den Ereignisstrom für die Dauer der Kompression an.
 */
export async function buildHostArchive(input: HostArchiveInput): Promise<Buffer> {
  check(input);
  const entries: TarEntry[] = [
    { name: "docker-compose.yml", content: renderComposeFile(input), mode: MODE_PLAIN },
    { name: ".env", content: renderEnvFile(input), mode: MODE_SECRET },
    { name: "wg0.conf", content: renderTunnelConfig(input), mode: MODE_SECRET },
    { name: "README.md", content: renderReadme(input), mode: MODE_PLAIN }
  ];
  // Der private Schlüssel steht an genau EINER Stelle. Die Zusage ist billig
  // zu geben und teuer zu halten: eine Vorlage, die ihn zur Bequemlichkeit
  // zusätzlich in die `.env` schreibt, sieht in keinem Diff verdächtig aus.
  const occurrences = entries.reduce(
    (total, entry) => total + entry.content.split(input.agent.privateKey).length - 1,
    0
  );
  if (occurrences !== 1) {
    throw new Error(`Der private Schlüssel steht an ${occurrences} Stellen des Archivs statt an genau einer`);
  }
  return gzipAsync(writeTar(entries, Math.floor(Date.now() / 1000)));
}
