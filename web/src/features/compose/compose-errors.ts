import type { Messages } from "use-intl";

import { ApiError, errorCode } from "../../platform/http/transport";

// Was der Server sagt, wenn die Compose-Fläche nicht arbeiten kann — und wie
// daraus ein Satz wird. Dieselbe Bauart wie `features/files/file-errors.ts`:
// keine Komponente, `t` steht beim Aufrufer, hier steht nur die Zuordnung.

/**
 * Der Grund, den der AGENT nannte, oder `null` (#122: `reason` neben
 * `error` im Rumpf, wörtlich durchgereicht).
 */
export function errorReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.message) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

/**
 * Has the arm found no file for THIS container? (#183)
 *
 * ⚠️ BY THE HUB'S CODE AND NOT BY THE REASON (#185). Next to the agent's
 * `compose-file-missing` the hub sends the three anchor reasons under the same
 * code (`server/src/features/compose/reasons.ts`, `ANCHOR_REASONS`), and all
 * four mean the same for the walk: the next container of the stack is asked.
 */
export function isComposeFileMissing(error: unknown): boolean {
  return errorCode(error) === "compose-file-missing";
}

/** Does the hub offer the selection by hand for this case? (#185) */
export function selectionOffered(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  try {
    return (JSON.parse(error.message) as { selectionSupported?: unknown }).selectionSupported === true;
  } catch {
    return false;
  }
}

/**
 * The sentence for the reason the arm found no file (#185).
 *
 * ⚠️ THE CASES ARE THE AGENT'S KEYS, verbatim (`ComposeRawFailureReason` in
 * `contract/src/agent/compose-reasons.ts`). `compose-file-missing` and a
 * reason this switch does not know get the general sentence of #183. The
 * result is a message key and never a reason: the reason itself stays what
 * the agent sent.
 */
export function anchorReasonKey(reason: string | null): keyof Messages {
  switch (reason) {
    case "compose-anchor-outside-base-path":
      return "composeErrorAnchorOutsideBase";
    case "compose-anchor-file-ambiguous":
      return "composeErrorAnchorAmbiguous";
    case "compose-anchor-labels-missing":
      return "composeErrorAnchorLabelsMissing";
    default:
      return "composeErrorFileMissing";
  }
}

/**
 * Das Verzeichnis, in dem der Arm gesucht hat, oder `null`.
 *
 * ⚠️ Der Hub reicht es seit #183 als `projectDir` neben `compose-file-missing`
 * durch (`server/src/features/compose/reasons.ts`). Es ist das Verzeichnis
 * der SUCHE, nicht zwingend das der Compose-Labels — der Agent fällt bei einem
 * abgelehnten Anker auf `<Basispfad>/<Containername>` zurück
 * (dashboard-docker-agent#102). Der Satz dazu sagt deshalb „gesucht", nicht
 * „liegt".
 */
export function searchedDir(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(error.message) as { projectDir?: unknown };
    return typeof parsed.projectDir === "string" && parsed.projectDir.length > 0 ? parsed.projectDir : null;
  } catch {
    return null;
  }
}

/**
 * Der Textschlüssel zu einem Fehler dieser Fläche.
 *
 * ⚠️ DIE FÄLLE SIND UNTERSCHIEDEN, WEIL SIE UNTERSCHIEDLICHE ANTWORTEN
 * VERLANGEN. „Der Arm ist abgeschaltet", „dieser Container steht nicht auf
 * seiner Allowlist" und „der Arm ist nicht erreichbar" sehen als ein einziges
 * „ging nicht" gleich aus — und schicken den Betreiber an drei verschiedene
 * Stellen, von denen zwei die falschen sind.
 *
 * ⚠️ EIN UNBEKANNTER CODE FÄLLT AUF EINEN ALLGEMEINEN SATZ und wird nicht
 * verschwiegen. Der Hub erfindet seine Kennungen englisch; kommt eine dazu,
 * die diese Zuordnung nicht kennt, sieht der Betreiber lieber einen groben
 * Satz als eine Fläche, die stumm bleibt.
 */
export function composeErrorKey(error: unknown): keyof Messages {
  // ⚠️ DIE KENNUNGEN SIND AM SERVER ABGELESEN und nicht erraten:
  // `openContainerAccess` in `server/src/domain/hosts/container-access.ts`,
  // `describeComposeRejection` in `server/src/features/compose/reasons.ts` und
  // `translateAgentError` in `server/src/platform/http/agent-error-translation.ts`
  // senden genau diese. Wer hier einen Namen hinschreibt, den es dort nicht
  // gibt, baut einen Zweig, der nie läuft — und die Fläche fiele stumm auf den
  // allgemeinen Satz zurück.
  // ⚠️ BEFORE THE `switch`: under `compose-file-missing` stand four reasons
  // of the agent, and only the `reason` next to it says which sentence fits.
  if (isComposeFileMissing(error)) return anchorReasonKey(errorReason(error));
  switch (errorCode(error)) {
    case "host-unknown":
      return "composeErrorHostUnknown";
    case "host-unreachable":
    case "agent-unreachable":
      return "composeErrorUnreachable";
    case "container-unknown":
      return "composeErrorContainerUnknown";
    case "agent-forbidden":
      return "composeErrorNotAllowlisted";
    // Dieselbe `403`, aber von der Herkunftsprüfung des Hubs (#188): der Arm
    // hat die Anfrage nie gesehen.
    case "forbidden-origin":
      return "errorOriginRefused";
    case "agent-outdated":
      return "composeErrorAgentTooOld";
    case "too-large":
      return "composeErrorTooLarge";
    // Beide sind Einstellungen oder Zahlen des Arms und keine Störung (#122).
    case "agent-read-only":
      return "composeErrorReadOnly";
    case "too-many-streams":
      return "composeErrorTooManyStreams";
    // Die Schranke des Hubs vor seinem eigenen Stack (#183).
    case "hub-own-stack":
      return "composeHubOwnStack";
    // The selection by hand (#185): a missing path in the body, and the arm
    // refusing a path, whose reason stands next to `agent-rejected`.
    case "compose-selection-missing":
      return "composeSelectionInvalid";
    case "agent-rejected":
      return errorReason(error) === "invalid-compose-candidate" ? "composeSelectionInvalid" : "composeErrorGeneric";
    default:
      return "composeErrorGeneric";
  }
}
