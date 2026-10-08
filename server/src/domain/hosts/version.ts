import { CONTRACT_VERSION } from "contract";

// Minimum agent implementation for writable operations. Protocol compatibility
// is checked separately; the archive image follows the hub release version.
// Older image repositories require a manual image-reference change.
export const MIN_AGENT_VERSION = "0.32.0";

export type AgentVersion = readonly [number, number, number];

// `x.y.z`, optional mit vorangestelltem `v` und optionalem Vorabsuffix. Der
// Agent liefert die nackte Form aus seiner package.json ("0.18.1"); das `v`
// steht in den Git-Tags und rutscht erfahrungsgemäß irgendwann in eine
// Meldung.
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Liest `x.y.z` — oder sagt, dass da nichts Lesbares steht.
 *
 * ⚠️ `null` ist ein echtes Ergebnis und kein Fehlerfall. Der Agent meldet
 * „unbekannt", wenn er seine eigene package.json nicht lesen kann
 * (`version.ts` im Agent-Repo, v0.18.1), und ein Agent vor v0.7.0 meldete gar
 * kein Feld. Beides muss hier ankommen, statt zu werfen.
 */
export function parseAgentVersion(value: string | null | undefined): AgentVersion | null {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

/**
 * Vergleicht zwei Fassungen: negativ, wenn `a` älter ist als `b`.
 *
 * ⚠️ Verglichen werden ZAHLEN, nicht Zeichenketten. Der Fehler, den das
 * verhindert, sieht bis zum ersten zweistelligen Minor richtig aus:
 * `"0.9.0" > "0.18.1"` ist als Text wahr und als Version falsch — und der
 * Hub hielte damit jeden aktuellen Agenten für neu genug.
 */
export function compareAgentVersions(a: AgentVersion, b: AgentVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Ist dieser Agent zu alt für diesen Hub?
 *
 * ⚠️ Fail closed: eine fehlende, leere oder unlesbare Angabe ist „zu alt" und
 * nicht „unbekannt, also erlaubt". Das ist der Unterschied, den kein Test in
 * einer Prüfumgebung von selbst zeigt — dort meldet der eingespeiste Agent
 * immer eine Version. Im Betrieb meldet ein Agent vor v0.7.0 gar keine, und
 * ein kaputtes Image meldet „unbekannt"; beides sind genau die Fälle, für die
 * die Schreibsperre gebaut ist.
 *
 * Ein Vorabstand derselben Fassung (0.24.0-rc.1) gilt als diese Fassung. Das
 * ist bewusst großzügig: wer eine Vorabversion ausrollt, hat sie ausgewählt.
 */
export function isAgentOutdated(version: string | null | undefined): boolean {
  const parsed = parseAgentVersion(version);
  if (!parsed) return true;
  const minimum = parseAgentVersion(MIN_AGENT_VERSION);
  // Kann nicht eintreten — steht als Zusicherung da, damit ein Tippfehler in
  // der Marke oben hier auffällt, statt jeden Agenten durchzulassen.
  if (!minimum) throw new Error(`MIN_AGENT_VERSION ist keine Version: „${MIN_AGENT_VERSION}".`);
  return compareAgentVersions(parsed, minimum) < 0;
}

/**
 * Does an agent with this protocol number speak this hub's protocol?
 *
 * ⚠️ THE SECOND MARK, NEXT TO `MIN_AGENT_VERSION`, and it measures something
 * else: the software version says which release runs, the contract number
 * which values travel (docs/design/feature-architecture.md, section 6). Since
 * #278 every value is English (contract 6), and a hub of this state does not
 * understand an agent that still sends the German ones — not even one built
 * from this repository before #278 under the same version 0.32.0.
 *
 * Fail closed like the version: a missing number is "too old".
 */
export function speaksAgentContract(contractVersion: number | null | undefined): boolean {
  return typeof contractVersion === "number" && contractVersion >= CONTRACT_VERSION;
}

// Ab welcher Fassung der Agent fremdverwaltete Container als eigene Klasse
// kennt (`externallyManaged`, `dashboard-docker-agent#78`, v0.31.0).
//
// ⚠️ DAS IST KEINE ZWEITE MINDESTMARKE, sondern eine Weiche im Abgleich. Ein
// älterer Agent kennt das Feld nicht, legt es stillschweigend ab und behandelt
// den Eintrag als gewöhnlich erlaubten Container — `pull`, `recreate` und
// `remove` stünden an einem Unraid-Container offen, genau das, was #20
// ausschließt. Unter dieser Fassung trägt der Abgleich fremdverwaltete deshalb
// weiter gar nicht ein. Die Mindestmarke oben zu heben hätte dagegen jeden Arm
// bis zu seinem Update rot und schreibgesperrt gemacht, für eine Gruppe, die
// ohnehin nur eine Anzeige ist.
export const EXTERNALLY_MANAGED_AGENT_VERSION = "0.31.0";

/** Kennt ein Agent dieser Fassung `externallyManaged`? Unlesbar heißt nein. */
export function supportsExternallyManaged(version: string | null | undefined): boolean {
  const parsed = parseAgentVersion(version);
  const minimum = parseAgentVersion(EXTERNALLY_MANAGED_AGENT_VERSION);
  if (!parsed || !minimum) return false;
  return compareAgentVersions(parsed, minimum) >= 0;
}
