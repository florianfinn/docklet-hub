import type { useTranslations } from "use-intl";

import { ApiError, isOriginRefused } from "../../platform/http/transport";

// What a failed log stream says on the screen (#258): the text keys for a
// failure BEFORE the first line (by status) and for a failure line IN the
// stream (by reason). Shared by `LogView` and `StackLogView`.
//
// ⚠️ TWO GUARDS READ THE TABLES AT THIS PATH since #258
// (`web/tests/agent-protocol-values.test.mjs`, `web/tests/hub-stream-reasons.test.mjs`);
// until then they stood in `LogView.tsx`. They moved out because `LogView` is
// loaded lazily, and a static import of it from `StackLogView` would have
// pulled it into the stack's chunk. A move that leaves the guards reading the
// old path blinds them (AGENTS.md: "Eine Aufteilung, die einen Wächter blind
// macht, …"); both read this file now.

/**
 * Die Fehlertexte VOR der ersten Zeile, je Statuscode einer.
 *
 * ⚠️ SECHS STATUSCODES, SECHS TEXTE. „Es ist ein Fehler aufgetreten" wäre für
 * diese sechs keine Auskunft: 429 heißt warten, 403 heißt „schau in die
 * Allowlist des Arms", 404 heißt „den Arm gibt es nicht mehr". Wer nur einen
 * Satz zeigt, verschiebt die Diagnose zum Menschen, der die Statuscodes nicht
 * sieht.
 *
 * ⚠️ KEIN 401 IN DIESER TABELLE, UND DAS IST DER FALL AUS #127. Eine
 * abgelaufene Sitzung ist kein Fehler DIESER Fläche: der Strom scheitert
 * daran, aber die Antwort darauf gilt dem ganzen Fenster und lautet
 * „zurück zur Anmeldung". Sie steht in `web/src/App.tsx`, gemeldet vom
 * Konstruktor des `ApiError` (`web/src/platform/http/transport.ts`) — und der Weg
 * dorthin führt auch über die Zeile unten, die den Strom aufsetzt
 * (`api.ts`, `throw new ApiError(response.status, …)`). Ein siebter
 * Eintrag hier zeigte einen Satz auf einer Fläche, die im selben Augenblick
 * dem Anmeldebildschirm weicht.
 *
 * ⚠️ DER STATUS TRÄGT DIESE TABELLE, MIT EINER AUSNAHME. Der Hub schickt zu
 * jedem Fall eine Kennung (`invalid-tail`, `agent-forbidden`, `host-unknown`,
 * `agent-outdated`, `too-many-streams`, `agent-unreachable`), und bis auf eine
 * steht sie eins zu eins zum Status. Die eine ist `403`: sie kommt auch als `forbidden-origin`
 * von der Herkunftsprüfung des Hubs, ohne dass der Arm gefragt wurde
 * (`isOriginRefused`, #188). Gemessen am 2026-09-29: über reines HTTP stand
 * hier auf jedem Arm der Satz über die Allowlist, und kein Arm hatte etwas
 * abgelehnt. Diese Kennung wird deshalb VOR der Tabelle gelesen; der Rest
 * bleibt beim Status.
 */
export type LogErrorKey =
  | "logErrorInvalidTail"
  | "logErrorForbidden"
  | "errorOriginRefused"
  | "logErrorHostUnknown"
  | "logErrorAgentOutdated"
  | "logErrorTooManyStreams"
  | "logErrorUnreachable"
  | "logErrorUnknown";

const ERROR_KEY_BY_STATUS: Record<number, LogErrorKey> = {
  400: "logErrorInvalidTail",
  403: "logErrorForbidden",
  404: "logErrorHostUnknown",
  // `agent-outdated`: an arm below the current contract, whose lines the
  // reader would drop (`server/src/features/logs/service.ts`).
  409: "logErrorAgentOutdated",
  429: "logErrorTooManyStreams",
  502: "logErrorUnreachable"
};

/**
 * Die Anzeige der Fehlergründe, die der AGENT im Strom schickt — eins zu eins
 * zu `LOG_STREAM_FAILURE_REASONS`, aber ausdrücklich NICHT dieselbe Sache.
 *
 * ⚠️ `reason` IST EIN WERT DER GEGENSEITE. AGENTS.md: „Einen Wert der
 * Gegenseite spiegelt der Hub wörtlich und übersetzt ihn nicht." Genau daran
 * hält sich diese Tabelle: sie ändert `failure.reason` selbst nicht (der bleibt
 * in `StreamState` eine bloße Zeichenkette, roh vom Agenten), sie entscheidet
 * nur, welcher SATZ dafür auf dem Bildschirm steht. Das ist Anzeige, keine
 * Übersetzung der Leitung.
 *
 * ⚠️ DER SATZ IST HEUTE GESCHLOSSEN — gemessen am Agenten selbst, nicht
 * vermutet: der Agent kennt an dieser Stelle genau vier Werte
 * (`agent/src/stream-failure-reasons.ts`). Bis v0.23.0 waren es
 * zwei, `abgebrochen` und `logs-fehlgeschlagen`; #80 hat den Sammeleimer nach
 * Ursache aufgelöst und den Abbruch ganz aus dem Satz genommen. Ein Wächter
 * hält diese Tabelle gegen `LOGS_STREAM_FAILURE_REASONS`
 * (`web/tests/agent-protocol-values.test.mjs`).
 *
 * ⚠️ EIN FÜNFTER WERT FÄLLT ABSICHTLICH DURCH UND WIRD NICHT VERSCHLUCKT. Eine
 * neuere Agentenfassung kann eines Tages einen weiteren Grund schicken; er
 * landet dann unverändert im bestehenden `logStreamFailed`
 * („… ({reason}).") mit dem rohen Wort darin. Ein `default`-Zweig, der „ein
 * Fehler ist aufgetreten" zeigte, wäre hier falsch: er nähme dem Menschen
 * genau die Auskunft, die roh noch auf der Leitung stand. Derselbe Weg trägt
 * einen ALTEN Arm: ein Container auf v0.23.0 schickt weiter `abgebrochen` und
 * `logs-fehlgeschlagen`, und beide kommen roh an, statt an einem Parser zu
 * scheitern.
 */
type LogFailureKey =
  | "logStreamFailedContainerGone"
  | "logStreamFailedEngineRefused"
  | "logStreamFailedEngineUnreachable"
  | "logStreamFailedUnreadable";

const FAILURE_KEY_BY_REASON: Record<string, LogFailureKey> = {
  // Zwischen dem `inspect` des Agenten und jetzt entfernt. Der nächste Schritt
  // ist ein anderer als bei den drei übrigen: diese Ansicht hat kein Ziel mehr.
  "container-gone": "logStreamFailedContainerGone",
  // Die Engine hat die Route abgelehnt — nachsehen, womit.
  "engine-refused": "logStreamFailedEngineRefused",
  // Der Socket zur Engine ist gerissen. Meist ein Daemon, der neu anläuft.
  "engine-unreachable": "logStreamFailedEngineUnreachable",
  // Der verbliebene Sammelwert: alles, was keiner der drei benannten Fälle
  // ist. Die genaue Ursache steht nicht auf der Leitung, sondern im Audit-Log
  // des Agenten auf dem Zielhost — und genau das sagt der Text auch.
  "logs-failed": "logStreamFailedUnreadable"
};

/**
 * Und daneben die Gründe, die DER HUB SELBST schreibt (#130).
 *
 * ⚠️ EINE ZWEITE TABELLE UND NICHT ZWEI EINTRÄGE MEHR IN DER ERSTEN. Die
 * beiden Sätze haben verschiedene Herkunft und verschiedene Lebensdauer: der
 * obere ändert sich, wenn der Agent seine Fehler anders auflöst, dieser hier
 * nur, wenn der Hub seine eigene Naht ändert. In einer gemeinsamen Tabelle
 * könnte der Wächter sie nicht mehr gegen `LOG_STREAM_FAILURE_REASONS` halten,
 * ohne den Wert des Hubs als Abweichung zu melden — und die naheliegende
 * Abhilfe wäre eine Ausnahme im Wächter statt einer Trennung im Code.
 *
 * ⚠️ Bis #130 stand hier gar nichts: der Hub schrieb `abgebrochen` und damit
 * das Wort, mit dem der Agent bis v0.23.0 den Abbruch DES AUFRUFERS meinte.
 * Ein Ausfall des Arms und ein geschlossener Reiter kamen als derselbe Wert an.
 */
const HUB_FAILURE_KEY_BY_REASON: Record<string, "logStreamFailedHubBroken"> = {
  // ⚠️ Same word as `HUB_STREAM_BROKEN`
  // (`contract/src/stream/hub-stream-reasons.ts`). A guard keeps both
  // places together and both sets apart
  // (`web/tests/hub-stream-reasons.test.mjs`).
  "agent-stream-broken": "logStreamFailedHubBroken"
};

/**
 * Der Textschlüssel zu einem Fehler VOR der ersten Zeile.
 *
 * ⚠️ AUSGEFÜHRT, WEIL EIN ZWEITER LESER DAZUKAM: der Reiter „Protokoll" der
 * Stack-Seite (#183) öffnet dieselben Ströme und zeigt dieselben Fehler. Die
 * Tabellen bleiben HIER stehen und wandern nicht in eine eigene Datei — zwei
 * Wächter lesen sie an genau diesem Pfad (`web/tests/agent-protocol-values.test.mjs`,
 * `web/tests/hub-stream-reasons.test.mjs`), und eine Verschiebung machte sie
 * blind (AGENTS.md: „Eine Aufteilung, die einen Wächter blind macht, …").
 */
export function logErrorKey(error: unknown): LogErrorKey {
  if (isOriginRefused(error)) return "errorOriginRefused";
  const status = error instanceof ApiError ? error.status : 0;
  return ERROR_KEY_BY_STATUS[status] ?? "logErrorUnknown";
}

/** Der Satz zu einem Fehler IM Strom — für beide Ansichten derselbe Weg. */
export function logFailureText(t: ReturnType<typeof useTranslations>, reason: string | null): string {
  // Eine Zeile ohne Grund (#176): ein eigener Satz ohne Klammer.
  if (reason === null) return t("logStreamFailedWithoutReason");
  // ⚠️ ZWEI TABELLEN, IN DIESER REIHENFOLGE — und die Reihenfolge ist
  // gleichgültig, solange sie sich keinen Wortlaut teilen. Genau das hält der
  // Wächter fest: teilten sie sich einen, entschiede diese Zeile
  // stillschweigend für den Agenten, und der Grund des Hubs käme nie an.
  const failureKey = FAILURE_KEY_BY_REASON[reason] ?? HUB_FAILURE_KEY_BY_REASON[reason];
  // Bekannt: der eigene, nützliche Satz. Unbekannt: der Rückfall auf
  // `logStreamFailed`, mit dem rohen Wort darin — siehe die Kommentare bei
  // `FAILURE_KEY_BY_REASON`.
  return failureKey === undefined ? t("logStreamFailed", { reason }) : t(failureKey);
}
