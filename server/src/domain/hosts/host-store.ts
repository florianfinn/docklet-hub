import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { agentUpdateOffer } from "./self-update.js";
import { isAgentOutdated, speaksAgentContract } from "./version.js";
import type { AgentHealth } from "./health.js";
import type { TunnelNetwork } from "../../platform/config/config.js";
import type { HostThemePreset, HostView, HueName, InkName } from "contract";
import { ARM_AGENT_IMAGE } from "./arm-agent-image.js";
import {
  hashRegistrationToken,
  isValidDockerGid,
  normalizeBindBasePath,
  normalizeTunnelAddress,
  MAX_REGISTRATION_ATTEMPTS,
  MIN_REGISTRATION_TOKEN_LENGTH,
  type HostKind,
  type HostRecord,
  type HostState,
  type HostStatus
} from "./host-record.js";

// Der Weg zur Tabelle `docker_host` — und sonst nichts.
//
// Alles, was hier steht, ist SQL über den bestehenden Pool. Keine zweite
// Bibliothek, kein Abbild des Schemas neben der Migrationsfolge: die Folge ist
// der Ort der Wahrheit (AGENTS.md, „Datenbank").
//
// ⚠️ Zwei Bauarten in dieser Datei sind gegen Wettläufe gebaut und dürfen
// nicht in „lesen, dann schreiben" zurückfallen — beide Fehler kämen grün
// durch jeden Test, der einen Aufrufer nach dem anderen laufen lässt:
//
//   1. Die Vergabe der Tunneladresse. Die freie Adresse wird gesucht, aber
//      NICHT reserviert; entschieden wird sie vom eindeutigen Index beim
//      INSERT. Zwei gleichzeitige Anleger bekommen dieselbe Adresse
//      vorgeschlagen, einer läuft in den Index und sucht erneut.
//   2. Das Verbrauchen des Anmelde-Tokens. EINE Anweisung, die den Zustand
//      prüft und umschaltet. Ein SELECT davor wäre ein Fenster, in dem
//      dasselbe Token zweimal gilt.

export type { HostKind, HostRecord, HostState, HostStatus };

// Die Spalten, in denen ein Datensatz nach draußen geht.
//
// ⚠️ `agent_secret` und `token_hash` stehen hier NICHT und gehören auch nicht
// dazu. Der Grund steht in host-record.ts: ein Feld, das nicht am Objekt
// hängt, kann nicht versehentlich in eine Antwort geraten.
//
// `host(tunnel_address)` und nicht `tunnel_address`: `inet` reist sonst mit
// Präfixlänge („10.254.0.2/32"), und der Vergleich gegen eine Quell-IP wäre
// eine Zeichenkette gegen eine andere Schreibweise derselben Adresse.
const HOST_COLUMNS = `id,
          name,
          agent_url,
          kind,
          state,
          host(tunnel_address) AS tunnel_address,
          wireguard_public_key,
          endpoint_override,
          failed_attempts,
          docker_gid,
          bind_base_path,
          hue,
          ink,
          created_at,
          registered_at,
          last_seen_at`;

type HostRow = {
  id: string;
  name: string;
  agent_url: string;
  kind: HostKind;
  state: HostState;
  tunnel_address: string | null;
  wireguard_public_key: string | null;
  endpoint_override: string | null;
  failed_attempts: number;
  docker_gid: number | null;
  bind_base_path: string | null;
  hue: HueName;
  ink: InkName;
  created_at: Date;
  registered_at: Date | null;
  last_seen_at: Date | null;
};

function toRecord(row: HostRow): HostRecord {
  return {
    id: row.id,
    name: row.name,
    agentUrl: row.agent_url,
    kind: row.kind,
    state: row.state,
    tunnelAddress: row.tunnel_address,
    wireguardPublicKey: row.wireguard_public_key,
    endpointOverride: row.endpoint_override,
    failedAttempts: Number(row.failed_attempts),
    // Zwei Spalten, ein Feld: die Oberfläche liest „die Darstellung dieses
    // Arms" und nicht zwei lose Werte.
    display: { hue: row.hue, ink: row.ink },
    // Postgres liefert `integer` als Zahl; die Umwandlung steht trotzdem da,
    // weil `null` sonst zu 0 würde — und 0 ist hier ein gültiger Wert.
    dockerGid: row.docker_gid === null ? null : Number(row.docker_gid),
    bindBasePath: row.bind_base_path,
    createdAt: row.created_at,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at
  };
}

// Warum ein eigener Fehler statt einer Zeichenkette: der Aufrufer in Welle 3
// muss aus dem Ergebnis einen Antwortcode machen (409 für einen vergebenen
// Namen, 507 für ein volles Netz). An einer Meldung ließe sich das nur über
// deren Text festmachen — und Texte werden umformuliert.
export type HostErrorReason = "name-taken" | "address-pool-exhausted" | "invalid-input";

export class HostError extends Error {
  constructor(
    readonly reason: HostErrorReason,
    message: string
  ) {
    super(message);
    this.name = "HostError";
  }
}

// Der Port, auf dem ein Agent im Tunnel lauscht, solange er nichts anderes
// meldet. Er wird bei der Anmeldung durch den Wert ersetzt, den der Agent
// selbst nennt (`listenPort`).
const DEFAULT_AGENT_PORT = 8099;

// Wie oft die Vergabe der Tunneladresse bei einer Kollision neu ansetzt.
//
// Fünf reichen mit Abstand: eine Kollision entsteht nur, wenn zwei Anleger im
// selben Sekundenbruchteil dieselbe freie Adresse vorgeschlagen bekommen.
// Unbegrenzt zu wiederholen wäre die falsche Antwort auf ein volles Netz — das
// meldet sich hier als eigener Fehler und nicht als Endlosschleife.
const ADDRESS_ATTEMPTS = 5;

export async function listHostRecords(pool: Pool): Promise<HostRecord[]> {
  const { rows } = await pool.query<HostRow>(
    // Der lokale Host zuerst: er ist der, der immer da ist, und die Liste
    // soll nicht davon abhängen, wann welcher Arm angebunden wurde.
    `SELECT ${HOST_COLUMNS}
       FROM docker_host
      ORDER BY (kind = 'local') DESC, name`
  );
  return rows.map(toRecord);
}

export async function findHost(pool: Pool, id: string): Promise<HostRecord | null> {
  const { rows } = await pool.query<HostRow>(`SELECT ${HOST_COLUMNS} FROM docker_host WHERE id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Findet den Host, dem eine Tunneladresse gehört.
 *
 * Der erste Schritt des Anmeldewegs: die Quell-IP der Anfrage muss die
 * Adresse sein, die dieser Hub genau diesem Arm vergeben hat. Wer aus dem
 * Tunnel unter einer anderen Adresse kommt, ist kein bekannter Arm.
 *
 * ⚠️ Eine Adresse, die sich nicht normalisieren lässt, ergibt `null` und
 * keinen Datenbankfehler. Der Rohwert erreicht Postgres nie — `'x'::inet`
 * wirft dort, und der Anmeldeweg antwortete dann mit 500 statt mit einer
 * Ablehnung.
 */
export async function findHostByTunnelAddress(pool: Pool, address: string): Promise<HostRecord | null> {
  const normalized = normalizeTunnelAddress(address);
  if (!normalized) return null;
  const { rows } = await pool.query<HostRow>(
    `SELECT ${HOST_COLUMNS} FROM docker_host WHERE tunnel_address = $1::inet`,
    [normalized]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Das Agent-Secret eines Hosts — einzeln und auf Zuruf.
 *
 * ⚠️ Bewusst NICHT Teil von `HostRecord`. Wer diese Funktion aufruft, hat sich
 * dafür entschieden; wer einen Datensatz in eine Antwort schreibt, kann das
 * Secret nicht versehentlich mitschicken (host-record.ts).
 *
 * `null` für den lokalen Host: dessen Secret steht in der Umgebung
 * (`DOCKER_AGENT_SECRET`) und nicht in der Tabelle.
 */
export async function readHostAgentSecret(pool: Pool, id: string): Promise<string | null> {
  const { rows } = await pool.query<{ agent_secret: string | null }>(
    `SELECT agent_secret FROM docker_host WHERE id = $1`,
    [id]
  );
  return rows[0]?.agent_secret ?? null;
}

/**
 * Sucht die niedrigste freie Adresse im Tunnelnetz.
 *
 * ⚠️ Das Ergebnis ist ein VORSCHLAG, keine Reservierung. Zwischen dieser
 * Abfrage und dem INSERT liegt ein Fenster, in dem ein zweiter Anleger
 * dieselbe Adresse bekommt. Entschieden wird die Vergabe vom eindeutigen
 * Index (004-host-enrollment.sql); `createHost` sucht danach erneut.
 *
 * Gerechnet wird in SQL und nicht im Speicher: `MAX(addr) + 1` über eine
 * gelesene Liste wäre nicht nur derselbe Wettlauf, es ließe auch jede Lücke
 * ungenutzt, die ein entfernter Arm hinterlässt.
 */
async function nextFreeTunnelAddress(pool: Pool, network: TunnelNetwork): Promise<string | null> {
  const { rows } = await pool.query<{ address: string }>(
    `SELECT host($1::inet + step::bigint) AS address
       FROM generate_series($2::int, $3::int) AS step
      WHERE NOT EXISTS (
              SELECT 1 FROM docker_host WHERE tunnel_address = ($1::inet + step::bigint)
            )
      ORDER BY step
      LIMIT 1`,
    [network.networkAddress, network.firstArmOffset, network.lastArmOffset]
  );
  return rows[0]?.address ?? null;
}

// Ein Konflikt genau am eindeutigen Index der Tunneladresse — und nicht am
// Namen. Beide melden 23505; nur der eine ist ein Wettlauf, den eine
// Wiederholung löst. Der andere ist ein vergebener Name, und den löst keine
// Wiederholung, sondern eine andere Eingabe.
function conflictConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23505") return null;
  return typeof candidate.constraint === "string" ? candidate.constraint : "";
}

export type CreateHostInput = {
  name: string;
  kind: Exclude<HostKind, "local">;
  // Der Hub erzeugt das Schlüsselpaar des Arms; hier kommt nur der öffentliche
  // Teil an. Der private liegt im Archiv und nirgends sonst.
  wireguardPublicKey: string;
  agentSecret: string;
  // Das Klartext-Token. Gespeichert wird ausschließlich sein Abdruck.
  registrationToken: string;
  // Die beiden Werte des Zielhosts (008-host-setup.sql). Pflicht und nicht
  // optional: ein Vorgabewert an dieser Stelle wäre ein zweiter Ort, an dem
  // steht, was ohne Eingabe gilt — und ein Arm mit geratener Gruppen-ID
  // startet auf dem Zielhost nicht. Der lokale Host läuft nicht hier durch.
  dockerGid: number;
  bindBasePath: string;
  endpointOverride?: string | null;
  agentPort?: number;
};

/**
 * Legt einen Arm an — mit der nächsten freien Tunneladresse.
 *
 * Der Datensatz entsteht im Zustand `pending`: das Archiv ist erzeugt, der
 * Agent hat sich noch nicht gemeldet. Sichtbar ist der Host trotzdem sofort,
 * denn ein Arm, der beim Betreiber auf dem Schreibtisch liegt, ist ein Stand
 * und kein Nichts.
 */
export async function createHost(
  pool: Pool,
  network: TunnelNetwork,
  input: CreateHostInput
): Promise<HostRecord> {
  const name = input.name.trim();
  if (!name) throw new HostError("invalid-input", "Der Name des Hosts fehlt.");
  if (input.registrationToken.length < MIN_REGISTRATION_TOKEN_LENGTH) {
    throw new HostError(
      "invalid-input",
      `Das Anmelde-Token ist zu kurz (${input.registrationToken.length} Zeichen, mindestens ${MIN_REGISTRATION_TOKEN_LENGTH}). ` +
        "Der Agent lehnt einen kürzeren Wert auf seiner Seite ebenfalls ab."
    );
  }
  if (input.agentSecret.length < MIN_REGISTRATION_TOKEN_LENGTH) {
    throw new HostError(
      "invalid-input",
      `Das Agent-Secret ist zu kurz (${input.agentSecret.length} Zeichen, mindestens ${MIN_REGISTRATION_TOKEN_LENGTH}). ` +
        "Der Agent startet mit einem kürzeren Wert nicht."
    );
  }
  if (!input.wireguardPublicKey.trim()) {
    throw new HostError("invalid-input", "Der öffentliche WireGuard-Schlüssel des Arms fehlt.");
  }
  const agentPort = input.agentPort ?? DEFAULT_AGENT_PORT;
  if (!Number.isInteger(agentPort) || agentPort < 1 || agentPort > 65535) {
    throw new HostError("invalid-input", `„${String(agentPort)}" ist keine gültige Portnummer für den Agenten.`);
  }
  // ⚠️ Über `isValidDockerGid` und nicht über den Wahrheitswert: 0 ist die
  // Gruppe root und auf manchem Host die richtige Antwort.
  if (!isValidDockerGid(input.dockerGid)) {
    throw new HostError(
      "invalid-input",
      `„${String(input.dockerGid)}" ist keine Gruppen-ID. Erwartet wird die Zahl, die ` +
        "`stat -c %g /var/run/docker.sock` auf dem Zielhost nennt."
    );
  }
  const bindBasePath = normalizeBindBasePath(input.bindBasePath);
  if (bindBasePath === null) {
    throw new HostError(
      "invalid-input",
      `„${String(input.bindBasePath)}" taugt nicht als Basispfad. Erwartet wird ein absoluter Pfad ohne ` +
        "Leerzeichen, ohne Doppelpunkt und ohne `..` als Abschnitt. `/` selbst ist ausgeschlossen: es " +
        "schaltet die Schranke des Agenten gegen beliebige Bind-Mounts ab."
    );
  }

  const tokenHash = hashRegistrationToken(input.registrationToken);

  for (let attempt = 1; attempt <= ADDRESS_ATTEMPTS; attempt += 1) {
    const address = await nextFreeTunnelAddress(pool, network);
    if (!address) {
      throw new HostError(
        "address-pool-exhausted",
        `Im Tunnelnetz ${network.cidr} ist keine Adresse mehr frei. Entfernte Arme geben ihre Adresse wieder frei.`
      );
    }

    try {
      const { rows } = await pool.query<HostRow>(
        `INSERT INTO docker_host (
           id, name, agent_url, kind, tunnel_address, wireguard_public_key,
           agent_secret, token_hash, state, endpoint_override,
           docker_gid, bind_base_path
         )
         VALUES ($1, $2, $3, $4, $5::inet, $6, $7, $8, 'pending', $9, $10, $11)
         RETURNING ${HOST_COLUMNS}`,
        [
          randomUUID(),
          name,
          `http://${address}:${agentPort}`,
          input.kind,
          address,
          input.wireguardPublicKey.trim(),
          input.agentSecret,
          tokenHash,
          input.endpointOverride?.trim() || null,
          input.dockerGid,
          bindBasePath
        ]
      );
      return toRecord(rows[0]);
    } catch (error) {
      const constraint = conflictConstraint(error);
      if (constraint === "docker_host_name_key") {
        throw new HostError("name-taken", `Ein Host mit dem Namen „${name}" ist bereits eingetragen.`);
      }
      // Nur die Adresse ist eine Wiederholung wert. Alles andere geht durch.
      if (constraint !== "docker_host_tunnel_address_key" || attempt === ADDRESS_ATTEMPTS) throw error;
    }
  }

  // Nach ADDRESS_ATTEMPTS Kollisionen in Folge stimmt etwas anderes nicht als
  // die Gleichzeitigkeit. Lieber ein Fehler als eine Schleife.
  throw new HostError(
    "address-pool-exhausted",
    `Die Tunneladresse ließ sich in ${ADDRESS_ATTEMPTS} Versuchen nicht vergeben.`
  );
}

export type RotateHostInput = {
  // Der neue öffentliche Schlüssel des Arms. Der private liegt im neuen Archiv
  // und nirgends sonst — auch der alte war hier nie gespeichert.
  wireguardPublicKey: string;
  agentSecret: string;
  registrationToken: string;
  agentPort?: number;
};

/**
 * Erneuert Schlüssel, Secret und Token eines Arms — in EINER Anweisung.
 *
 * Das ist die Datenbankseite von „ein Archiv herunterladen" (§4 des Entwurfs):
 * jeder Aufruf rotiert, weil der Hub den privaten Schlüssel nicht hat und
 * dasselbe Paket kein zweites Mal ausliefern kann. Der Datensatz geht dabei
 * auf `pending` zurück, der Fehlzähler auf null — das ist zugleich der einzige
 * Weg aus der Sperre aus Bedingung 7.
 *
 * ⚠️ Eine Anweisung und kein „lesen, prüfen, schreiben": zwei gleichzeitige
 * Aufrufe erzeugen sonst zwei Archive, von denen beide behaupten, das gültige
 * zu sein. So gewinnt der zweite UPDATE sichtbar — sein Abdruck steht danach
 * in der Zeile, und das Token des ersten ist tot, noch bevor sein Archiv beim
 * Betreiber ankommt.
 *
 * ⚠️ `registered_at` wird geleert. Ein Arm, der sein Archiv neu bekommt, ist
 * nicht mehr angemeldet, und ein stehengebliebener Zeitpunkt wäre eine Aussage
 * über eine Anmeldung, die es nicht mehr gibt.
 *
 * `null` heißt: es gibt keinen solchen Arm (unbekannt oder lokal). Der
 * Aufrufer macht daraus 404 bzw. 409 — hier wird das nicht unterschieden,
 * weil die Unterscheidung eine Abfrage davor ist und nicht diese hier.
 */
export async function rotateHostCredentials(
  pool: Pool,
  id: string,
  input: RotateHostInput
): Promise<HostRecord | null> {
  if (input.registrationToken.length < MIN_REGISTRATION_TOKEN_LENGTH) {
    throw new HostError(
      "invalid-input",
      `Das Anmelde-Token ist zu kurz (${input.registrationToken.length} Zeichen, mindestens ${MIN_REGISTRATION_TOKEN_LENGTH}).`
    );
  }
  if (input.agentSecret.length < MIN_REGISTRATION_TOKEN_LENGTH) {
    throw new HostError(
      "invalid-input",
      `Das Agent-Secret ist zu kurz (${input.agentSecret.length} Zeichen, mindestens ${MIN_REGISTRATION_TOKEN_LENGTH}).`
    );
  }
  if (!input.wireguardPublicKey.trim()) {
    throw new HostError("invalid-input", "Der öffentliche WireGuard-Schlüssel des Arms fehlt.");
  }
  const agentPort = input.agentPort ?? DEFAULT_AGENT_PORT;
  if (!Number.isInteger(agentPort) || agentPort < 1 || agentPort > 65535) {
    throw new HostError("invalid-input", `„${String(agentPort)}" ist keine gültige Portnummer für den Agenten.`);
  }

  const { rows } = await pool.query<HostRow>(
    `UPDATE docker_host
        SET wireguard_public_key = $2,
            agent_secret         = $3,
            token_hash           = $4,
            state                = 'pending',
            failed_attempts      = 0,
            registered_at        = NULL,
            agent_url            = 'http://' || host(tunnel_address) || ':' || $5::int,
            updated_at           = now()
      WHERE id    = $1
        AND kind <> 'local'
      RETURNING ${HOST_COLUMNS}`,
    [
      id,
      input.wireguardPublicKey.trim(),
      input.agentSecret,
      hashRegistrationToken(input.registrationToken),
      agentPort
    ]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export type RegistrationClaim = {
  hostId: string;
  // Das Klartext-Token aus der Kopfzeile `x-docker-host-registration`.
  token: string;
  // Die Quell-IP der Anfrage.
  sourceAddress: string;
  // Der Port, den der Agent für sich selbst meldet.
  listenPort: number;
};

/**
 * Verbraucht das Anmelde-Token und schaltet den Host auf `registered`.
 *
 * ⚠️ EINE Anweisung. Nicht „prüfen, dann setzen" — zwei Anmeldungen mit
 * demselben Token kämen dabei beide durch, weil beide dieselbe `pending`-Zeile
 * sehen. Hier entscheidet die WHERE-Bedingung, und Postgres serialisiert die
 * beiden UPDATEs auf derselben Zeile: der zweite findet `state = 'registered'`
 * und trifft nichts. Kein Treffer heißt abgelehnt.
 *
 * ⚠️ Der Vergleich läuft auf dem SHA-256-Abdruck und nicht auf dem Token. Das
 * Klartext-Token erreicht die Datenbank nie — auch nicht in einem Logeintrag
 * über eine langsame Anfrage.
 *
 * Die Quelladresse steht bewusst mit in der Bedingung, obwohl der Aufrufer sie
 * schon geprüft hat: eine Prüfung, die man vergessen kann, ist eine Prüfung,
 * die irgendwann vergessen wird. Für die Antwortcodes bleibt die frühere
 * Prüfung zuständig — hier ist sie der Riegel, nicht die Begründung.
 *
 * `agent_url` wird aus der Tunneladresse und dem gemeldeten Port gebaut, nicht
 * aus dem gemeldeten `listenHost`: der ist auf einem frisch aufgesetzten Arm
 * regelmäßig `0.0.0.0`, und selbst wenn nicht, wäre er eine Angabe der
 * Gegenseite darüber, wo der Hub sie zu suchen hat.
 */
export async function consumeRegistrationToken(
  pool: Pool,
  claim: RegistrationClaim
): Promise<HostRecord | null> {
  const source = normalizeTunnelAddress(claim.sourceAddress);
  if (!source) return null;
  if (!Number.isInteger(claim.listenPort) || claim.listenPort < 1 || claim.listenPort > 65535) return null;
  if (!claim.token) return null;

  const { rows } = await pool.query<HostRow>(
    `UPDATE docker_host
        SET state           = 'registered',
            token_hash      = NULL,
            registered_at   = now(),
            updated_at      = now(),
            failed_attempts = 0,
            agent_url       = 'http://' || host(tunnel_address) || ':' || $4::int
      WHERE id              = $1
        AND kind           <> 'local'
        AND state           = 'pending'
        AND token_hash      = $2
        AND tunnel_address  = $3::inet
        AND failed_attempts < $5
      RETURNING ${HOST_COLUMNS}`,
    [claim.hostId, hashRegistrationToken(claim.token), source, claim.listenPort, MAX_REGISTRATION_ATTEMPTS]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Zählt einen Fehlversuch der Anmeldung und meldet den neuen Stand.
 *
 * Ab `MAX_REGISTRATION_ATTEMPTS` nimmt `consumeRegistrationToken` das Token
 * nicht mehr an — die Sperre steht in der WHERE-Bedingung dort und nicht hier,
 * damit sie nicht davon abhängt, ob jemand vorher nachgezählt hat.
 */
export async function recordFailedRegistration(pool: Pool, hostId: string): Promise<number | null> {
  const { rows } = await pool.query<{ failed_attempts: number }>(
    `UPDATE docker_host
        SET failed_attempts = failed_attempts + 1,
            updated_at      = now()
      WHERE id    = $1
        AND kind <> 'local'
      RETURNING failed_attempts`,
    [hostId]
  );
  return rows[0] ? Number(rows[0].failed_attempts) : null;
}

/**
 * Setzt Farbton und Farbeinsatz eines Arms.
 *
 * ⚠️ AUCH FÜR DEN LOKALEN ARM. Er ist der Arm, der immer da ist, und der
 * Betreiber färbt ihn wie jeden anderen; die Ausnahmen `kind <> 'local'` in
 * dieser Datei stehen für Dinge, die den Tunnel betreffen, und die Farbe
 * betrifft ihn nicht.
 *
 * Der Wert kommt als `HostThemePreset` herein und nicht als Zeichenkette: die
 * Prüfung gegen `THEME_KNOBS` liegt vor dieser Funktion (`platform/theme/knob-input.ts`)
 * und nicht in ihr — genau wie bei `writeUserLanguage`.
 *
 * `null` heißt: es gibt keinen Arm mit dieser Kennung. Der Aufrufer macht
 * daraus einen 404.
 */
export async function setHostDisplay(
  pool: Pool,
  id: string,
  display: HostThemePreset
): Promise<HostRecord | null> {
  const { rows } = await pool.query<HostRow>(
    `UPDATE docker_host
        SET hue        = $2,
            ink        = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING ${HOST_COLUMNS}`,
    [id, display.hue, display.ink]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Entfernt einen Arm. Der lokale Host lässt sich nicht entfernen: er entstünde
 * beim nächsten Start ohnehin wieder, und dazwischen wäre der Hub blind für
 * den Host, auf dem er selbst läuft.
 *
 * Idempotent: ein zweiter Aufruf meldet `false`, nicht einen Fehler.
 */
export async function removeHost(pool: Pool, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM docker_host WHERE id = $1 AND kind <> 'local'`, [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * Hält fest, dass der Agent eines Arms gerade geantwortet hat.
 *
 * ⚠️ `updated_at` bleibt stehen: es sagt, wann der DATENSATZ zuletzt geändert
 * wurde, und ein Arm, der jede Minute antwortet, hätte sonst nie einen
 * erkennbaren Zeitpunkt seiner letzten echten Änderung.
 *
 * Gibt den geschriebenen Zeitpunkt zurück, `null` für einen Arm, den es nicht
 * mehr gibt.
 */
export async function markHostSeen(pool: Pool, id: string): Promise<Date | null> {
  const { rows } = await pool.query<{ last_seen_at: Date }>(
    `UPDATE docker_host SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at`,
    [id]
  );
  return rows[0]?.last_seen_at ?? null;
}

/**
 * Trägt den lokalen Host ein oder gleicht ihn mit der Umgebung ab.
 *
 * Läuft bei jedem Start. Das ist der Punkt: Adresse und Name des lokalen
 * Agenten stehen in der `.env`, und wer sie dort ändert, hat sie geändert —
 * eine Zeile in der Datenbank, die dann noch die alte trägt, wäre ein zweiter
 * Ort der Wahrheit und gewönne im Zweifel.
 *
 * ⚠️ Der eindeutige Index aus 003-hosts.sql lässt genau einen lokalen Host zu.
 * Deshalb hängt der Abgleich an `kind = 'local'` und nicht am Namen: wer den
 * Namen in der `.env` ändert, benennt den bestehenden Host um, statt einen
 * zweiten anzulegen.
 */
export async function ensureLocalHost(
  pool: Pool,
  local: { name: string; agentUrl: string }
): Promise<HostRecord> {
  // EINE Anweisung, nicht Lesen-dann-Schreiben: zwei gleichzeitig startende
  // Hub-Instanzen sähen sonst beide keine Zeile und legten beide eine an. Die
  // zweite liefe in den eindeutigen Index aus 003-hosts.sql — und ein Hub, der
  // beim Start an einem Index scheitert, sieht für den Betreiber aus wie ein
  // kaputtes Schema.
  //
  // `registered_at` steht mit im INSERT, weil 004 von einem registrierten
  // Datensatz einen Zeitpunkt verlangt. Der lokale Host meldet sich nie an;
  // sein Zeitpunkt ist der seines Eintrags.
  const { rows } = await pool.query<HostRow>(
    `INSERT INTO docker_host (id, name, agent_url, kind, state, registered_at)
     VALUES ($1, $2, $3, 'local', 'registered', now())
     ON CONFLICT (kind) WHERE kind = 'local'
     DO UPDATE SET name = EXCLUDED.name, agent_url = EXCLUDED.agent_url, updated_at = now()
     RETURNING ${HOST_COLUMNS}`,
    [randomUUID(), local.name, local.agentUrl]
  );
  return toRecord(rows[0]);
}

/**
 * Der Zustand, den die Oberfläche anzeigt.
 *
 * ⚠️ Die Reihenfolge der Fälle ist die Aussage:
 *
 *   `pending`  schlägt alles. Ein Arm, dessen Archiv noch beim Betreiber
 *              liegt, ist nicht „offline" — sein Agent existiert noch nicht.
 *   `offline`  vor `outdated`. Wer nicht antwortet, hat keine Version genannt;
 *              ihn „zu alt" zu nennen, wäre eine Behauptung über etwas, das
 *              der Hub nicht gesehen hat.
 *   `outdated` bei fehlender Version. Das ist der Fall, den kein Test von
 *              selbst zeigt: ein Agent vor v0.7.0 meldet gar keine, ein
 *              kaputtes Image meldet „unbekannt". Beides ist „zu alt" und
 *              nicht „in Ordnung" (domain/hosts/version.ts).
 */
export function deriveHostStatus(input: {
  state: HostState;
  reachable: boolean;
  agentVersion: string | null;
  // The protocol number the agent named in `/health` (#278).
  contractVersion: number | null;
}): HostStatus {
  if (input.state === "pending") return "pending";
  if (!input.reachable) return "offline";
  return isAgentOutdated(input.agentVersion) || !speaksAgentContract(input.contractVersion) ? "outdated" : "online";
}

// What every host route hands out per host. Explicitly enumerated in
// `toHostView` and not poured together from the record: an enumeration does
// not grow by itself when the table gains a column.
//
// The shape is the schema `hostViewSchema` in `contract/src/api/hosts.ts`
// (#247); the web parses every host list against it. The meaning of each
// field stands there.
export type { HostView };

export function toHostView(record: HostRecord, health: AgentHealth | null): HostView {
  const reachable = health?.reachable === true;
  const agentVersion = health?.reachable === true ? health.version : null;
  const contractVersion = health?.reachable === true ? health.contractVersion : null;
  return {
    id: record.id,
    name: record.name,
    agentUrl: record.agentUrl,
    kind: record.kind,
    state: record.state,
    status: deriveHostStatus({ state: record.state, reachable, agentVersion, contractVersion }),
    agentVersion,
    tunnelAddress: record.tunnelAddress,
    display: record.display,
    agentUpdate: record.kind === "local" || !reachable ? null : agentUpdateOffer(agentVersion, ARM_AGENT_IMAGE),
    lastSeenAt: record.lastSeenAt === null ? null : record.lastSeenAt.toISOString()
  };
}
