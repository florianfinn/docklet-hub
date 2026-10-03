import type { Messages } from "use-intl";

import { errorCode } from "../../platform/http/transport";
import { knownKey } from "../../platform/i18n/wire-labels";

// Was der Hub sagt, wenn die Shell nicht aufgeht — und wie daraus ein Satz
// wird (Paket B6, Etappe E6, #5).
//
// Keine Komponente: `t` steht bei den Aufrufern, hier steht nur die Zuordnung.
// Dieselbe Bauart wie `features/files/file-errors.ts` und
// `hosts/host-errors.ts`.
//
// ── ZWEI TABELLEN UND NICHT EINE ────────────────────────────────────────────
//
// Vorbild `features/logs/log-errors.ts`: `ERROR_KEY_BY_STATUS` für das, was VOR der ersten
// Zeile kommt, `FAILURE_KEY_BY_REASON` für das, was IM Strom steht. Die
// Trennlinie ist keine Formsache, sie gilt auch im Text: vor der ersten Zeile
// hat die Shell gar nicht erst aufgemacht (der Mensch kann etwas tun — eine
// andere Shell schließen, den Container starten, den Kill-Switch umlegen); im
// Strom lief sie und ist beendet worden.
//
// ⚠️ ABGEBILDET WIRD DIE KENNUNG UND NICHT DER STATUS. An dieser Fläche heißt
// ein `429` zwei verschiedene Dinge (`too-many-sessions` und
// `own-session-limit`), ein `409` drei (`agent-outdated`,
// `container-not-running`, `no-shell`), ein `404` zwei und ein `503` zwei. Die
// Abbildung nach dem Status, die der Log-Ansicht genügt, träfe hier für die
// erste Aufrufstelle zu und für die späteren nicht — genau der Fall, den B5
// mit `share-unset` / `share-unknown` / `file-changed` schon einmal hatte.

/**
 * Die Fehlerkennung aus dem Rumpf einer Antwort, oder `null`.
 *
 * ⚠️ `ApiError.message` TRÄGT DEN RUMPF ALS JSON-TEXT — `readErrorDetail` legt
 * ihn dort mit `JSON.stringify` ab (`web/src/platform/http/transport.ts`). Der Hub
 * schickt `{ error, message }` (`failWith` in
 * `server/src/platform/http/route-responses.ts`), und `error` ist der maschinenlesbare
 * Teil. Der Satz daneben ist deutsche Prosa des Servers und wird hier
 * ausdrücklich NICHT angezeigt: er richtet sich an den Betreiber und steht
 * nur auf Deutsch da, während diese Fläche zwei Sprachen kennt.
 */
export function execErrorKey(error: unknown): string | null {
  // Die Zerlegung selbst steht seit #188 einmal, in `platform/http/transport.ts`.
  return errorCode(error);
}

/**
 * Jede Kennung, mit der der Hub eine Shell ablehnen kann — abgelesen an
 * `server/src/features/shell/routes.ts`, `server/src/domain/hosts/container-access.ts`
 * (`openContainerAccess`) und `server/src/platform/auth/require-admin.ts`, nicht aus einer
 * Liste übernommen.
 *
 * ⚠️ `too-many-sessions` UND `own-session-limit` SIND BEIDE `429` UND HABEN
 * VERSCHIEDENE TEXTE. Bei der einen ist der Deckel des ARMS erreicht (vier
 * Sitzungen, für alle Menschen zusammen) und man wartet, bis jemand anderes
 * eine Shell schließt; bei der anderen ist der eigene Deckel erreicht (zwei)
 * und man schließt seine eigene. Ein gemeinsamer Satz gäbe der Hälfte der
 * Leser den falschen Rat.
 *
 * ⚠️ DREI DAVON GEHÖREN NUR DEN DREI KURZEN ROUTEN (`session-unknown`,
 * `invalid-input`, `input-too-large`) und können erst auftreten, wenn die
 * Shell schon lief. Sie stehen trotzdem in DIESER Tabelle und nicht in der
 * zweiten: sie kommen als Statuscode einer Antwort und nicht als Zeile im
 * Strom, und die Trennlinie dieser Datei ist genau die.
 */
const ERROR_KEY_BY_REASON: Record<string, keyof Messages> = {
  // requireAdmin — vor allem anderen.
  "unauthenticated": "shellErrorUnauthenticated",
  "admin-required": "shellErrorAdminRequired",
  // openContainer — der Weg zum Arm.
  "host-unknown": "shellErrorHostUnknown",
  "host-unreachable": "shellErrorHostUnreachable",
  "agent-outdated": "shellErrorAgentOutdated",
  "container-unknown": "shellErrorContainerUnknown",
  // Der Deckel des Hubs, vor jedem Aufruf am Arm.
  "own-session-limit": "shellErrorOwnSessionLimit",
  // Die Ablehnungen des Agenten, übersetzt vom Hub.
  "container-not-running": "shellErrorContainerNotRunning",
  "no-shell": "shellErrorNoShell",
  "too-many-sessions": "shellErrorTooManySessions",
  "agent-read-only": "shellErrorAgentReadOnly",
  "agent-forbidden": "shellErrorAgentForbidden",
  // `observe-only` of the agent (v0.30.0, #234): the container is released for
  // looking only. Own text, because the remedy differs from `agent-forbidden`.
  "container-observe-only": "shellErrorContainerObserveOnly",
  // Dieselbe `403`, aber von der Herkunftsprüfung des Hubs (#188), bevor
  // die Anfrage den Arm erreicht.
  "forbidden-origin": "errorOriginRefused",
  "agent-unreachable": "shellErrorAgentUnreachable",
  // Die drei kurzen Routen.
  "session-unknown": "shellErrorSessionUnknown",
  "invalid-input": "shellErrorInvalidInput",
  "input-too-large": "shellErrorInputTooLarge"
};

/**
 * Die drei Gründe, die der Hub IM Strom schicken kann — Wort für Wort die aus
 * `contract/src/stream/hub-stream-reasons.ts` (`HUB_SHELL_STREAM_REASONS`).
 *
 * ⚠️ SIE SIND ENGLISCH, WEIL DER HUB SIE ERFINDET. Der Agent schickt im
 * Exec-Strom keine `error`-Zeile; jeder Grund hier entsteht in
 * `server/src/features/shell/routes.ts` (AGENTS.md, Abschnitt Sprache). Bis #173 stand über dieser
 * Tabelle das Gegenteil — „deutsch, weil Werte der Gegenseite" —, und die
 * Werte hießen `recht-entzogen` und `abgebrochen`. Beides stimmte nicht: sie
 * entstanden im Hub, und `abgebrochen` war zugleich das Wort, mit dem der
 * Agent bis v0.23.0 den Abbruch des Aufrufers meinte.
 *
 * ⚠️ EIN ABBRUCH DES BROWSERS HAT KEINEN EINTRAG. Der Hub schweigt dann, weil
 * niemand mehr zuhört; ein Satz dafür wartete auf etwas, das nie eintrifft.
 *
 * ⚠️ EIN VIERTER GRUND FÄLLT ABSICHTLICH DURCH und wird nicht verschluckt —
 * dieselbe Entscheidung wie bei `FAILURE_KEY_BY_REASON` in `features/logs/log-errors.ts`. Er
 * landet im Rückfallsatz mit dem rohen Wort darin, weil das mehr ist als „ein
 * Fehler ist aufgetreten". Ein Hub vor #173 schickt so weiter `abgebrochen`
 * und `recht-entzogen`, und beide kommen roh an.
 *
 * Ein Wächter hält die Schlüssel gegen den Server und gegen jeden Satz des
 * Agenten (`web/tests/hub-stream-reasons.test.mjs`).
 */
const FAILURE_KEY_BY_REASON: Record<string, keyof Messages> = {
  // Die wiederholte Rechteprüfung neben der laufenden Shell.
  "permission-revoked": "shellFailureRevoked",
  // Der Hub hat die Shell auf Auftrag beendet: `close` oder der Sweep.
  "session-closed": "shellFailureClosed",
  // Die Leitung zum Arm endete ohne Abschluss — abgerissen oder vom Agenten
  // fallen gelassen. Derselbe Wortlaut wie im Log-Strom.
  "agent-stream-broken": "shellFailureAgentBroken"
};

/**
 * Der Sprachschlüssel zu einer Ablehnung — oder `null`.
 *
 * ⚠️ ÜBER `knownKey` UND NICHT ÜBER `TABELLE[wert]`. Der Index kommt von der
 * GEGENSEITE; `tsc` erlaubt den direkten Zugriff ohne `| undefined`, und eine
 * Kennung aus einer neueren Fassung des Hubs ergäbe zur Laufzeit ein
 * `undefined`, das `use-intl` still in einen leeren Text verwandelt (gemessen
 * am 2026-09-07, siehe `i18n/wire-labels.ts`). `null` zwingt die Aufrufstelle,
 * selbst zu sagen, was dann dasteht.
 */
export function shellErrorMessageKey(reason: string): keyof Messages | null {
  return knownKey(ERROR_KEY_BY_REASON, reason);
}

/** Dasselbe für einen Grund aus der `error`-Zeile. */
export function shellFailureMessageKey(reason: string): keyof Messages | null {
  return knownKey(FAILURE_KEY_BY_REASON, reason);
}

/**
 * Die Kennungen, die diese Datei führt — für den Wächter und für nichts sonst.
 *
 * ⚠️ SIE STEHT HIER UND NICHT IM TEST. Ein Testfall, der die Liste selbst
 * führte, wäre eine zweite Abschrift derselben Tabelle: er bliebe grün, wenn
 * beide dieselbe Kennung vergessen. So liest er die Tabelle und hält sie gegen
 * die Kennungen, die er im Quelltext des SERVERS findet.
 */
export const SHELL_ERROR_REASONS: readonly string[] = Object.keys(ERROR_KEY_BY_REASON);

/** Dasselbe für die Gründe im Strom. */
export const SHELL_FAILURE_REASONS: readonly string[] = Object.keys(FAILURE_KEY_BY_REASON);
