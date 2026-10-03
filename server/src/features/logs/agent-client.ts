import { DEFAULT_TAIL, logsSnapshotQuerySchema, logsStreamLineSchema, MAX_TAIL, MIN_TAIL, readNdjson } from "contract";

import {
  agentStream,
  AgentError,
  streamBodyOf,
  type AgentTarget,
  type RequestOptions
} from "../../platform/agent-transport/protocol.js";
import { parseStreamLine } from "../../platform/agent-transport/stream-lines.js";

// The agent client of the feature `logs` (#254): the container log as a
// running stream. Moved here from `agent/logs.ts`; the comments below that
// were not touched by the move are still German (AGENTS.md, "Sprache").
//
// Das Container-Log als laufender Strom.
//
// Everything here was READ off the agent (v0.24.0), not guessed; the line
// numbers refer to that release.
//
// `GET /containers/:id/logs-stream?tail=N` (`src/index.ts:3947`) antwortet
// `200` mit `application/x-ndjson; charset=utf-8` und einer JSON-Zeile je
// Ereignis. Drei Arten gibt es, und die erste Zeile ist immer `start`:
//
//   {"kind":"start","containerName":"…","tty":true}
//   {"kind":"line","stream":"stdout"|"stderr","ts":"…","text":"…"}
//   {"kind":"error","reason":"container-gone"|"engine-refused"
//                             |"engine-unreachable"|"logs-failed"}
//
// ⚠️ EIN ABBRUCH DES AUFRUFERS IST KEINE DIESER ZEILEN, seit v0.24.0
// (`dashboard-docker-agent#80`). Er war bis v0.23.0 der Wert `abgebrochen` in
// derselben `error`-Zeile und damit der häufigste „Fehler" dieses Stroms,
// obwohl er der Normalfall ist. Der Agent schickt dafür jetzt gar nichts mehr:
// die Verbindung, auf der die Zeile ankommen müsste, ist genau die, die gerade
// zugegangen ist.
//
// Die Engine liefert erst die letzten `tail` Zeilen und hängt dann nahtlos an
// den laufenden Strom an (`src/engine.ts:773`, `follow=1`). Der Strom endet von
// selbst nur, wenn der Container verschwindet; sonst bricht ihn der Aufrufer ab.
//
// ⚠️ DIE AUSWERTUNG DES UMSCHLAGS STEHT HIER EINMAL und nicht in jeder Route.
// Sie ist der Teil, der still falsch sein kann: ein Chunk ist keine Zeile, und
// ein Umschlag, der über zwei Chunks läuft, ergibt bei naiver Auswertung
// entweder zwei kaputte Hälften oder einen Strom, der abbricht.
//
// ⚠️ Warum diese Route und nicht `GET /containers/:id/logs`: jene antwortet
// `text/plain; charset=utf-8` (`src/index.ts:3880-3933`) und liefert über
// `renderDemuxedLines` (`src/log-demux.ts:150`) nur `"<ts> <text>"` je Zeile —
// OHNE die Unterscheidung `stdout`/`stderr`. Ein `LogLine` mit `stream` kann
// daraus nicht entstehen, ohne die Trennung zu erfinden. Der Strom ist die
// reichere Quelle, und deshalb steht hier nur er.

/** Eine Zeile des Container-Logs, mit ihrem Kanal. */
export type LogLine = { stream: "stdout" | "stderr"; ts: string; text: string };

/** Die erste Zeile jedes Stroms. `tty` entscheidet, ob es zwei Kanäle gibt. */
export type LogStreamStart = { containerName: string; tty: boolean };

/**
 * Ein Fehler, der IM Strom steht.
 *
 * ⚠️ Er ist die einzige Form, in der ein Fehler nach der ersten Zeile noch
 * auftreten kann — der Statuscode steht da längst fest. `reason` bleibt eine
 * Zeichenkette und keine Aufzählung: der Agent kennt heute vier Werte
 * (`LOG_STREAM_FAILURE_REASONS`), ein fünfter morgen soll hier nicht am Parser
 * scheitern, sondern durchgereicht werden — und ein Arm auf v0.23.0 schickt
 * weiterhin die beiden alten.
 *
 * ⚠️ WHAT ARRIVES HERE IS ALWAYS THE AGENT'S WORD. The reason the hub writes
 * itself for a broken body comes from one level up (`HUB_STREAM_BROKEN`,
 * `contract/src/stream/hub-stream-reasons.ts`) and does not run through this
 * type. The two sets stay apart in the code, not only in intent.
 *
 * ⚠️ `null` MEANS: THE LINE CARRIED NO REASON (#176). The hub then puts in no
 * word of its own; see the end of `contract/src/stream/hub-stream-reasons.ts`.
 */
export type LogStreamFailure = { reason: string | null };

// The limits of `tail` (`MIN_TAIL`, `MAX_TAIL`, `DEFAULT_TAIL`) and the query
// they bound live in the shared contract since #272
// (`contract/src/agent/limits.ts`, `logsSnapshotQuerySchema`). They are not a
// choice of this module: the agent refuses a value outside them with `400`.
// ⚠️ `tail=0` IS AN INTERNAL ALARM STREAM ON THE AGENT: it then sends only new
// lines and no history; the hub must never send it, which is why the hub
// checks against the schema with the lower bound 1.
//
// No re-export from here: whoever needs the numbers (the tests) takes them
// from the contract. Two names for the same number would be exactly the state
// the contract ended.

/**
 * Wie viele vergangene Zeilen — oder gar keine gültige Angabe.
 *
 * Nimmt entgegen, was aus einer Abfragezeichenkette kommen kann (`unknown`),
 * und gibt entweder eine ganze Zahl in `1..2000` oder `null`. Kein Zurechtbiegen
 * eines zu großen Werts: eine stille Kürzung sähe aus wie ein erfüllter Wunsch.
 */
export function parseTail(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  // `String(value)` and not `value`: the schema reads a query, i.e. text, and
  // a number has to fail on the same digits rule as its text would.
  const parsed = logsSnapshotQuerySchema.safeParse({ tail: String(value) });
  return parsed.success && parsed.data.tail >= MIN_TAIL ? parsed.data.tail : null;
}

export type LogStreamOptions = RequestOptions & {
  tail?: number;
  signal: AbortSignal;
  /**
   * Die `start`-Zeile.
   *
   * ⚠️ Sie steht in den Optionen und nicht als weiteres Argument: `onLine` ist
   * der Zweck dieser Funktion und behält deshalb die Stelle, die
   * `docs/design/phase-5-write-access.md` §6 ihm gibt. Start und Fehler sind
   * Beiwerk, das ein Aufrufer weglassen darf.
   */
  onStart?: (start: LogStreamStart) => void;
  onFailure?: (failure: LogStreamFailure) => void;
  /**
   * Der Strom steht: der Agent hat mit `200` geantwortet, gelesen wurde noch
   * nichts.
   *
   * ⚠️ Der Aufrufer braucht genau DIESEN Zeitpunkt, und nicht die erste Zeile.
   * Bis hierher kann ein Fehler noch ein Statuscode sein; ab hier nicht mehr.
   * Wer stattdessen auf die `start`-Zeile wartet, hängt seine eigene Antwort an
   * die Geschwindigkeit der Engine des Zielhosts — ein Container, dessen Log
   * langsam aufgeht, sähe im Browser aus wie eine Anfrage ohne Antwort.
   */
  onOpen?: () => void;
};

/**
 * Liest den Log-Strom eines Containers und ruft je Zeile zurück.
 *
 * Kein Rückgabewert am Ende: ein Strom, der erst vollständig gelesen und dann
 * ausgeliefert wird, ist keiner. Die Zusage lautet, dass `onLine` läuft, sobald
 * die Zeile da ist — nicht, wenn der Container aufhört zu reden.
 *
 * ⚠️ GIBT `onLine` EIN PROMISE, WIRD ES ABGEWARTET (#131). Der Aufrufer
 * schreibt die Zeile an einen Browser, dessen Ausgabepuffer voll sein kann;
 * sein Warten bremst hier das Lesen und damit über TCP den Arm. Ein gesprächiger
 * Container an einem langsamen Reiter stapelte sich sonst im Speicher des Hubs.
 *
 * ⚠️ Der Abbruch über `options.signal` ist der NORMALFALL und kein Fehler: der
 * Browser hat die Seite verlassen. Er endet hier still, statt als `AbortError`
 * nach oben zu blubbern — ein Serverfehler daraus füllte das Log mit
 * Nicht-Ereignissen.
 */
export async function streamLogs(
  target: AgentTarget,
  containerId: string,
  options: LogStreamOptions,
  onLine: (line: LogLine) => void | Promise<void>
): Promise<void> {
  const tail = options.tail === undefined ? DEFAULT_TAIL : parseTail(options.tail);
  if (tail === null) {
    // Die zweite Hälfte derselben Zusage wie in der Route: `tail=0` darf den
    // Hub nicht verlassen. Die Route prüft die Anfrage, diese Bedingung prüft
    // den Aufrufer — auch den nächsten, der noch nicht geschrieben ist.
    throw new AgentError(`„tail" ist eine ganze Zahl von ${MIN_TAIL} bis ${MAX_TAIL}; „0" ist beim Agenten ein anderer Strom.`);
  }

  const path = `/containers/${encodeURIComponent(containerId)}/logs-stream?tail=${tail}`;
  const response = await agentStream(target, path, options);
  const body = streamBodyOf(response, path);
  // Ab hier ist der Status vergeben. Alles Weitere steht im Strom.
  options.onOpen?.();

  // ⚠️ LINE SPLITTING LIVES IN THE ONE READER OF `contract` (#252), shared
  // with every other stream on server and web; its special cases were all
  // wrong once. What stays here is the knowledge of THIS stream: which kinds
  // it sends and what they mean.
  //
  // Since #272 every line is checked against `logsStreamLineSchema`; one that
  // does not fit, or of an unknown kind, is dropped (`parseStreamLine`).
  await readNdjson(body, options, (record) => {
    const line = parseStreamLine(logsStreamLineSchema, record);
    if (line?.kind === "line") {
      // ⚠️ ZURÜCKGEGEBEN UND NICHT NUR GERUFEN. Der Gegendruck des Aufrufers
      // ist das Ergebnis dieses Rückrufs; wer ihn hier fallen lässt, hat die
      // Bremse zwar gebaut, aber nicht angeschlossen.
      return onLine({ stream: line.stream, ts: line.ts ?? "", text: line.text });
    }
    if (line?.kind === "start") {
      options.onStart?.({ containerName: line.containerName, tty: line.tty });
      return;
    }
    if (line?.kind === "error") {
      options.onFailure?.({ reason: line.reason ?? null });
    }
  });
}
