/**
 * Übernommener Code — das Sitzungsregister der Shell.
 *
 * Quell-Repo:   dashboard-homelab
 * Quellpfad:    server/src/docker-exec.ts
 * Quell-Commit: 92fbc0b002fdd9a629ff1543a218f69e92e84034
 * Bezugsdatum:  2026-09-08
 *
 * ⚠️ Die Quelldatei steht auf `master` nicht mehr; sie ist nur über diese SHA
 * erreichbar (`git -C dashboard-homelab show 92fbc0b:server/src/docker-exec.ts`,
 * 178 Zeilen).
 *
 * Abweichungen:
 * - Bezeichner durchgängig englisch (AGENTS.md, „Übernommener Code"). Damit ist
 *   diese Datei nicht mehr byteweise mit ihrer Quelle vergleichbar — der
 *   bewusst gezahlte Preis, an dessen Stelle dieser Kopf tritt.
 * - Eine Sitzung ist an `(hostId, containerId)` gebunden, nicht nur an den
 *   Container. Das Quellsystem kannte genau EINEN Docker-Host; dieser Hub führt
 *   viele Arme, und derselbe Container-Name oder dieselbe kurze Kennung kommt
 *   auf zwei Armen vor. Ohne den Arm im Abgleich wäre er ein frei wählbarer
 *   Parameter neben einer gültigen Sitzung — genau die Lücke, gegen die die
 *   Quelle den Container schon mitprüfte.
 * - `userId` ist eine Zeichenkette statt einer Zahl: die Kennung kommt aus
 *   better-auth (`user.id`) und nicht mehr aus einer Zahlenspalte.
 * - `readTerminalSize` und `readAgentExecRow` sind NICHT mit übernommen. Beide
 *   gehören zu dem, was hinaus- und hereingeht, und stehen deshalb im Client
 *   (`exec.ts`) — die Begründung mit ihren eigenen Abweichungen steht dort.
 * - Neu: `sweep`. Die Quelle brauchte es nicht; dieser Hub verlangt
 *   ausdrücklich, dass keine Sitzung im Register weiterlebt, die der Agent
 *   längst beendet hat. Begründung unten bei der Methode.
 * - Neu: `clientViewOf`. Die Quelle hatte die Zusage „die Agent-Sitzungs-Id
 *   verlässt den Server nie" nur als Kommentar; hier ist sie eine Funktion,
 *   damit ein Test sie halten kann.
 * - Die Pro-Nutzer-Grenze zählt je Arm (`countFor(userId, hostId)`) statt
 *   global. Der Deckel des Agenten (`EXEC_MAX_SESSIONS`, vier) gilt je Arm;
 *   eine globale Zählung im Hub wäre strenger als die Grenze, die sie schützen
 *   soll, und sperrte einen Menschen auf Arm B aus, weil er auf Arm A arbeitet.
 *
 * Wörtlich mitgekommen — und ausdrücklich NICHT neu entschieden:
 * - Die Agent-Sitzungs-Id verlässt den Server nie. Der Browser kennt
 *   ausschließlich die Id dieses Registers.
 * - „unbekannt", „fremd" und „noch nicht gekoppelt" fallen zu EINEM
 *   Ablehnungsgrund zusammen, damit sich fremde Ids nicht über die
 *   Fehlermeldung bestätigen lassen.
 * - Die Id kommt aus dem CSPRNG mit 256 Bit.
 * - Der Zustand liegt im Speicher und nicht in der Datenbank.
 */

import crypto from "node:crypto";

import { EXEC_MAX_DURATION_MS, EXEC_MAX_SESSIONS, EXEC_SESSION_REJECTION_KEY } from "contract";

// ── Warum es diesen Zustand überhaupt gibt ──────────────────────────────────
//
// Der Ausgabe-Strom ist eine lange NDJSON-Antwort, die Eingabe kommt als eigene
// kurze Anfrage. Damit gibt es zwischen zwei Anfragen einen ZUSTAND, und dieser
// Zustand ist die einzige Stelle, die beantwortet, ob die Person, die gerade
// tippt, dieselbe ist, die die Sitzung geöffnet hat.
//
// ⚠️ ER LIEGT BEWUSST IM SPEICHER UND NICHT IN DER DATENBANK. Eine Sitzung ist
// an genau einen laufenden Prozess in genau einem Serverprozess gebunden.
// Überlebte sie einen Neustart, zeigte sie auf eine Sitzung, die es beim
// Agenten nicht mehr gibt — und der Hub böte einen Rückkanal an, der ins Leere
// läuft. Ein Neustart soll jede Shell beenden; das ist kein Verlust, sondern
// die Zusage.
//
// ⚠️ WAS DIESE DATEI NICHT TUT: sie spricht nicht mit dem Agenten. Sie führt
// Buch, und sonst nichts. Der Client steht in `exec.ts`, die Routen in
// `routes.ts` daneben.

/** Eine offene Shell-Sitzung, so wie der Hub sie führt. */
export type ExecSession = {
  /**
   * Die Id, die der Browser kennt — und die einzige, die er kennt.
   *
   * 256 Bit aus dem CSPRNG: sie ist der Zugang zum Rückkanal und darf weder
   * ratbar noch aufzählbar sein.
   */
  id: string;
  /**
   * Der Arm, auf dem die Sitzung läuft.
   *
   * ⚠️ Die Erweiterung gegenüber der Quelle. Ohne ihn genügte eine Sitzung auf
   * Arm A, um mit derselben Container-Kennung auf Arm B zu tippen.
   */
  hostId: string;
  containerId: string;
  containerName: string | null;
  /**
   * Der Mensch, der sie geöffnet hat. Die Sitzungs-Id allein genügt NICHT —
   * sonst wäre eine abgefangene Id ein Weg in eine fremde Shell.
   */
  userId: string;
  /**
   * Die Id, unter der der Agent dieselbe Sitzung führt.
   *
   * ⚠️ SIE VERLÄSST DEN SERVER NIE. Sie kommt aus der `start`-Zeile des Stroms
   * und ist der Schlüssel zu den drei kurzen Routen; wer sie hat, tippt in die
   * Shell. Was nach draußen geht, baut `clientViewOf` — und dort steht sie
   * nicht.
   *
   * `null`, bis die erste Stromzeile eingetroffen ist: bis dahin gibt es die
   * Sitzung hier schon, sie nimmt aber noch keine Eingabe an (siehe `check`).
   */
  agentSession: string | null;
  /** Wann sie eröffnet wurde, in Millisekunden seit der Epoche. */
  openedAt: number;
  /** Beendet den Ausgabe-Strom und damit die Sitzung. */
  abort: AbortController;
};

/**
 * Die Antwort auf „darf dieser Mensch auf dieser Sitzung arbeiten?".
 *
 * ⚠️ EIN EINZIGER ABLEHNUNGSGRUND, und das ist keine Sparsamkeit. Unbekannt,
 * fremd und „noch nicht gekoppelt" fallen zusammen: über unterschiedliche
 * Antworten ließen sich sonst gültige Sitzungs-Ids bestätigen. Der Agent macht
 * es an derselben Stelle genauso (`src/exec.ts:194`, dieselbe Antwort für
 * „gibt es nicht" und „gehört jemand anderem"), und der Hub darf daraus keine
 * zwei Meldungen machen.
 *
 * Der Schlüssel ist der der Gegenseite und wird gespiegelt, nicht übersetzt
 * (AGENTS.md, Abschnitt Sprache). Er steht als `EXEC_SESSION_REJECTION_KEY` in
 * `contract/src/agent/` und nicht als Literal hier: er ist ein Wert des
 * Agenten, und ein zweites Mal hingeschrieben wäre er die zweite Wahrheit.
 */
export type ExecAccess =
  | { ok: true; session: ExecSession }
  | { ok: false; reason: typeof EXEC_SESSION_REJECTION_KEY };

const DENIED: ExecAccess = { ok: false, reason: EXEC_SESSION_REJECTION_KEY };

/**
 * Wie viele Sitzungen EIN Mensch auf EINEM Arm gleichzeitig offen haben darf.
 *
 * ⚠️ EINE ENTSCHEIDUNG DIESES HUBS und keine Messung an der Gegenseite —
 * deshalb steht sie hier und nicht in den Vertragsdateien. Der Agent deckelt
 * die Gesamtzahl je Arm (`EXEC_MAX_SESSIONS`, vier); diese Grenze sorgt dafür,
 * dass ein einzelner Mensch sie nicht allein ausschöpft. Ohne sie belegte ein
 * einziger Reiter mit einer Wiederverbindungsschleife alle vier Plätze, und
 * niemand sonst käme mehr in eine Shell.
 *
 * Der Wert ist aus der Quelle übernommen (`EXEC_MAX_SESSIONS_PER_USER = 2`) und
 * passt weiter: zwei von vier lassen für einen zweiten Menschen zwei übrig.
 */
export const EXEC_MAX_SESSIONS_PER_USER = 2;

/**
 * Wie oft während einer laufenden Sitzung nachgeprüft wird, ob das Recht noch
 * besteht.
 *
 * ⚠️ WÖRTLICH AUS DER QUELLE ÜBERNOMMEN, samt Begründung, weil sie hier
 * genauso gilt: der Log-Strom löst dasselbe Problem über eine bewusst kurze
 * Verbindungsdauer — läuft sie ab, verbindet der Browser neu und durchläuft
 * dabei die volle Rechteprüfung. Für eine Shell geht das NICHT: ein Terminal,
 * das alle paar Minuten neu startet, verliert seinen Zustand und ist
 * unbenutzbar. Deshalb hier die Umkehrung — die Verbindung bleibt, und die
 * Prüfung wiederholt sich neben ihr.
 *
 * ⚠️ SIE WIRD IN DIESER DATEI NICHT VERWENDET. Angewandt wird sie von der
 * Route, die den Strom hält (Etappe E3); sie steht hier, weil sie zum
 * Lebenslauf einer Sitzung gehört und nicht zum Routenaufbau — und weil die
 * Quelle sie an derselben Stelle führte. Wer sie beim Bau der Route übersieht,
 * hält eine Shell offen, deren Recht längst entzogen ist.
 */
export const EXEC_PERMISSION_CHECK_MS = 60_000;

/**
 * Wie lange eine Sitzung im Register überleben darf, ohne dass ihr Strom sie
 * abmeldet.
 *
 * ⚠️ WARUM ES DIESEN WERT BRAUCHT — DIE QUELLE HATTE IHN NICHT. Im Normalfall
 * trägt sich eine Sitzung selbst aus: der Strom endet mit `end`, und die Route
 * räumt auf. Zwei der vier gemessenen Ausgänge des Exec-Stroms haben aber gar
 * keine letzte Zeile (der Aufrufer bricht ab, oder es staut zurück), und in
 * beiden Fällen hängt das Aufräumen allein daran, dass der Serverprozess seinen
 * eigenen Abbruch bemerkt. Eine Sitzung, die der Agent längst beendet hat und
 * die hier weiterlebt, ist ein Leck: sie zählt gegen die Grenze oben, und ihre
 * Id bleibt ein gültiger Schlüssel für eine Shell, die es nicht mehr gibt.
 *
 * ⚠️ DIE ZUGABE IST NICHT ZIERRAT. Die Uhr des Hubs beginnt VOR der des
 * Agenten (er eröffnet seine Sitzung erst, wenn die Anfrage bei ihm ankommt),
 * eine Sitzung des Hubs ist also immer die ältere. Ohne Zugabe räumte der
 * Sweep genau in dem Augenblick ab, in dem die Sitzung beim Agenten noch ein
 * paar Sekunden zu leben hat — und risse eine laufende Shell weg. Eine Minute
 * ist reichlich für die Wegstrecke und kurz genug, dass ein Leck nicht steht.
 */
export const EXEC_SWEEP_GRACE_MS = 60_000;

/**
 * Das Register der offenen Shell-Sitzungen dieses Serverprozesses.
 *
 * Eine Instanz je Prozess, gehalten von der Routenschicht. Keine Datenbank,
 * kein Zeitgeber im Modul: ein Zeitgeber hielte den Prozess am Leben und wäre
 * in einem Test nur mit Warten zu prüfen. Aufgeräumt wird beim Eröffnen —
 * siehe `open`.
 */
export class ExecSessionRegister {
  private readonly sessions = new Map<string, ExecSession>();

  /**
   * Eine neue Sitzungs-Id: 256 Bit aus dem CSPRNG, hexadezimal.
   *
   * ⚠️ `crypto.randomBytes` und nicht `Math.random`. Die Id ist der Zugang zum
   * Rückkanal einer Shell; eine vorhersagbare Id wäre ein Weg hinein, der an
   * jeder Anmeldung vorbeiführt.
   */
  static newId(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Eröffnet eine Sitzung und trägt sie ein.
   *
   * ⚠️ VORHER LÄUFT DER SWEEP, und zwar an genau dieser Stelle und nicht in
   * einem Zeitgeber. Die Zählung je Mensch entscheidet gleich darunter über
   * eine Ablehnung; sie auf einem ungeputzten Register zu rechnen hieße, einen
   * Menschen wegen zweier Sitzungen abzuweisen, von denen eine seit einer
   * halben Stunde tot ist.
   */
  open(input: {
    hostId: string;
    containerId: string;
    containerName: string | null;
    userId: string;
    abort: AbortController;
    now: number;
  }): ExecSession {
    this.sweep(input.now);
    const session: ExecSession = {
      id: ExecSessionRegister.newId(),
      hostId: input.hostId,
      containerId: input.containerId,
      containerName: input.containerName,
      userId: input.userId,
      agentSession: null,
      openedAt: input.now,
      abort: input.abort
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Verbindet die Sitzung mit der Id, unter der der Agent sie führt.
   *
   * Die Agent-Sitzung wird erst bekannt, wenn dessen erste Stromzeile
   * eintrifft. Bis dahin gibt es die Sitzung hier schon, sie nimmt aber noch
   * keine Eingabe an — siehe `check`.
   */
  couple(id: string, agentSession: string): void {
    const session = this.sessions.get(id);
    if (session) session.agentSession = agentSession;
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Wie viele Sitzungen dieser Mensch auf diesem Arm offen hat — die Grundlage
   * der Pro-Nutzer-Grenze.
   *
   * ⚠️ JE ARM, nicht global. Der Deckel, den diese Zahl schützt, ist der des
   * Agenten, und der gilt je Arm.
   */
  countFor(userId: string, hostId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.hostId === hostId) count += 1;
    }
    return count;
  }

  /**
   * Darf DIESER Mensch auf DIESER Sitzung an DIESEM Container DIESES Arms
   * arbeiten?
   *
   * ⚠️ ALLE VIER BEDINGUNGEN ZUSAMMEN, nicht nur die Id. Arm und Container
   * stehen im Pfad der Eingabe-Route; ohne den Abgleich wären sie frei wählbare
   * Parameter neben einer gültigen Sitzung. Die vierte Bedingung ist die
   * Kopplung: eine Sitzung ohne Agent-Id kann gar nichts weiterreichen, und sie
   * als „gibt es nicht" zu beantworten ist dieselbe Antwort wie für alles
   * andere — siehe `ExecAccess`.
   */
  check(id: string, expected: { userId: string; hostId: string; containerId: string }): ExecAccess {
    // ⚠️ VIER MAL DERSELBE RÜCKGABEWERT, und zwar wörtlich derselbe: `DENIED`
    // ist EIN Objekt. Vier gleich aussehende, aber getrennt gebaute Antworten
    // wären die Stelle, an der eines Tages eine von ihnen eine Kleinigkeit
    // mitbekommt — ein Feld, einen abweichenden Grund — und die Auskunftssperre
    // damit aufhebt. Ein Aufrufer, der den Grund vergleicht, kann sie hier
    // nicht auseinanderhalten, weil es nichts auseinanderzuhalten gibt.
    const session = this.sessions.get(id);
    if (!session) return DENIED;
    if (session.userId !== expected.userId) return DENIED;
    if (session.hostId !== expected.hostId) return DENIED;
    if (session.containerId !== expected.containerId) return DENIED;
    if (!session.agentSession) return DENIED;
    return { ok: true, session };
  }

  /**
   * Räumt Sitzungen ab, die der Agent nach seiner eigenen Höchstdauer nicht
   * mehr führen kann — und bricht ihren Strom mit ab.
   *
   * Zurück kommt die Zahl der entfernten Sitzungen, damit ein Aufrufer sie
   * protokollieren kann: eine Sitzung, die HIER endet statt an ihrem Strom, ist
   * ein Hinweis darauf, dass ein Abbruch nicht bemerkt wurde.
   *
   * ⚠️ `abort()` gehört dazu und ist nicht nur Aufräumen. Ein Eintrag, der
   * verschwindet, während sein Strom weiterläuft, wäre der schlechtere Zustand:
   * die Ausgabe liefe weiter in eine Verbindung, für die niemand mehr Buch
   * führt.
   */
  sweep(now: number): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.openedAt < EXEC_MAX_DURATION_MS + EXEC_SWEEP_GRACE_MS) continue;
      session.abort.abort();
      this.sessions.delete(id);
      removed += 1;
    }
    return removed;
  }
}

/**
 * Was von einer Sitzung nach draußen darf.
 *
 * ⚠️ DAS IST DIE ZUSAGE ALS FUNKTION UND NICHT ALS KOMMENTAR. „Die
 * Agent-Sitzungs-Id verlässt den Server nie" stand in der Quelle als Satz
 * daneben — ein Satz, den kein Werkzeug hält. Hier ist es eine Stelle, die ein
 * Test gegen ihr Ergebnis prüfen kann: was diese Funktion nicht zurückgibt,
 * geht nicht hinaus.
 *
 * ⚠️ SIE IST NICHT DIE ANTWORT DER ROUTE. Die baut Etappe E3, und sie darf
 * mehr dazulegen (die Shell, den Arm). Was sie NICHT darf, ist an dieser
 * Funktion vorbei auf `session.agentSession` zu greifen.
 */
export function clientViewOf(session: ExecSession): { session: string; containerName: string | null } {
  return { session: session.id, containerName: session.containerName };
}

// Der Deckel des Agenten geht unverändert weiter — dieselbe Festlegung wie bei
// den Grenzen der Datei-Fläche (`files.ts`): wer die Zahl braucht, soll sie
// nicht ein zweites Mal irgendwo herholen müssen und schon gar nicht neu
// hinschreiben. Entschieden wird sie beim Agenten.
export { EXEC_MAX_SESSIONS };
