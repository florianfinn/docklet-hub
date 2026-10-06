// The agent client of the feature `shell` (#260): the four exec calls of the
// agent, one function per route. Moved here from `agent/exec.ts`;
// `readTerminalSize` went to `terminal-size.ts` and `execRejectionKey` to
// `rejections.ts`, and the comments that the move did not touch are still
// German (AGENTS.md, "Sprache").
//
// Der Client für die vier Exec-Aufrufe des Agenten — eine Funktion je Route.
//
// Everything here was MEASURED against the agent (v0.24.0); the measurement is
// in `.remember/orchestration-b6/exec-protokoll.md`, with file and line per
// statement, and the numbers and limits live in `contract/src/agent/`. The
// draft (`docs/design/phase-5-write-access.md` §6, "Shell-Sitzungen") was
// read and lost against the measurement in four places; each is listed below
// with its source.
//
// ── DIE VIER FESTLEGUNGEN, DIE HIER UND NICHT ANDERSWO STEHEN ───────────────
//
// 1. DER AUFRUFER IST IMMER EIN MENSCH, UND ZWAR AN ALLEN VIER ROUTEN.
//    `ExecRequestOptions` lässt als `actor` nur `{ kind: "user", id }` zu.
//    Das ist hier NICHT dieselbe Vorsichtsmaßnahme wie bei der Datei-Fläche
//    (dort geht es um die Spur im Audit-Log), sondern eine SCHRANKE: der Agent
//    vergleicht `session.actor !== actor` STRIKT gegen `string | null`
//    (`src/exec.ts:194`). Zwei Aufrufer mit `actor === null` gelten damit als
//    DERSELBE — ein leerer Aufrufer machte jede offene Shell für jeden
//    zugänglich, der eine Sitzungs-Id in die Hand bekommt. `Actor` aus
//    `protocol.ts` lässt auch `{ kind: "system", name }` zu; das ist an diesen
//    vier Routen falsch, und hier ist es ein Typfehler statt einer Verabredung.
//    Ein Test hält es zusätzlich über alle vier Aufrufe hinweg.
//
// 2. DIE EINGABE GEHT ALS BASE64 HINAUS, UND ZWAR VON HIER.
//    Der Agent dekodiert mit `Buffer.from(data, "base64")` (`src/index.ts`,
//    `:3741`; bis zur Berichtigung am 2026-09-08 stand hier `:3737` — das ist
//    die Eingabegrenze eine Bedingung darüber). Tastatureingaben sind Bytes — Steuerzeichen,
//    Escape-Sequenzen, unvollständige UTF-8-Folgen beim schnellen Tippen — und
//    kein wohlgeformter Text.
//
//    ⚠️ ABWEICHUNG VOM ENTWURF, und die gefährlichste der Etappe. §6 nennt
//    `data: string` und sagt kein Wort über die Kodierung. Klartext tippt
//    Zeichensalat in den Container; bei einem `ls` fällt es nicht einmal auf,
//    bei einem `ß` oder einem Ctrl-C sofort. `sendInput` nimmt deshalb
//    `Uint8Array` und kodiert selbst: was der Typ nicht zulässt, kann kein
//    Aufrufer vergessen.
//
// 3. DER EXEC-STROM HAT KEINE `error`-ZEILE — als EINZIGER der vier Ströme.
//    Gesucht und nicht gefunden. Jeder Fehlerweg endet entweder als
//    `{ kind: "end", exitCode: null }` oder GANZ OHNE letzte Zeile. Ein
//    Client, der auf eine Fehlerzeile wartet, wartet für immer.
//
//    ⚠️ DER UMSCHLAG HIER ABSTRAHIERT DAS NICHT WEG, sondern trägt es:
//    `startExec` liefert `ExecOutcome`, und dessen zweiter Zweig heißt
//    `unterminated`. Ein `onFailure` wie bei `streamLogs` gibt es hier
//    ABSICHTLICH nicht — es wäre ein Rückruf, der niemals läuft, und damit die
//    Einladung, auf ihn zu warten.
//
// 4. DIE GRENZEN DES AGENTEN WERDEN NICHT NACHGEBAUT.
//    Fenstergröße, Sitzungszahl und Eingabelänge stehen in
//    `contract/src/agent/` und werden von hier weitergereicht, damit ein
//    Aufrufer früh warnen kann. Entschieden wird beim Agenten: er klemmt die
//    Größe und antwortet über der Eingabegrenze mit `413`. Eine Schranke in
//    diesem Modul wäre die zweite Wahrheit über eine fremde Grenze — dieselbe
//    Festlegung wie in `files.ts`.

import {
  EXEC_MAX_COLS,
  EXEC_MAX_INPUT_BASE64_CHARS,
  EXEC_MAX_ROWS,
  EXEC_MIN_COLS,
  EXEC_MIN_ROWS,
  execStreamLineSchema,
  readNdjson
} from "contract";
import {
  agentPost,
  agentStreamPost,
  streamBodyOf,
  type AgentTarget,
  type RequestOptions
} from "../../platform/agent-transport/protocol.js";
import { parseStreamLine } from "../../platform/agent-transport/stream-lines.js";
import { watchStreamRejection } from "../../platform/agent-transport/stream-rejection.js";

// Die Grenzen der Gegenseite gehen unverändert weiter — siehe Festlegung 4.
export {
  EXEC_MAX_COLS,
  EXEC_MAX_INPUT_BASE64_CHARS,
  EXEC_MAX_ROWS,
  EXEC_MIN_COLS,
  EXEC_MIN_ROWS
};

/**
 * Der Aufrufer einer Exec-Route: immer ein angemeldeter Mensch.
 *
 * ⚠️ Die Durchsetzung von Festlegung 1 oben. Siehe dort, warum das an DIESEN
 * Routen mehr ist als eine Spur im Audit-Log.
 */
export type ExecActor = { kind: "user"; id: string };

/** Die Optionen einer Exec-Anfrage — wie `RequestOptions`, aber ohne System. */
export type ExecRequestOptions = Omit<RequestOptions, "actor"> & { actor: ExecActor };

/**
 * Die `start`-Zeile des Stroms (`src/index.ts:5108`).
 *
 * ⚠️ DAS FELD HEISST HIER `agentSession` UND NICHT `session`, anders als im
 * Entwurf und anders als beim Agenten. Der Grund ist keine Kosmetik: im Hub
 * gibt es ZWEI Sitzungs-Ids — die des Registers, die der Browser kennt, und
 * diese hier, die den Server nie verlassen darf. Ein Feld, das an beiden
 * Stellen `session` heißt, ist genau die Gestalt, in der die falsche von beiden
 * in eine Antwort gerät. Der Name sagt jetzt, um welche es geht.
 *
 * `containerName` ist `string | null` und nicht `string`: der Agent schickt
 * das Feld, aber ein Container ohne Namen ist möglich, und ein erfundener
 * leerer Name wäre eine Auskunft, die niemand gemessen hat.
 */
export type ExecStart = { agentSession: string; shell: string; containerName: string | null };

/**
 * Wie der Strom geendet hat — DIE Antwort, um die es bei Festlegung 3 geht.
 *
 * Die vier gemessenen Ausgänge fallen auf diese zwei Zweige, und zwar so:
 *
 *   `ended`, `exitCode` eine Zahl   Der Prozess ist von selbst fertig. Der
 *                                   EINZIGE Fall mit einer Zahl.
 *   `ended`, `exitCode: null`       Höchstdauer (30 min) oder Leerlauf
 *                                   (15 min). Der Agent zerstört nur den
 *                                   Socket zum Container; die Antwort bleibt
 *                                   offen und trägt noch ein `end` hinaus.
 *   `unterminated`                  Der Aufrufer hat abgebrochen, oder es hat
 *                                   zurückgestaut. Keine letzte Zeile.
 *
 * ⚠️ ZWEI GRÜNDE, EIN ZWEIG — und das ist gemessen, nicht vereinfacht: der Hub
 * kann Höchstdauer und Leerlauf NICHT unterscheiden. Sie stehen nur im
 * Audit-Log des Agenten. Wer sie in der Oberfläche auseinanderhält, erfindet
 * die Unterscheidung.
 *
 * ⚠️ `unterminated` UND „der Aufrufer wollte es so" SIND DASSELBE ERGEBNIS.
 * Wer beides trennen muss, sieht auf sein eigenes `options.signal.aborted` —
 * nur er weiß, ob er selbst abgebrochen hat. Ein dritter Zweig hier behauptete
 * eine Auskunft des Stroms, die es nicht gibt: ein Rückstau und ein
 * geschlossener Browser sehen von hier aus gleich aus.
 */
export type ExecOutcome = { kind: "ended"; exitCode: number | null } | { kind: "unterminated" };

/**
 * Die Optionen des Exec-Stroms.
 *
 * ⚠️ `signal` ist PFLICHT, wie bei jedem Strom dieses Hubs — hier aber aus
 * einem eigenen Grund: eine Shell endet von selbst erst nach 30 Minuten, und
 * bis dahin belegt sie einen der VIER Plätze des Agenten. Ein Strom ohne
 * Abbruchmöglichkeit ist damit ein Viertel der Shell-Kapazität eines Arms.
 *
 * ⚠️ `onStart` STEHT IN DEN OPTIONEN, obwohl der Entwurf die `start`-Zeile zum
 * RÜCKGABEWERT macht (`Promise<ExecStart>`). Zwei gemessene Gründe:
 *
 *   1. Ein Rückgabewert, der bei `start` fällt, lässt den REST des Stroms
 *      unbeaufsichtigt zurück. Die Zusage, die ein Aufrufer braucht, ist aber
 *      genau die letzte: hat der Strom mit `end` geschlossen oder ist er
 *      abgerissen (Festlegung 3)? Mit der Entwurfsform gäbe es dafür keine
 *      Stelle — und ein Fehler nach `start` wäre eine unbehandelte Ablehnung.
 *   2. Es ist die Form, die `streamLogs` in diesem Hub schon hat: die Zeile,
 *      die das Ereignis trägt, bleibt der letzte Parameter, Start und Öffnung
 *      sind Beiwerk in den Optionen. Eine zweite Bauart für den zweiten Strom
 *      wäre eine Sache, die man sich je Route neu merken muss.
 */
export type ExecStreamOptions = ExecRequestOptions & {
  cols: number;
  rows: number;
  signal: AbortSignal;
  /**
   * Die `start`-Zeile — der Augenblick, in dem der Hub seine Sitzung mit der
   * des Agenten koppeln kann (`ExecSessionRegister.couple`).
   *
   * ⚠️ Bis hierher nimmt die Sitzung im Register KEINE Eingabe an. Ein
   * Aufrufer, der diesen Rückruf weglässt, baut eine Shell, in die niemand
   * tippen kann.
   */
  onStart?: (start: ExecStart) => void;
  /**
   * Der Strom steht: der Agent hat mit `200` geantwortet, gelesen wurde noch
   * nichts.
   *
   * ⚠️ Der Aufrufer braucht genau DIESEN Zeitpunkt für seine eigenen
   * Kopfzeilen, und nicht die `start`-Zeile. Bis hierher kann ein Fehler noch
   * ein Statuscode sein; ab hier nicht mehr. Dieselbe Begründung wie bei
   * `streamLogs` — mit einem Zusatz, der nur hier gilt: zwischen `200` und der
   * `start`-Zeile liegt beim Agenten das Anlegen des Exec und der Aufbau des
   * Sockets zum Container, also die langsamste Stelle des ganzen Vorgangs.
   */
  onOpen?: () => void;
};

/**
 * Öffnet eine Shell im Container und liest ihren Ausgabe-Strom.
 *
 * Zurück kommt, WIE der Strom geendet hat — siehe `ExecOutcome`. Kein
 * Rückgabewert für die Ausgabe: die Zusage lautet, dass `onOutput` läuft,
 * sobald die Zeile da ist.
 *
 * ⚠️ GIBT `onOutput` EIN PROMISE, WIRD ES ABGEWARTET (#131). Ein `cat` auf eine
 * große Datei erzeugt Ausgabe schneller, als ein Terminal sie annimmt; das
 * Warten des Aufrufers bremst hier das Lesen und damit über TCP den Arm.
 *
 * ⚠️ Der Abbruch über `options.signal` ist der NORMALFALL und kein Fehler: der
 * Browser hat die Seite verlassen. Er endet still (das erledigt `readNdjson`)
 * und ergibt `unterminated`.
 *
 * ⚠️ Die Ablehnungen des Agenten kommen ALLE vor der ersten Stromzeile
 * und damit als `AgentError` aus diesem Aufruf — mit Status UND, anders als
 * bei jedem anderen Strom dieses Hubs, mit ausgewertetem Fehlerrumpf in
 * `detail`. Warum das hier eine eigene Vorrichtung braucht, steht bei
 * `openExecStream`.
 */
export async function startExec(
  target: AgentTarget,
  containerId: string,
  options: ExecStreamOptions,
  onOutput: (text: string) => void | Promise<void>
): Promise<ExecOutcome> {
  const path = `/containers/${encodeURIComponent(containerId)}/exec`;
  const response = await openExecStream(target, path, options);
  const body = streamBodyOf(response, path);
  // Ab hier ist der Status vergeben. Alles Weitere steht im Strom.
  options.onOpen?.();

  // ⚠️ EIN HALTER UND KEINE FREIE VARIABLE. Das Ergebnis entsteht in einem
  // Rückruf, und eine `let`-Variable, die dort zugewiesen wird, behält für den
  // Typprüfer ihre Anfangsverengung — der Vergleich danach gälte ihm als
  // immer wahr. Ein Feld auf einem Objekt verliert seine Verengung bei jedem
  // Funktionsaufruf und ist damit die Form, die hier trägt.
  const seen: { end: { exitCode: number | null } | null } = { end: null };

  // ⚠️ LINE SPLITTING LIVES IN THE ONE READER OF `contract` (#252). What
  // stays here is the knowledge of THIS stream: three kinds, no `error` line.
  //
  // Every line is checked against `execStreamLineSchema` (#272); one that does
  // not fit is dropped (`parseStreamLine`).
  await readNdjson(body, options, (record) => {
    const line = parseStreamLine(execStreamLineSchema, record);
    if (line?.kind === "output") {
      // ⚠️ Ein leeres `text` wird weitergereicht und nicht verschluckt: der
      // Agent schickt es nicht von sich aus, aber ein Vermittler kann eine
      // Zeile verdorben haben, und ein stiller Ausfall wäre hier ein
      // verlorenes Zeichen im Terminal.
      //
      // ⚠️ ZURÜCKGEGEBEN UND NICHT NUR GERUFEN — daran hängt der Gegendruck.
      return onOutput(line.text);
    }
    if (line?.kind === "start") {
      // ⚠️ Das Feld heißt beim Agenten `session` (`src/index.ts:5108`). Die
      // Quelle im Quellsystem las `sitzung` — an DIESEM Agenten wäre das
      // dauerhaft `undefined`, die Sitzung würde nie gekoppelt, und die Shell
      // nähme für immer keine Eingabe an. Nachgemessen und berichtigt.
      options.onStart?.({
        agentSession: line.session,
        shell: line.shell,
        containerName: line.containerName ?? null
      });
      return;
    }
    if (line?.kind === "end") {
      // Ein `end` OHNE `exitCode` ist der gemessene Normalfall bei Zeitablauf
      // und Abbruch von außen — deshalb `null` und kein Übergehen der Zeile.
      seen.end = { exitCode: line.exitCode ?? null };
    }
    // Eine unbekannte Art fällt weg. Der Strom geht (übersetzt) an den
    // Browser, und was hier nicht steht, hat dort nichts zu suchen.
  });

  return seen.end === null ? { kind: "unterminated" } : { kind: "ended", exitCode: seen.end.exitCode };
}

/**
 * Schickt Tastatureingaben in eine laufende Sitzung.
 *
 * ⚠️ `data` sind BYTES und kein Text — siehe Festlegung 2 im Dateikopf. Die
 * base64-Kodierung passiert hier und nicht beim Aufrufer.
 *
 * ⚠️ Die Länge wird NICHT vorgeprüft. Über `EXEC_MAX_INPUT_BASE64_CHARS`
 * antwortet der Agent mit `413 input-too-large`; die Zahl gilt für die
 * base64-ZEICHENKETTE und nicht für die Bytes, die hier hereinkommen — rund
 * ein Drittel weniger Nutzlast, als sie aussieht. Wer dem Betreiber früher
 * etwas sagen will, prüft VOR diesem Aufruf.
 */
export async function sendInput(
  target: AgentTarget,
  session: string,
  data: Uint8Array,
  options: ExecRequestOptions
): Promise<void> {
  await agentPost(
    target,
    `/exec/${encodeURIComponent(session)}/input`,
    { data: Buffer.from(data).toString("base64") },
    options
  );
}

/**
 * Meldet eine neue Fenstergröße.
 *
 * ⚠️ DER AGENT VERSCHLUCKT EINEN FEHLSCHLAG (`src/index.ts`, `:3720-3730`):
 * eine misslungene Größenänderung ist kosmetisch und darf die Sitzung nicht
 * beenden. Er antwortet deshalb auch dann `200 { ok: true }`. Diese Funktion
 * gibt entsprechend nichts zurück — ein Erfolgswert wäre eine Auskunft, die
 * die Gegenseite nicht gibt.
 */
export async function resize(
  target: AgentTarget,
  session: string,
  size: { cols: number; rows: number },
  options: ExecRequestOptions
): Promise<void> {
  await agentPost(target, `/exec/${encodeURIComponent(session)}/size`, { cols: size.cols, rows: size.rows }, options);
}

/**
 * Beendet eine Sitzung.
 *
 * ⚠️ DIESE ROUTE GEHT AUCH UNTER DEM KILL-SWITCH (`src/index.ts`,
 * `:3691-3695`). Unter `agent-read-only` antworten `input` und `size` mit
 * `503` und BEENDEN dabei die Sitzung; `close` läuft weiter. Das ist richtig
 * so und gehört im Hub nachgebildet: eine Sitzung muss sich immer schließen
 * lassen. Wer diese Route hinter dieselbe Sperre stellt wie die anderen drei,
 * baut Shells, die man nicht mehr loswird.
 *
 * ⚠️ Der Rumpf ist leer — der Agent liest ihn auf dieser Route nicht. Er geht
 * trotzdem als `{}` hinaus und nicht als gar nichts: `agentPost` ist der eine
 * Weg mit JSON-Rumpf, und ein zweiter Weg ohne wäre ein achter Weg in
 * `protocol.ts` für eine Route, die den Unterschied nicht bemerkt.
 */
export async function closeExec(
  target: AgentTarget,
  session: string,
  options: ExecRequestOptions
): Promise<void> {
  await agentPost(target, `/exec/${encodeURIComponent(session)}/close`, {}, options);
}

/**
 * Öffnet den Strom und holt bei einer Ablehnung den Fehlerrumpf nach.
 *
 * ⚠️ WARUM DIESER STROM DEN RUMPF BRAUCHT, und das ist gemessen. Alle ZWÖLF
 * Ablehnungen von `POST /containers/:id/exec` fallen vor der ersten
 * Stromzeile, und der Status allein hält sie nicht auseinander: `409` heißt
 * `container-not-started` ODER `no-shell`, `404` heißt
 * `not-allowlisted` ODER `container-gone`, `403` heißt drei verschiedene Dinge.
 * Ein Betreiber, der „HTTP 409" liest, weiß nicht, ob er den Container starten
 * oder ein Image mit Shell nehmen muss.
 *
 * ⚠️ DIE VORRICHTUNG SELBST STEHT SEIT #129 IN `stream-rejection.ts`. Hier
 * stand sie ausgeschrieben, mit dem Satz „für einen Fall, den genau eine Route
 * hat" — der Anwende-Strom der Compose-Fläche hat daraus einen zweiten
 * gemacht. Warum sie weiterhin nicht in `protocol.ts` steht, steht dort.
 */
async function openExecStream(
  target: AgentTarget,
  path: string,
  options: ExecStreamOptions
): Promise<Response> {
  const watch = watchStreamRejection(options.fetchImpl);

  try {
    return await agentStreamPost(
      target,
      path,
      { cols: options.cols, rows: options.rows },
      { actor: options.actor, fetchImpl: watch.fetchImpl, timeoutMs: options.timeoutMs, signal: options.signal }
    );
  } catch (error) {
    throw await watch.withDetail(error);
  }
}
