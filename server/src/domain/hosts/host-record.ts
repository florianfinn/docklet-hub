import { createHash, timingSafeEqual } from "node:crypto";

import type { HostKind, HostState, HostStatus, HostThemePreset } from "contract";

// Der Datensatz eines Hosts — die Form, in der der Rest des Hubs ihn sieht.
//
// Eigene Datei und nicht in host-store.ts, weil zwei verschiedene Dinge daran
// hängen: host-store.ts ist der Weg zur Datenbank, hier steht die Form. Welle 2
// baut den Archiv-Erzeuger und den wg0.conf-Renderer gegen diese Form, ohne
// den Pool zu kennen (docs/design/phase-4-bootstrap-and-registration.md).
//
// ⚠️ WAS HIER BEWUSST NICHT DRIN STEHT: das Agent-Secret und der Token-Abdruck.
//
// Beide stehen in der Tabelle, aber nicht in diesem Typ. Der Grund ist ein
// Fehler, den kein Test fängt: `response.json({ host })` in einer Route ist
// eine Zeile, die richtig aussieht — und wenn das Secret am Objekt hängt,
// steht es danach im Browser. Ein Feld, das nicht existiert, kann nicht
// verrutschen. Wer das Secret braucht, holt es sich einzeln
// (`readHostAgentSecret`) und trägt damit sichtbar die Verantwortung dafür.

// Kind, state and status are literals of the contract (`contract/src/api/hosts.ts`,
// #247): all three travel to the web inside every host view, and the web
// checks them there. The reasons for each value stand next to the schemas.
export type { HostKind, HostState, HostStatus };

export type HostRecord = {
  id: string;
  name: string;
  agentUrl: string;
  kind: HostKind;
  state: HostState;
  // Nur der lokale Host hat keine: er steht im Compose-Netz.
  tunnelAddress: string | null;
  wireguardPublicKey: string | null;
  endpointOverride: string | null;
  failedAttempts: number;
  // Die Darstellung dieses Arms: sein Farbton und die Stufe des Farbeinsatzes
  // (D0 §6, zwei Spalten in `docker_host` seit 006-hub-theme.sql).
  //
  // ⚠️ PFLICHTFELD und nicht optional. In der Tabelle stehen beide Spalten
  // NOT NULL mit Vorgabe; ein optionales Feld hier hätte einen Vorgabewert im
  // TypeScript nach sich gezogen — also einen zweiten Ort, an dem steht, was
  // gilt, wenn nichts gesetzt ist. Der eine Ort ist das `DEFAULT` der Spalte.
  display: HostThemePreset;
  // Die zwei Werte, die dem ZIELHOST gehören und die dieser Hub nicht
  // ermitteln kann (008-host-setup.sql): die Gruppe seines Docker-Sockets und
  // der Pfad, unterhalb dessen seine Compose-Projekte liegen. Sie gehen
  // ausschließlich in das erzeugte Archiv.
  //
  // ⚠️ Beide NULLABLE, anders als `display` oben. Der lokale Host hat sie
  // nicht — seine Werte stehen in der .env des Hub-Stacks —, und ein Arm aus
  // der Zeit vor 008 hat sie auch nicht. Der Archiv-Erzeuger unterscheidet
  // deshalb zwei Fälle, statt sich auf einen Vorgabewert zu verlassen.
  //
  // ⚠️ `0` ist eine gültige Gruppen-ID. Jede Prüfung auf Wahrheitswert statt
  // auf `null` verschluckt den Host, dessen Socket root gehört.
  dockerGid: number | null;
  bindBasePath: string | null;
  createdAt: Date;
  registeredAt: Date | null;
  // Wann der Agent zuletzt auf eine Sonde geantwortet hat (013-host-last-seen.sql).
  // `null`: seit dieser Spalte noch nie.
  lastSeenAt: Date | null;
};

// Wie oft eine Anmeldung für denselben Host scheitern darf, bevor der Hub das
// Token gar nicht mehr annimmt.
//
// Die Zahl kommt von der Gegenseite und ist nicht frei gewählt: der Agent
// rechnet in seinem Backoff mit zwölf Versuchen je Viertelstunde
// (bootstrap-registration.ts, v0.18.1). Wer tiefer setzt, sperrt einen Arm
// aus, dessen Tunnel beim ersten Versuch noch nicht stand; wer höher setzt,
// macht das Token ratbarer, als es sein muss.
//
// ⚠️ Die Sperre ist endgültig, nicht ein Zeitfenster. Der Weg zurück ist ein
// neues Archiv — und damit ein neues Token, ein neues Secret und ein neues
// Schlüsselpaar. Ein Zeitfenster wäre eine Sperre, die von selbst aufgeht.
export const MAX_REGISTRATION_ATTEMPTS = 12;

// Der Agent lehnt ein kürzeres Token auf seiner Seite ab
// (`DOCKER_AGENT_REGISTRATION_TOKEN`, min. 32 Zeichen, v0.18.1). Die Marke
// steht hier noch einmal, weil ein zu kurzes Token sonst erst auf dem
// Zielhost auffiele — beim Start des Agenten, also an der Stelle, an der
// niemand den Hub verdächtigt.
export const MIN_REGISTRATION_TOKEN_LENGTH = 32;

/**
 * Der Abdruck, der in der Datenbank steht.
 *
 * Das Token selbst liegt ausschließlich im Archiv. In der Tabelle steht nur
 * SHA-256 davon: wer die Datenbank liest, kann damit keinen Arm anmelden.
 *
 * Kein Salz und keine Schlüsselstreckung, und das ist Absicht — beides
 * schützt gegen Raten, und geraten wird hier nichts: das Token ist ein
 * gewürfelter Wert von mindestens 32 Zeichen und lebt genau eine Anmeldung
 * lang. Eine langsame Ableitung machte den Anmeldeweg langsam, ohne etwas zu
 * gewinnen.
 */
export function hashRegistrationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Vergleicht zwei Geheimnisse in konstanter Zeit.
 *
 * ⚠️ Für das Anmelde-Token wird diese Funktion NICHT gebraucht: dessen
 * Vergleich läuft in der Datenbank, und zwar auf dem SHA-256-Abdruck innerhalb
 * derselben Anweisung, die den Zustand umschaltet (host-store.ts,
 * `consumeRegistrationToken`). Ein zeitabhängiger Vergleich auf einem Abdruck
 * gibt nichts preis, was sich zurückrechnen ließe, und die Atomarität wiegt
 * hier schwerer als die Zeitgleichheit.
 *
 * Gebraucht wird sie dort, wo ein Geheimnis im Prozess verglichen wird —
 * allen voran das Agent-Secret in der Gegenprobe der Welle 2. `===` auf
 * Zeichenketten bricht beim ersten ungleichen Zeichen ab und verrät damit,
 * wie weit der Angreifer gekommen ist.
 *
 * Verglichen wird über den Abdruck und nicht über die Rohwerte: sonst müsste
 * die Funktion bei ungleicher Länge vorzeitig zurückkehren, und genau das ist
 * wieder ein Zeitunterschied — nur einer über die Länge.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Prüft eine Gruppen-ID, wie `stat -c %g /var/run/docker.sock` sie liefert.
 *
 * ⚠️ `0` ist gültig und der Grund, aus dem diese Funktion existiert: auf einem
 * Host, der Docker als root fährt, gehört der Socket `root:root`. Ein
 * `if (!gid)` an einer der drei Stellen — Formular, Route, Speicher — hätte
 * genau diesen Host abgewiesen, und zwar mit der Meldung, die Angabe fehle.
 */
export function isValidDockerGid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Bringt den Basispfad in die Form, in der er in das Paket darf — oder gibt
 * `null` zurück, wenn er es nicht ist.
 *
 * ⚠️ Der Wert landet im Archiv UNMASKIERT in einer Volume-Zeile
 * (`- ${DOCKER_AGENT_BIND_BASE_PATH}:${DOCKER_AGENT_BIND_BASE_PATH}`). Ein
 * Doppelpunkt darin ergibt drei Felder statt zweier, ein Leerzeichen zerlegt
 * die Zeile — und beides fällt erst auf dem fremden Host beim `compose up`
 * auf, mit einer Meldung über YAML statt über dieses Feld.
 *
 * ⚠️ `/` wird abgewiesen, und das ist eine Entscheidung und kein Versehen: der
 * Basispfad IST die Schranke des Agenten gegen beliebige Bind-Mounts, und `/`
 * schaltet sie ab. Ein Hub, der ein Paket ausliefert, in dem diese Schranke
 * offen steht, ohne es zu sagen, wäre schlimmer als einer, der den Wert nicht
 * anbietet. Wer ihn wirklich will, trägt ihn auf dem Zielhost selbst ein.
 */
export function normalizeBindBasePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate.startsWith("/")) return null;
  if (/[\s:]/.test(candidate)) return null;
  // `..` als eigener Abschnitt — `/mnt/..data` ist ein gewöhnlicher Name.
  if (candidate.split("/").includes("..")) return null;
  const trimmed = candidate.replace(/\/+$/, "");
  // Leer bleibt nur, was `/` oder `//` war.
  return trimmed === "" ? null : trimmed;
}

// Eine IPv4-Adresse in Punktschreibweise, ohne führende Nullen. Führende
// Nullen sind ausgeschlossen, weil sie je nach Werkzeug oktal gelesen werden:
// „010.254.0.2" ist für manche 8.254.0.2 und für andere 10.254.0.2.
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Bringt eine Quelladresse in die Form, in der sie mit einer Tunneladresse
 * vergleichbar ist — oder sagt, dass sie es nicht ist.
 *
 * ⚠️ Der Fall, wegen dem es diese Funktion gibt: Node liefert die Gegenstelle
 * eines Sockets auf einem dual-stack-Listener als IPv4-abgebildete
 * IPv6-Adresse — `::ffff:10.254.0.2`. Das ist dieselbe Adresse und trotzdem
 * eine andere Zeichenkette; ein Vergleich gegen `10.254.0.2` scheitert, und
 * die Anmeldung jedes Arms scheiterte mit „unbekannte Quelle". In einer
 * Prüfumgebung fällt das nicht auf, weil dort niemand über einen echten
 * Socket kommt.
 *
 * Gibt `null` zurück, wenn nichts Vergleichbares übrig bleibt. Der Aufrufer
 * lehnt dann ab, statt den Rohwert an Postgres zu reichen — `'irgendwas'::inet`
 * wirft dort, und ein 500 auf dem Anmeldeweg sagt dem Aufrufer mehr über den
 * Hub, als er wissen muss.
 */
export function normalizeTunnelAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (candidate.startsWith("[") && candidate.endsWith("]")) {
    candidate = candidate.slice(1, -1);
  }
  // Auch in Großschreibung: `::FFFF:10.254.0.2` ist dieselbe Adresse.
  const mapped = /^::ffff:(.+)$/i.exec(candidate);
  if (mapped) candidate = mapped[1];

  const match = IPV4_PATTERN.exec(candidate);
  if (!match) return null;
  const parts = match.slice(1, 5);
  for (const part of parts) {
    if (part.length > 1 && part.startsWith("0")) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
  }
  return parts.join(".");
}
