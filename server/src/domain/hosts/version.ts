import { CONTRACT_VERSION } from "contract";

// Welche Fassung des Agenten dieser Hub voraussetzt.
//
// Der Hub trägt eine Mindestversion, der Agent meldet seine im `/health`, und
// ein Host darunter wird rot und schreibgesperrt (#21, concept-and-plan.md §2,
// „Betrieb über die Zeit"). Diese Datei ist der eine Ort, an dem die Marke
// steht — die Schreibsperre der Welle 3 liest sie hier und nicht noch einmal.
//
// Warum ohne Bibliothek: der Vergleich ist drei Zahlen tief und die Regel
// passt in zwanzig Zeilen. AGENTS.md („Abhängigkeiten") verlangt genau diese
// Abwägung, und `semver` brächte Bereichsausdrücke mit, die hier niemand
// braucht.

// Die Marke selbst.
//
// ⚠️ SIE STEHT SEIT #130 AUF 0.24.0 UND NICHT MEHR AUF 0.18.1, und das ist der
// erste Anstieg dieser Zahl. Der Grund ist die Regel im Absatz darunter, nicht
// der Nachzug an sich: der Hub sendet in jedem Eintrag der Allowlist
// `origin: "adopted"` (`HUB_REGISTRY_ORIGIN`, `contract/src/agent/`), und dieses
// Wort kennt erst v0.24.0. Ein Arm darunter prüft `origin` wörtlich, verwirft
// jeden Eintrag mit Compose-Anker und quittiert trotzdem mit `200` — jeder
// Container auf ihm wäre für jede Aktion gesperrt.
//
// Aufgefangen würde das auch ohne die Marke: `syncRegistry` hält die
// zurückgemeldete Zahl gegen die gesendete und wirft. Nur läge der Fehler dann
// an einer anderen Stelle als seine Ursache — ein geworfener Abgleich im
// Hintergrunddurchlauf statt eines roten Arms in der Übersicht. Die Marke
// bringt beides zusammen: der Arm wird rot und schreibgesperrt, BEVOR der
// Abgleich ihn trifft, und der nächste Schritt steht daneben.
//
// 0.18.1 stand hier bis dahin: die Fassung, die die letzten deutschen Namen im
// Agenten ausräumt (`dashboard-docker-agent#50`) und ihre Version aus der
// package.json meldet statt aus einer Konstanten.
//
// ⚠️ Die Marke ist NICHT der Pin des Stacks. Die docker-compose.yml zieht den
// mitgelieferten Agenten auf eine eigene Fassung; die Marke folgt ihr nicht,
// sondern steigt genau dann, wenn der Hub etwas braucht, das eine ältere
// Fassung nicht kann. Bis #130 war das nie der Fall — v0.19.x bis v0.23.0
// haben auf der Leitung dieser Phase nichts geändert, das der Hub BRAUCHT.
//
// ⚠️⚠️ DER PIN DARF NIE UNTER DER MARKE STEHEN. Zwischen #130 und #180 tat er
// es: der Pin in `docker-compose.yml` fuhr v0.19.1, die Marke hier 0.24.0, und
// der mitgelieferte Arm galt seinem eigenen Hub als `outdated` — zu v0.24.0 gab
// es bis dahin kein Image. Seit #180 stehen der Pin und `ARM_AGENT_IMAGE`
// (seit #7 in server/src/domain/hosts/arm-agent-image.ts) auf v0.24.0, getaggt und am 2026-09-29 per
// `docker buildx imagetools inspect` nachgesehen.
//
// Wer die Marke wieder senkt, muss `HUB_REGISTRY_ORIGIN` im selben Zug auf
// `adoptiert` zurücknehmen — die beiden hängen aneinander, und die Marke allein
// zu senken ergäbe einen Hub, der jedem Arm eine Allowlist schickt, die dieser
// verwirft.
//
// ⚠️ 0.24.0 stood here until #279. The mark is now 0.32.0, the first version
// hub and agent share: from there one tag `v<semver>` builds both images, and
// the agent image is named `docklet-hub-agent`. An agent below that
// still runs from the old repository name and cannot move to the new one by
// itself (`target-foreign-repository`, `agent/src/self-update.ts`), so it counts
// as `outdated` until its `DOCKER_AGENT_IMAGE` has been changed once by hand —
// the host list shows that step (`SELF_UPDATE_TARGET_MIN_VERSION`).
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
