// The calls of the feature `logs` to the hub (#258): the log stream of a
// container and the log settings. Moved here from `web/src/api/client.ts`
// unchanged; the reasons stand at each call.
//
// ⚠️ THE MIRROR GUARD READS THIS FILE: `web/tests/client-files.mjs` collects
// every `api.ts` under `web/src/` next to `platform/http/`, so a
// call here is held against the routes of the server like any other.

import {
  isAbort,
  logSettingsResponseSchema,
  readNdjson,
  settingsSchema,
  type LogSettings,
  type LogTailLines
} from "contract";

import { ApiError, parseResponse, putJson, readErrorDetail, request } from "../../platform/http/transport";

// ── The log settings (#5, stage G/H1) ───────────────────────────────────────

/**
 * The log settings of the hub, read from `GET /api/settings`.
 *
 * ⚠️ THE SAME ROUTE AS the other readers of `GET /api/settings` (until #271
 * `fetchSettings` in `web/src/api/client.ts`), parsed with the same schema;
 * the panel only needs `logs`. A feature imports no other feature, and a
 * second route for one field would be a second truth on the server.
 */
export async function fetchLogSettings(): Promise<LogSettings> {
  const settings = parseResponse("/api/settings", settingsSchema, await request("/api/settings"));
  return settings.logs;
}

/**
 * Die Zeilenzahl der Logansicht ablegen (Admin, #5).
 *
 * ⚠️ THE PARAMETER IS A NUMBER, one of the four, not a string. The server
 * checks STRICTLY for `typeof value === "number"` (`normalizeLogTailLines` in
 * `server/src/features/logs/store.ts`) and rejects a `"500"` with
 * `400 { error: "invalid-input" }` instead of converting it.
 *
 * ⚠️ DIE UMWANDLUNG GEHÖRT NICHT HIERHER, sondern an die eine Stelle, an der
 * die Zeichenkette überhaupt entsteht: das Auswahlfeld der Tafel
 * (`LogSettingsPanel.tsx` next to this file) bekommt von Radix einen
 * `string` und sucht sich daraus den passenden Eintrag aus
 * `LOG_TAIL_LINE_OPTIONS`. Das ist Umwandlung UND Prüfung in einem Schritt —
 * ein `Number(picked)` hier ergäbe bei jeder anderen Eingabe ein `NaN`, das
 * erst der Server bemerkt. Bliebe die Umwandlung hier, nähme diese Signatur
 * `string | number` an, und jede weitere Aufrufstelle dürfte wieder raten.
 * Der Union-Typ `LogTailLines` macht eine Zeichenkette schon beim Übersetzen
 * unmöglich.
 *
 * ⚠️ The return type is the ENVELOPE, not the bare object: the route answers
 * with `{ logs: { tailLines } }`, and since #248 the answer is parsed against
 * `logSettingsResponseSchema`. A bare `Promise<LogSettings>` was the
 * `createHost` bug until D7a (#82).
 *
 * `PUT` und nicht `POST`: derselbe Aufruf zweimal ergibt denselben Zustand.
 */
export async function setLogTailLines(tailLines: LogTailLines): Promise<{ logs: LogSettings }> {
  const path = "/api/settings/logs";
  return parseResponse(path, logSettingsResponseSchema, await putJson(path, { logs: { tailLines } }));
}

// ── Der Log-Strom eines Containers (#5, Etappe H) ───────────────────────────
//
// ⚠️ DIESER AUFRUF LÄUFT NICHT ÜBER `request<T>`, und das ist kein Versehen.
// `request` liest den Rumpf mit `response.json()` AM STÜCK; hier gehört er dem
// Leser, der ihn Zeile für Zeile durchreicht. Ein Strom, der erst vollständig
// gelesen und dann ausgeliefert wird, ist keiner — und das fiele in einem Test
// mit drei Zeilen nicht auf, sondern erst an einem Container, der eine Stunde
// redet.
//
// ⚠️ DER SPIEGELWÄCHTER SIEHT DIESEN AUFRUF — seit Etappe B4b-L (#5) und nicht
// vorher. `web/tests/api-mirror.test.mjs` sammelte Aufrufe lange nur über die
// vier Helfer `request`, `requestNoContent`, `postJson`, `putJson`; dieser hier
// benutzt keinen davon und lief deshalb an ihm vorbei. Was das kostete, wurde
// gemessen: die Route einseitig von `logs-stream` auf `logs-strom` umbenannt,
// den Servertest mitgezogen, diese Datei unverändert gelassen — die ganze Kette
// blieb grün, und der Browser wäre in eine 404 gelaufen.
//
// Ein zweiter Leser dort liest jetzt auch Aufrufe, die unmittelbar `fetch`
// benutzen, und hält sie gegen die angemeldeten Routen:
//
//   GET /api/hosts/:hostId/containers/:containerId/logs-stream?tail=N
//   (server/src/features/logs/routes.ts, hinter `withSession`,
//    ohne `requireAdmin` — Logs lesen ist eine Fähigkeit der Rolle User)
//
// ⚠️ GEPRÜFT WERDEN PFAD UND METHODE, NICHT DER UMSCHLAG. Das ist keine
// Nachlässigkeit, sondern die Grenze der Frage: der Wächter vergleicht sonst
// die obersten Schlüssel der Antwort mit dem, was der Router im Erfolgsfall
// per `.json(…)` sendet — hier sendet er nichts dergleichen. Ein NDJSON-Strom
// hat keinen Umschlag; auf der Gegenseite gäbe es nichts zu vergleichen. Was
// unter den Zeilen steht (`LogLine`, `LogStreamStart`, `LogStreamFailure`),
// bleibt damit eine Abschrift, die niemand gegenprüft.
//
// ⚠️ `credentials: "include"` steht hier von Hand, GENAU SO wie `request` es
// setzt. Ohne das Merkmal schickt der Browser das Sitzungscookie bei einem
// Aufruf über eine andere Adresse als die des Dokuments nicht mit, und die
// Antwort wäre eine 401, die wie eine abgelaufene Anmeldung aussieht.

/** Eine Zeile des Container-Logs, mit ihrem Kanal. */
export type LogLine = { stream: "stdout" | "stderr"; ts: string; text: string };

/** Die erste Zeile jedes Stroms. `tty` entscheidet, ob es zwei Kanäle gibt. */
export type LogStreamStart = { containerName: string; tty: boolean };

/**
 * Ein Fehler, der IM Strom steht.
 *
 * ⚠️ Nach der ersten Zeile ist das die EINZIGE Form, in der ein Fehler noch
 * auftreten kann — der Statuscode steht da längst fest. Eine Fehlerbehandlung,
 * die auf einen Statuscode wartet, wartet vergeblich.
 *
 * `reason` bleibt eine Zeichenkette und keine Aufzählung: der Agent kennt heute
 * vier Werte (`LOG_STREAM_FAILURE_REASONS`), der Hub einen eigenen
 * (`HUB_STREAM_BROKEN`), und ein weiterer Wert morgen soll durchgereicht werden
 * statt am Parser zu scheitern.
 *
 * ⚠️ `null` HEISST: DIE ZEILE TRUG KEINEN GRUND (#176). Hier wird kein Wort
 * eingesetzt — bis #176 stand an dieser Stelle `unbekannt`, und die Anzeige
 * zeigte es als Klammer, die wie eine Auskunft aussah.
 */
export type LogStreamFailure = { reason: string | null };

export type LogStreamOptions = {
  /**
   * Wie viele Zeilen Vergangenheit.
   *
   * ⚠️ FREIWILLIG. Fehlt die Angabe, nimmt der Server die globale Einstellung
   * des Betreibers (Etappe G) — das ist der Normalfall und keine Lücke. Ist sie
   * da, muss sie eine ganze Zahl von 1 bis 2000 sein; alles andere beantwortet
   * der Server mit `400 { error: "invalid-tail" }`.
   */
  tail?: number;
  /**
   * ⚠️ PFLICHT und nicht optional. Ohne Abbruch belegt dieser Leser einen der
   * gleichzeitigen Ströme des Arms (`MAX_OPEN_STREAMS` in `contract`), bis der
   * Arm es selbst merkt. So viele verlassene Reiter, und der Arm antwortet
   * allen mit `429`.
   */
  signal: AbortSignal;
  onStart?: (start: LogStreamStart) => void;
  onFailure?: (failure: LogStreamFailure) => void;
  /**
   * Der Strom steht: der Hub hat mit `200` geantwortet, gelesen wurde noch
   * nichts.
   *
   * ⚠️ Der Aufrufer braucht genau DIESEN Zeitpunkt und nicht die erste Zeile.
   * Bis hierher kann ein Fehler noch ein Statuscode sein, ab hier nicht mehr.
   * Wer stattdessen auf die erste Zeile wartet, hängt seinen Ladezustand an die
   * Gesprächigkeit des Containers — ein ruhiger Container sähe aus wie eine
   * Anfrage ohne Antwort.
   */
  onOpen?: () => void;
};

/**
 * Liest den Log-Strom eines Containers und ruft JE ZEILE zurück.
 *
 * Kein Sammeln und kein Rückgabewert am Ende: die Zusage lautet, dass `onLine`
 * läuft, sobald die Zeile da ist — nicht, wenn der Container aufhört zu reden.
 *
 * ⚠️ DER STROM ENDET VON SELBST PRAKTISCH NIE. Die Engine hängt mit `follow=1`
 * am laufenden Log; er endet, wenn der Container verschwindet — oder wenn der
 * Aufrufer über `options.signal` abbricht. Der Abbruch ist der NORMALFALL und
 * kein Fehler: der Mensch hat den Reiter geschlossen. Er endet hier still,
 * statt als `AbortError` nach oben zu blubbern.
 *
 * Fehler VOR der ersten Zeile kommen als `ApiError` mit dem Statuscode heraus
 * (400 `invalid-tail`, 403 `agent-forbidden`, 404 `host-unknown`,
 * 429 `too-many-streams`, 502 `agent-unreachable`), damit die Fläche sie
 * unterscheiden kann.
 */
export async function streamContainerLogs(
  hostId: string,
  containerId: string,
  options: LogStreamOptions,
  onLine: (line: LogLine) => void
): Promise<void> {
  const query = options.tail === undefined ? "" : `?tail=${encodeURIComponent(String(options.tail))}`;
  const path =
    `/api/hosts/${encodeURIComponent(hostId)}` +
    `/containers/${encodeURIComponent(containerId)}/logs-stream${query}`;

  let response: Response;
  try {
    response = await fetch(path, { credentials: "include", signal: options.signal });
  } catch (error) {
    // Auch der Abbruch WÄHREND des Verbindens ist keiner: der Reiter war
    // schneller zu, als der Hub antworten konnte.
    if (isAbort(options.signal, error)) return;
    throw error;
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorDetail(response));
  }
  const body = response.body;
  if (!body) {
    throw new ApiError(response.status, `Die Antwort auf „${path}“ trug keinen Rumpf.`);
  }
  // Ab hier ist der Status vergeben. Alles Weitere steht im Strom.
  options.onOpen?.();

  // ⚠️ LINE SPLITTING LIVES IN THE ONE READER OF `contract` (#252), the same
  // the server uses for the agent's streams. What stays here is the
  // knowledge of THIS stream.
  //
  // ⚠️ THE KINDS ARE THE AGENT'S. `start`, `line` and `error` are the words
  // of `contract/src/agent/streams.ts` (English since #278); the hub passes
  // the envelope on unchanged, it mirrors it instead of translating it.
  // Whoever renames one here builds a surface that shows no line at all —
  // silently, because an unknown `kind` simply falls through.
  //
  // The hub's own words are the error identifiers `invalid-tail`,
  // `agent-forbidden`, `host-unknown`, `too-many-streams`,
  // `agent-unreachable`. They come BEFORE the first line, with the status
  // code, and not in here (`translateAgentError`, agent-error-translation.ts).
  //
  // ⚠️ EINE EINZIGE AUSNAHME STEHT SEIT #130 DOCH IM STROM: `reason` trägt
  // `agent-stream-broken`, wenn der Rumpf zwischen Hub und Arm abreißt,
  // nachdem der Status vergeben ist. Das ist ein Wort des Hubs, also englisch,
  // und es steht bewusst NEBEN den vier Gründen des Agenten statt unter ihnen —
  // sonst hieße derselbe Wortlaut zweierlei. Bis #130 schrieb der Hub hier
  // `abgebrochen` und belegte damit den Wert neu, mit dem der Agent bis
  // v0.23.0 den Abbruch des Aufrufers meinte.
  await readNdjson(body, { signal: options.signal }, (record) => {
    if (record.kind === "line") {
      onLine({
        stream: record.stream === "stderr" ? "stderr" : "stdout",
        ts: typeof record.ts === "string" ? record.ts : "",
        text: typeof record.text === "string" ? record.text : ""
      });
      return;
    }
    if (record.kind === "start") {
      options.onStart?.({
        containerName: typeof record.containerName === "string" ? record.containerName : "",
        tty: record.tty === true
      });
      return;
    }
    if (record.kind === "error") {
      options.onFailure?.({ reason: typeof record.reason === "string" ? record.reason : null });
    }
  });
}

