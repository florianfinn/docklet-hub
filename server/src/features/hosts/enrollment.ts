import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { CONTRACT_VERSION, hasControlOrLineSeparator, hostNameProblem } from "contract";

import {
  ARM_AGENT_IMAGE,
  HostError,
  isAgentOutdated,
  MIN_AGENT_VERSION,
  normalizeBindBasePath,
  normalizeExternalEndpoint,
  probeAgent,
  speaksAgentContract,
  type HostKind,
  type HostRecord,
  type HostRepository
} from "../../domain/hosts/index.js";
import { buildHostArchive } from "./bootstrap/host-archive.js";
import { renderWireGuardConfig, type WireGuardPeer } from "./bootstrap/wireguard-config.js";
import { writeWireGuardConfig } from "./bootstrap/wireguard-config-writer.js";
import { generateWireGuardKeyPair, publicKeyFromPrivate } from "./bootstrap/wireguard-keys.js";
import { ConfigError, isUnreachableFromOutside, resolveWireguardEndpoint, type Config } from "../../platform/config/config.js";
import { REGISTRATION_ROUTE, type RegistrationDeps, type RegistrationHost } from "./registration-app.js";

// Die Verdrahtung: aus drei Bausteinen wird ein Ablauf.
//
// Welle 2 hat den Archiv-Erzeuger, den wg0.conf-Renderer und die
// Registrierungs-App gebaut — jeden für sich, ohne Datenbank und ohne
// Netz (docs/design/phase-4-bootstrap-and-registration.md §5). Hier laufen sie
// zusammen: Host anlegen → Peer-Liste schreiben → Archiv erzeugen; Archiv neu
// erzeugen; Host entfernen.
//
// ⚠️ Vier Reihenfolgen in dieser Datei sind die Aussage, und jede falsche
// davon kommt grün durch jeden Test, der die geschriebene Datei nicht liest:
//
//   1. Der Endpoint wird aufgelöst, BEVOR der Datensatz entsteht. Sonst
//      hinterließe die Meldung „HUB_WIREGUARD_ENDPOINT fehlt“ (§4) einen
//      angelegten Arm, den niemand bestellt hat.
//   2. Die Peer-Liste wird geschrieben, BEVOR das Archiv herausgeht. Ein Arm
//      ohne `[Peer]`-Block im Sidecar erreicht den Hub nie — seine Anmeldung
//      kann gar nicht ankommen, und in der Oberfläche steht er trotzdem.
//   3. Beim Erneuern gilt dasselbe: ohne neuen Schrieb behält der Sidecar den
//      ALTEN öffentlichen Schlüssel, das neue Archiv paßt nicht dazu, und
//      keine Zeile in irgendeinem Log nennt den Grund.
//   4. Beim Entfernen wird die Liste NACH dem Löschen geschrieben — sie
//      entsteht vollständig aus der Datenbank, nie aus einer Differenz.
//
// ⚠️ Und ein Port, der still falsch sein kann: `ListenPort` in der wg0.conf
// des Hubs ist der Port INNERHALB des Sidecar-Containers (51821 aus der
// docker-compose.yml), nicht `config.wireguardPort`. Der ist der
// VERÖFFENTLICHTE Port auf dem Host und steht im Endpoint, den ein Arm
// anwählt. Beide dürfen auseinanderlaufen, und sobald ein Betreiber
// HUB_WIREGUARD_PORT ändert, tun sie das auch.

/**
 * Der Port innerhalb des Sidecar-Containers.
 *
 * ⚠️ Er steht in der docker-compose.yml rechts vom Doppelpunkt
 * (`"${HUB_WIREGUARD_PORT:-51821}:51821/udp"`) und ist damit unabhängig von
 * dem, was der Betreiber veröffentlicht. `enrollment.test.ts` gleicht beide
 * Stellen ab — ein Auseinanderlaufen wäre ein Tunnel, der nie zustande kommt.
 */
export const SIDECAR_LISTEN_PORT = 51821;

/**
 * Der Port, auf dem der Agent eines Arms lauscht, bis er bei seiner Anmeldung
 * etwas anderes meldet. Er steht in der `.env` des Archivs und in der
 * `agent_url` des frisch angelegten Datensatzes.
 */
export const ARM_AGENT_PORT = 8099;

// 32 Byte Zufall, base64url — 43 Zeichen und damit über der Marke von 32, die
// beide Seiten erzwingen. `base64url` statt `base64`, weil der Wert in einer
// `.env`-Zeile und in einer Kopfzeile steht: `+`, `/` und `=` sind dort zwar
// zulässig, aber jedes Werkzeug dazwischen darf sie anders lesen.
const SECRET_BYTES = 32;

export type EnrollmentConfig = Pick<
  Config,
  | "wireguardEndpoint"
  | "wireguardPort"
  | "wireguardConfigPath"
  | "tunnelPort"
  | "hubWireguardPrivateKey"
  | "hubWireguardPublicKey"
  | "tunnel"
>;

/**
 * Ein Arm, den es so nicht gibt.
 *
 * Eigene Klasse, weil der Aufrufer daraus einen Antwortcode macht (§4): 404
 * für unbekannt, 409 für den lokalen Host. An einer Meldung ließe sich das nur
 * über deren Text festmachen, und Texte werden umformuliert.
 */
export type EnrollmentErrorReason = "host-unknown" | "host-is-local" | "endpoint-unreachable" | "host-record-invalid";

export class EnrollmentError extends Error {
  constructor(
    readonly reason: EnrollmentErrorReason,
    message: string
  ) {
    super(message);
    this.name = "EnrollmentError";
  }
}

export type EnrollHostInput = {
  name: string;
  kind: Exclude<HostKind, "local">;
  // Die zwei Werte des Zielhosts. Sie gehen unverändert an `createHost`
  // durch, das sie prüft — geprüft wird an einer Stelle und nicht an dreien.
  dockerGid: number;
  bindBasePath: string;
  endpointOverride?: string | null;
};

export type EnrolledHost = {
  record: HostRecord;
  // Der gzip-komprimierte tar-Strom. Er trägt den privaten Schlüssel, das
  // Agent-Secret und das Einmal-Token — er gehört in genau eine Antwort und in
  // keine Zwischenablage, kein Log und keinen Cache.
  archive: Buffer;
};

export type EnrollmentOptions = {
  repository: HostRepository;
  config: EnrollmentConfig;
  // Einspeisbar für den Test; im Regelweg `console.warn`.
  warn?: (message: string) => void;
  /**
   * Die Adresse, unter der dieser Hub VON AUSSEN erreichbar ist (`hub_network`).
   *
   * ⚠️ Als Funktion und nicht als Wert: sie wird bei JEDER Archiverzeugung neu
   * gelesen. `GET /hosts/:id/archive` erzeugt das Paket jedes Mal frisch, und
   * zwischen dem Anlegen eines Arms und dem nächsten Abruf seines Archivs kann
   * der Betreiber die Adresse längst berichtigt haben. Ein beim Start
   * gelesener Wert lieferte dann weiter die alte — und zwar wortlos.
   *
   * ⚠️ Vorgabe `null` und nicht der Wert aus der Umgebung: „nicht eingetragen"
   * muss bis zu `resolveWireguardEndpoint` durchfallen, damit dort die
   * Reihenfolge entscheidet.
   */
  readExternalEndpoint?: () => Promise<string | null>;
};

export type Enrollment = {
  enrollHost: (input: EnrollHostInput) => Promise<EnrolledHost>;
  regenerateArchive: (hostId: string) => Promise<EnrolledHost>;
  removeHost: (hostId: string) => Promise<void>;
  writeHubWireGuardConfig: () => Promise<void>;
};

function randomSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/**
 * Das Schlüsselpaar der Hub-Seite — vollständig und zueinander passend.
 *
 * ⚠️ Der Vergleich ist der Punkt. Der private Teil steht in der wg0.conf des
 * Sidecars, der öffentliche in JEDEM Archiv; passen sie nicht zusammen, kommt
 * der Tunnel zustande wie geplant und überträgt nichts. Weder `wg-quick` noch
 * der Agent melden dazu etwas — beide Seiten sehen einen gültigen Schlüssel.
 */
function resolveHubKeys(config: EnrollmentConfig): { privateKey: string; publicKey: string } {
  const privateKey = config.hubWireguardPrivateKey;
  const publicKey = config.hubWireguardPublicKey;
  if (!privateKey || !publicKey) {
    throw new ConfigError(
      "HUB_WIREGUARD_PRIVATE_KEY und HUB_WIREGUARD_PUBLIC_KEY fehlen. Ohne sie hat die Hub-Seite des Tunnels " +
        "keine Identität: der Sidecar bekommt keine wg0.conf und ein Arm kein Archiv. scripts/bootstrap.sh " +
        "würfelt das Paar einmalig in die .env neben der docker-compose.yml."
    );
  }
  if (publicKeyFromPrivate(privateKey) !== publicKey) {
    throw new ConfigError(
      "HUB_WIREGUARD_PRIVATE_KEY und HUB_WIREGUARD_PUBLIC_KEY gehören nicht zusammen. Der Tunnel käme damit " +
        "zustande und überträgte nichts — kein Werkzeug auf einer der beiden Seiten meldet dazu etwas. " +
        "Beide Zeilen stammen aus einem Lauf von scripts/bootstrap.sh."
    );
  }
  return { privateKey, publicKey };
}

export function createEnrollment({
  repository,
  config,
  warn = console.warn,
  readExternalEndpoint = async () => null
}: EnrollmentOptions): Enrollment {
  // Schreibvorgänge auf die Peer-Liste werden gereiht — und zwar EINSCHLIESSLICH
  // der Abfrage, aus der sie entsteht.
  //
  // ⚠️ Der Schreiber selbst reiht bereits (wireguard-config-writer.ts), das
  // genügt hier aber nicht: zwischen „Arme lesen“ und „Datei schreiben“ liegt
  // sonst ein Fenster, in dem ein zweiter Anleger seinen Arm einträgt und
  // schreibt — und der erste überschreibt dessen Peer danach mit seinem
  // älteren Stand. Der zweite Arm wäre angelegt, sichtbar und nicht im
  // Tunnel; nichts daran meldet sich von selbst. Innerhalb dieser Reihung
  // liegt die Abfrage IMMER hinter dem vorangegangenen Schreibvorgang.
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    // `catch` auf der Vorgängerin: ein gescheiterter Lauf darf den nächsten
    // nicht mitreißen — sein Fehler ist bei seinem eigenen Aufrufer bereits
    // angekommen.
    const next = queue.catch(() => undefined).then(task);
    queue = next;
    return next;
  }

  async function writeHubWireGuardConfig(): Promise<void> {
    const keys = resolveHubKeys(config);
    return serialize(async () => {
      const records = await repository.list();
      const peers: WireGuardPeer[] = [];
      for (const record of records) {
        // Der lokale Host steht im Compose-Netz und nicht im Tunnel.
        if (record.kind === "local") continue;
        // ⚠️ Ausstehende Arme kommen MIT in die Liste. Ohne ihren Peer-Eintrag
        // gäbe es keinen Weg, auf dem ihre Anmeldung je ankommen könnte — sie
        // blieben für immer „pending“, und der Grund stünde nirgends.
        if (!record.tunnelAddress || !record.wireguardPublicKey) {
          // Kann die Datenbank so nicht liefern (004-host-enrollment.sql,
          // `docker_host_arm_check`). Wenn doch, wird der Arm übersprungen und
          // laut genannt — ein Abbruch nähme alle anderen Arme mit aus dem
          // Tunnel.
          warn(
            `[wireguard] Arm „${record.name}“ (${record.id}) hat keine Tunneladresse oder keinen Schlüssel und ` +
              "steht deshalb nicht in der Peer-Liste."
          );
          continue;
        }
        peers.push({
          publicKey: record.wireguardPublicKey,
          tunnelAddress: record.tunnelAddress,
          name: record.name
        });
      }

      const content = renderWireGuardConfig(
        {
          privateKey: keys.privateKey,
          address: `${config.tunnel.hubAddress}/${config.tunnel.prefixLength}`,
          // ⚠️ Der Port im Container, nicht der veröffentlichte.
          listenPort: SIDECAR_LISTEN_PORT
        },
        peers
      );

      // Unverändert heißt: nicht anfassen. Der Sidecar vergleicht Inode,
      // Zeitstempel und Größe; ein Schreibvorgang mit demselben Inhalt hätte
      // trotzdem einen neuen Inode und löste ein `wg syncconf` aus. Das ist
      // für sich harmlos und bei jedem Start des Hubs unnötig.
      const current = await readFile(config.wireguardConfigPath, "utf8").catch(() => null);
      if (current === content) return;

      await writeWireGuardConfig(config.wireguardConfigPath, content);
    });
  }

  async function buildArchive(
    record: HostRecord,
    secrets: { agentSecret: string; registrationToken: string; privateKey: string },
    hubPublicKey: string
  ): Promise<Buffer> {
    if (record.kind === "local" || !record.tunnelAddress) {
      throw new EnrollmentError(
        "host-is-local",
        `Für „${record.name}“ gibt es kein Archiv: der lokale Agent steht im Compose-Stack, nicht im Tunnel.`
      );
    }
    // MIT Port. `resolveWireguardEndpoint` hängt ihn an, wenn der Wert selbst
    // keinen trägt; ohne Port endet der Endpoint auf dem Zielhost in „Invalid
    // endpoint" — und zwar erst dort.
    //
    // ⚠️ Die externe Adresse wird NUR für Arme der Art `external` gereicht. Ein
    // interner Arm steht im selben Netz wie der Hub; ihm eine DynDNS-Adresse zu
    // geben hieße, seinen Tunnel über das Internet und die eigene Portfreigabe
    // zu führen, statt über zwei Meter Kabel — er liefe, und niemand sähe es.
    const endpoint = resolveWireguardEndpoint(
      config,
      record.endpointOverride,
      record.kind === "external" ? await readExternalEndpoint() : null
    );
    return buildHostArchive({
      host: {
        id: record.id,
        name: record.name,
        kind: record.kind,
        tunnelAddress: record.tunnelAddress,
        // Aus dem DATENSATZ und nicht aus der Eingabe: `regenerateArchive`
        // hat keine Eingabe, und ein zweites Archiv muss dieselben Werte
        // tragen wie das erste (008-host-setup.sql).
        dockerGid: record.dockerGid,
        bindBasePath: record.bindBasePath
      },
      hub: {
        endpoint,
        publicKey: hubPublicKey,
        tunnelCidr: config.tunnel.cidr,
        hubAddress: config.tunnel.hubAddress
      },
      agent: {
        image: ARM_AGENT_IMAGE,
        port: ARM_AGENT_PORT,
        secret: secrets.agentSecret,
        privateKey: secrets.privateKey
      },
      registration: {
        // Der Pfad ist eine Entscheidung des Hubs und keine des Agenten (§2);
        // er kommt deshalb aus der Route der App und nicht aus einer zweiten
        // Zeichenkette, die man einzeln ändern kann.
        url: `http://${config.tunnel.hubAddress}:${config.tunnelPort}${REGISTRATION_ROUTE.replace(":hostId", record.id)}`,
        token: secrets.registrationToken
      }
    });
  }

  /**
   * Löst den Endpoint dieses Arms auf und weist ihn ab, wenn er nachweislich
   * nicht ankommen kann.
   *
   * ⚠️ WARUM ABWEISEN UND NICHT NUR WARNEN. Das Archiv gibt es nach Bauart
   * genau einmal; ein zweiter Abruf rotiert alles. Ein Paket mit einer privaten
   * Adresse im `Endpoint` ist auf einem fremden Rechner nicht zu retten — der
   * Betreiber entpackt es, startet den Stack, wartet, und die einzige Spur ist
   * ein Handshake, der nie kommt. Die Frage gehört deshalb VOR die Erzeugung,
   * wie schon die nach der Gruppen-ID (008).
   *
   * ⚠️ NUR für `external`, und nur bei einem BEWEIS. `isUnreachableFromOutside`
   * prüft literale Adressen; ein Name gilt als erreichbar, weil dieser Hub
   * nicht weiß, worauf er zeigt. Ein interner Arm wird gar nicht geprüft — für
   * ihn ist die private Adresse des Hubs genau die richtige.
   *
   * Wer es trotzdem so will — ein Overlay, in dem eine private Adresse stimmt —,
   * trägt sie am Arm selbst als Override ein: dann ist es eine Entscheidung und
   * kein Versehen.
   */
  async function requireUsableEndpoint(
    kind: HostKind,
    override: string | null | undefined
  ): Promise<void> {
    const external = kind === "external" ? await readExternalEndpoint() : null;
    // Wirft den ConfigError, wenn überhaupt keine Adresse dasteht.
    const endpoint = resolveWireguardEndpoint(config, override, external);
    // The hub-wide address may come from the .env or a setting stored before
    // today's rule; refused here, before any record or rotation. A leading `-`
    // would read as an option in the README's `nc` check.
    if (hasControlOrLineSeparator(endpoint) || endpoint.startsWith("-")) {
      throw new ConfigError(
        "Die Adresse dieses Hubs enthält ein Steuerzeichen oder beginnt mit „-“. Sie gehört in Einstellungen → Netz " +
          "bzw. in HUB_WIREGUARD_ENDPOINT berichtigt, bevor ein Archiv entsteht."
      );
    }
    if (kind !== "external" || override?.trim()) return;
    if (!isUnreachableFromOutside(endpoint)) return;
    throw new EnrollmentError(
      "endpoint-unreachable",
      `Ein externer Arm bekäme „${endpoint}“ als Adresse dieses Hubs — die ist aus einem fremden Netz nicht ` +
        "erreichbar, und sein Tunnel käme nie zustande. Trage die Adresse ein, unter der dieser Hub von außen " +
        "erreichbar ist (Einstellungen → Netz), oder gib sie beim Anlegen für diesen einen Arm an."
    );
  }

  async function enrollHost(input: EnrollHostInput): Promise<EnrolledHost> {
    if (input.kind !== "internal" && input.kind !== "external") {
      throw new HostError(
        "invalid-input",
        `„${String(input.kind)}“ ist keine Art von Host. Erwartet wird „internal“ oder „external“; ` +
          "„local“ gibt es genau einmal und wird eingetragen, nicht angelegt."
      );
    }
    // ⚠️ VOR dem Datensatz: beide werfen einen ConfigError, und der wird zu
    // einer 400 mit dem Text der Meldung (§4). Ein angelegter Arm neben dieser
    // Meldung wäre eine Zeile, die niemand bestellt hat.
    const hubKeys = resolveHubKeys(config);
    await requireUsableEndpoint(input.kind, input.endpointOverride);

    const keyPair = generateWireGuardKeyPair();
    const agentSecret = randomSecret();
    const registrationToken = randomSecret();

    const record = await repository.create({
      name: input.name,
      kind: input.kind,
      // Nur der öffentliche Teil. Der private verlässt diesen Prozess im
      // Archiv und wird nirgends gespeichert.
      wireguardPublicKey: keyPair.publicKey,
      agentSecret,
      registrationToken,
      dockerGid: input.dockerGid,
      bindBasePath: input.bindBasePath,
      endpointOverride: input.endpointOverride ?? null,
      agentPort: ARM_AGENT_PORT
    });

    // Erst der Peer, dann das Archiv (siehe Kopf dieser Datei).
    await writeHubWireGuardConfig();
    const archive = await buildArchive(
      record,
      { agentSecret, registrationToken, privateKey: keyPair.privateKey },
      hubKeys.publicKey
    );
    return { record, archive };
  }

  async function regenerateArchive(hostId: string): Promise<EnrolledHost> {
    const existing = await requireArm(hostId);
    const hubKeys = resolveHubKeys(config);
    // ⚠️ Auch hier VOR dem Rotieren. `repository.rotate` würfelt Schlüssel,
    // Secret und Token neu und sperrt damit den laufenden Agenten aus; ein
    // Fehler DANACH ließe einen Arm zurück, der weder alt noch neu ist.
    requireValidRecord(existing);
    await requireUsableEndpoint(existing.kind, existing.endpointOverride);

    const keyPair = generateWireGuardKeyPair();
    const agentSecret = randomSecret();
    const registrationToken = randomSecret();

    const record = await repository.rotate(hostId, {
      wireguardPublicKey: keyPair.publicKey,
      agentSecret,
      registrationToken,
      agentPort: ARM_AGENT_PORT
    });
    if (!record) {
      // Zwischen `find` und `rotate` entfernt. Für den Aufrufer dasselbe wie
      // „unbekannt“.
      throw new EnrollmentError("host-unknown", `Den Host ${hostId} gibt es nicht.`);
    }

    // ⚠️ Ohne diesen Schrieb behielte der Sidecar den alten öffentlichen
    // Schlüssel des Arms: das neue Archiv wäre gültig, der Tunnel käme nie
    // zustande, und jeder Test, der die Datei nicht liest, bliebe grün.
    await writeHubWireGuardConfig();
    const archive = await buildArchive(
      record,
      { agentSecret, registrationToken, privateKey: keyPair.privateKey },
      hubKeys.publicKey
    );
    return { record, archive };
  }

  async function removeEnrolledHost(hostId: string): Promise<void> {
    await requireArm(hostId);
    const removed = await repository.remove(hostId);
    // Auch wenn nebenher schon jemand gelöscht hat: die Liste entsteht
    // vollständig aus dem Bestand, und ein Schrieb zuviel ist ein Schrieb
    // ohne Wirkung. Ein ausgelassener wäre ein Peer, der im Tunnel bleibt.
    await writeHubWireGuardConfig();
    if (!removed) {
      throw new EnrollmentError("host-unknown", `Den Host ${hostId} gibt es nicht.`);
    }
  }

  // A record stored before today's input rules would fail while building the
  // archive, after the rotation has already locked the running agent out.
  // Checked before rotating; the message leaves the stored values out.
  function requireValidRecord(record: HostRecord): void {
    const valid =
      hostNameProblem(record.name) === null &&
      (record.bindBasePath === null || normalizeBindBasePath(record.bindBasePath) === record.bindBasePath) &&
      (record.endpointOverride === null || normalizeExternalEndpoint(record.endpointOverride).ok);
    if (!valid) {
      throw new EnrollmentError(
        "host-record-invalid",
        `Der Arm ${record.id} trägt einen Namen, Basispfad oder Endpoint, den das Anlegen heute ablehnt. ` +
          "Ein Archiv dafür entsteht nicht, die Zugangsdaten bleiben unverändert. Den Arm entfernen und neu anlegen."
      );
    }
  }

  async function requireArm(hostId: string): Promise<HostRecord> {
    const record = await repository.find(hostId);
    if (!record) {
      throw new EnrollmentError("host-unknown", `Den Host ${hostId} gibt es nicht.`);
    }
    if (record.kind === "local") {
      throw new EnrollmentError(
        "host-is-local",
        `„${record.name}“ ist der lokale Host: sein Agent steht im Compose-Stack, nicht im Tunnel. ` +
          "Er entstünde beim nächsten Start ohnehin wieder."
      );
    }
    return record;
  }

  return { enrollHost, regenerateArchive, removeHost: removeEnrolledHost, writeHubWireGuardConfig };
}

function toRegistrationHost(record: HostRecord | null): RegistrationHost | null {
  if (!record) return null;
  // Eine Aufzählung und kein Durchreichen: die App bekommt genau die fünf
  // Felder, die ihre Bedingungen brauchen (§5).
  return {
    id: record.id,
    agentUrl: record.agentUrl,
    state: record.state,
    tunnelAddress: record.tunnelAddress,
    failedAttempts: record.failedAttempts
  };
}

export type RegistrationDepsOptions = {
  onRegistered?: (record: HostRecord) => Promise<void>;
  repository: HostRepository;
  log?: (message: string) => void;
  // Einspeisbar, damit der Integrationstest die Gegenprobe gegen einen
  // nachgebauten Agenten laufen lassen kann.
  probe?: typeof probeAgent;
  probeTimeoutMs?: number;
};

/**
 * Die Rückrufe der Registrierungs-App — die eine Stelle, an der die App und
 * der Bestand sich sehen (§5).
 *
 * ⚠️ Die Gegenprobe (Bedingung 9) läuft OHNE das Agent-Secret, und das ist
 * keine Auslassung: `GET /health` liegt beim Agenten ausdrücklich vor der
 * Secret-Prüfung (dashboard-docker-agent v0.18.1, `src/index.ts`, Handler für
 * `/health`: der Endpunkt wird dort vor der Secret-Prüfung beantwortet und
 * nennt die eigene Version). Ein mitgesendetes Secret
 * änderte an der Antwort nichts — es sähe nach einer Prüfung aus, die keine
 * ist. Was die Probe stattdessen belegt, steht in §1, Bedingung 9: unter der
 * VERGEBENEN Tunneladresse antwortet ein Agent, und zwar einer ab der
 * Mindestversion.
 *
 * ⚠️ Geprobt wird gegen `<Quelladresse>:<gemeldeter Port>` — die Adresse, unter
 * der die Anfrage angekommen ist. NICHT gegen `host.agentUrl`: die trägt bei
 * einem ausstehenden Arm noch den Vorgabe-Port und ginge ins Leere, sobald ein
 * Agent auf einem anderen lauscht. Die App baut diese URL; hier steht nur,
 * was daraus folgt.
 */
export function createRegistrationDeps({
  repository,
  log,
  probe = probeAgent,
  probeTimeoutMs = 5_000,
  onRegistered
}: RegistrationDepsOptions): RegistrationDeps {
  return {
    findHostByTunnelAddress: async (address) => toRegistrationHost(await repository.findByTunnelAddress(address)),
    probeAgent: async (baseUrl, hostId) => {
      const health = await probe(baseUrl, { timeoutMs: probeTimeoutMs });
      if (!health.reachable) {
        log?.(`[registration] Gegenprobe: ${hostId} antwortet nicht (${health.error})`);
        return false;
      }
      if (isAgentOutdated(health.version)) {
        // ⚠️ Eine FEHLENDE Version ist „zu alt“ und nicht „unbekannt, also in
        // Ordnung“ (domain/hosts/version.ts). In einer Prüfumgebung meldet jeder
        // eingespeiste Agent brav eine; im Betrieb meldet ein kaputtes Image
        // „unbekannt“.
        log?.(
          `[registration] Gegenprobe: ${hostId} meldet Version „${health.version ?? "keine"}“, ` +
            `verlangt ist ab ${MIN_AGENT_VERSION}`
        );
        return false;
      }
      if (!speaksAgentContract(health.contractVersion)) {
        // An agent that still sends the German values of contract 5 or older
        // is as unusable as one below the version mark (#278).
        log?.(
          `[registration] Gegenprobe: ${hostId} meldet Vertrag ${health.contractVersion ?? "keinen"}, ` +
            `verlangt ist ab ${CONTRACT_VERSION}`
        );
        return false;
      }
      return true;
    },
    consumeToken: async (claim) => {
      const record = await repository.consumeToken(claim);
      if (record) await onRegistered?.(record).catch(() => log?.("Selbstheilungskonfiguration: Übertragung ausstehend."));
      return toRegistrationHost(record);
    },
    recordFailure: async (hostId) => {
      await repository.recordFailure(hostId);
    },
    log
  };
}
