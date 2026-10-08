import { sourceBlockerKeys } from "./source-blockers";
import type { FileAccessError } from "contract";
import type { Messages } from "use-intl";

import { ApiError, errorCode, isOriginRefused } from "../../platform/http/transport";

// Was der Server sagt, wenn die Datei-Fläche nicht arbeiten kann — und wie
// daraus ein Satz wird.
//
// Keine Komponente: `t` steht bei den Aufrufern, hier steht nur die Zuordnung
// (dieselbe Bauart wie `features/hosts/host-errors.ts`).

/**
 * Ob dieser Fehler bedeutet: „für diesen Container ist keine Freigabe gewählt".
 *
 * ⚠️ DAS IST DER NORMALFALL VOR DER ERSTEN WAHL UND KEINE STÖRUNG. Es gibt
 * keine Route, die nach der gewählten Freigabe fragt; die Auskunft steckt in
 * der Antwort auf die Liste (`requireShare` in
 * `server/src/features/files/service.ts` antwortet `409` mit `share-unset`). Eine
 * eigene Route dafür wäre eine zweite Quelle für dieselbe Frage und könnte von
 * der Liste abweichen.
 *
 * ⚠️ GEPRÜFT WIRD DER CODE UND NICHT NUR DER STATUS. Die Route `PUT …/share`
 * antwortet ebenfalls mit `409`, dann aber mit `share-unknown` — ein Pfad, den
 * die Kandidatenliste nicht führt. Beides als „keine Freigabe gewählt" zu
 * lesen, schickte den Betreiber in die Wahl zurück, die er gerade getroffen hat.
 */
export function isShareUnset(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) === "share-unset";
}

/**
 * Der Satz zu einem Fehler der Datei-Fläche.
 *
 * ⚠️ JEDER STATUS MIT EIGENEM GRUND BEKOMMT EINEN EIGENEN SATZ. Ein
 * gesammeltes „Fehlgeschlagen" für `403`, `404`, `502` und `504` nähme dem
 * Betreiber genau die Auskunft, wegen der er hinschaut: eine `403` ist die
 * Allowlist des Arms, eine `404` ein Pfad, den es nicht mehr gibt, eine `502`
 * der Arm selbst. Dieselbe Entscheidung wie bei `ERROR_KEY_BY_STATUS` in
 * `features/logs/log-errors.ts`.
 */
const MESSAGE_BY_STATUS: Record<number, keyof Messages> = {
  400: "fileErrorInvalidPath",
  403: "fileErrorForbidden",
  404: "fileErrorNotFound",
  409: "fileErrorShareUnknown",
  // Der Deckel der Gegenseite. Er ist eine Zahl und keine Störung — und die
  // ZAHL steht nicht in unserem Satz: `MAX_TEXT_BYTES` und `MAX_UPLOAD_BYTES`
  // sind Werte des Agenten und stehen ausschließlich in
  // `contract/src/agent/` (`web/tests/agent-protocol-values.test.mjs`).
  413: "fileErrorTooLarge",
  429: "fileErrorTooManyStreams",
  502: "fileErrorAgentUnreachable",
  504: "fileErrorAgentTimeout"
};

/**
 * Die drei `409` dieser Fläche, jeder auf seinen eigenen Satz.
 *
 * ⚠️ DER STATUS ALLEIN REICHT HIER NICHT, und das ist bis Etappe E5b ein
 * Fehler gewesen: `409` bedeutete in `MESSAGE_BY_STATUS` immer
 * `fileErrorShareUnknown` („Dieser Pfad ist kein Bind-Mount dieses
 * Containers"). Für die Liste stimmte das, weil `isShareUnset` in `FilesView`
 * vorher greift — für den Texteditor, das Hochladen und die
 * Ordneroperationen aber nicht: nimmt jemand in einem zweiten Reiter die
 * Freigabe zurück, antwortet der Server `409 share-unset`, und der Betreiber
 * las einen Satz über einen Pfad, den er nie eingegeben hat.
 *
 * `file-changed` steht hier NICHT: das ist kein Fehlersatz, sondern eine Lage
 * mit zwei Auswegen, und `fileChangedHash` fängt ihn davor ab.
 */
const MESSAGE_BY_CONFLICT: Record<string, keyof Messages> = {
  "share-unset": "fileErrorShareUnset",
  "share-unknown": "fileErrorShareUnknown",
  // Der Agent hat abgelehnt, und der Hub kannte den Grund nicht — etwa ein
  // Registry-Anker, der nicht mehr passt.
  "agent-conflict": "fileErrorAgentConflict"
};

export function fileErrorKey(error: unknown): keyof Messages {
  if (!(error instanceof ApiError)) return "fileErrorUnknown";
  try {
    const detail = JSON.parse(error.message) as { reason?: string; error?: string };
    const reason = detail.reason ?? detail.error;
    if (reason && Object.hasOwn(sourceBlockerKeys, reason)) return sourceBlockerKeys[reason as FileAccessError];
  } catch { /* Non-JSON responses use the status fallback. */ }
  // ⚠️ EINE `403` HAT ZWEI ABSENDER (#188). `forbidden-origin` kommt von der
  // Herkunftsprüfung des Hubs, und der Arm hat die Anfrage nie gesehen — der
  // Satz über seine Allowlist aus `MESSAGE_BY_STATUS` wäre falsch.
  if (isOriginRefused(error)) return "errorOriginRefused";
  // ⚠️ EIN `503` IST NUR MIT DIESER KENNUNG DER KILL-SWITCH. Denselben Status
  // sendet der Hub selbst für einen Arm, der `pending` oder `offline` ist
  // (`server/src/domain/hosts/container-access.ts`) — der Status allein trüge den falschen
  // Satz.
  if (error.status === 503 && errorCode(error) === "agent-read-only") return "fileErrorAgentReadOnly";
  if (error.status === 409) {
    // ⚠️ EIN UNBEKANNTER `409` FÄLLT AUF DEN VAGEN SATZ und nicht auf einen der
    // drei oben. Ein zuversichtlich falscher Satz ist schlimmer als ein
    // unbestimmter: er schickt den Betreiber auf die Suche nach einer Ursache,
    // die es nicht gibt. Hierher gehört unter anderem `file-changed`, wenn ihn
    // jemand nicht vorher abfängt — dann steht „konnte nicht" da, und nicht
    // etwas über Bind-Mounts.
    const code = errorCode(error);
    return (code === null ? undefined : MESSAGE_BY_CONFLICT[code]) ?? "fileErrorUnknown";
  }
  return MESSAGE_BY_STATUS[error.status] ?? "fileErrorUnknown";
}

/**
 * Der JETZIGE Hash aus einem Speicherkonflikt des Texteditors — oder `null`,
 * wenn dieser Fehler keiner ist.
 *
 * ⚠️ DIESER `409` IST DER WICHTIGSTE FEHLERFALL DER GANZEN FLÄCHE, und er ist
 * KEIN Fehler im Sinne von `fileErrorKey`. Er heißt: „jemand anderes hat die
 * Datei geändert, seit du sie geladen hast" — und der Server legt den Hash bei,
 * den sie JETZT hat (`server/src/features/files/routes.ts`, der `409`-Zweig
 * von `PUT …/file-text`). Wer ihn wie einen allgemeinen Fehler behandelt, zeigt
 * „ging nicht" und lässt den Betreiber seine Änderung neu tippen; wer ihn ohne
 * den Hash behandelt, kann ihm nicht einmal anbieten, gegen den neuen Stand zu
 * speichern.
 *
 * ⚠️ GEPRÜFT WIRD DER CODE UND NICHT NUR DER STATUS. Auf dieser Fläche gibt es
 * drei verschiedene `409`: `share-unset` (keine Freigabe gewählt),
 * `share-unknown` (ein Pfad, den die Kandidatenliste nicht führt) und dieses
 * `file-changed`. Sie über den Status zusammenzufassen ergäbe drei falsche
 * Sätze aus einem richtigen.
 *
 * ⚠️ OHNE HASH IM RUMPF GIBT ES KEINEN KONFLIKT ZU ZEIGEN. Fehlt er (ein alter
 * Server, ein Zwischending, das den Rumpf ersetzt), fällt der Aufrufer auf den
 * allgemeinen Weg zurück — ein Konfliktkasten mit leerem Hash böte ein
 * „erneut speichern" an, das der Server sofort wieder ablehnte.
 */
export function fileChangedHash(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (errorCode(error) !== "file-changed") return null;
  try {
    const parsed = JSON.parse(error.message) as { hash?: unknown };
    return typeof parsed.hash === "string" && parsed.hash !== "" ? parsed.hash : null;
  } catch {
    return null;
  }
}
