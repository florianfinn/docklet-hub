import type { ComposeRawFailureReason } from "contract";

import { AgentError } from "../../platform/agent-transport/protocol.js";
import { agentFailureReason } from "../../platform/agent-transport/stream-rejection.js";
import { translateAgentOutcome } from "../../platform/http/agent-error-translation.js";
import type { ComposeQuestion } from "./types.js";
import { asFlag, asText, asTextList } from "./wire-readers.js";

// The ONE place where the error keys of the agent's raw editor
// (`compose-raw`, `compose-raw-stream`, `compose-raw-preview`) become something
// the hub says (#264). Until then three places held a part each: the questions
// in `agent/compose.ts` (`asQuestion`, 12 keys), the two named `404` in the
// route (`COMPOSE_NOT_FOUND_REASONS`) and the "no file" case in
// `api/compose-file-missing.ts`; everything else fell into the general table
// of `platform/http/agent-error-translation.ts` with the text of the transport.
//
// ⚠️ THE TABLE IS TYPED AGAINST THE CONTRACT. `Record<ComposeRawFailureReason,
// …>` has one entry per key of `contract/src/agent/compose-reasons.ts`, so a key
// the agent adds there does not compile here until it has a sentence — and a
// key without one is the same dead end the contract file warns about: an
// answerable question turned into a nameless failure.
//
// ⚠️ EVERY KEY HAS A SENTENCE (`message`), AND 12 OF THEM ARE ALSO A QUESTION.
// The sentence is for the keys that arrive as an error: the read and the
// preview run the same front section as applying, so even `stack-anchor-stale`
// reaches them as a `409` and not as a question. The question (`question`) is
// for the way applying runs, where the person can answer it.
//
// ⚠️ A KEY THIS TABLE DOES NOT KNOW IS NOT SWALLOWED. It travels on as `reason`,
// verbatim, with the status and the code of the general table
// (`translateAgentOutcome`) — the same as for every other surface, and the
// way a newer agent's key stays visible. The keys are the agent's, English
// since contract 6 (#278); the hub's own codes (`error`) are its own words.

type ReasonEntry = {
  /** The sentence for the person, in the hub's words. */
  message: string;
  /** Present where the person can answer: the same request with the list goes through. */
  question?: (body: Record<string, unknown>) => ComposeQuestion;
};

/** The four keys that mean "this draft is no good" — one question, the detail differs. */
function invalidDraft(body: Record<string, unknown>): ComposeQuestion {
  return { kind: "invalid-draft", detail: asText(body.detail) || asTextList(body.errors).join("; ") };
}

const DRAFT_INVALID = "Der Arm lehnt diese Compose-Datei ab.";

export const COMPOSE_REASONS: Readonly<Record<ComposeRawFailureReason, ReasonEntry>> = {
  // ── Gate: decided before the project lock ─────────────────────────────────
  "agent-read-only": {
    message: "Dieser Arm steht auf „nur lesen“. Solange der Kill-Switch liegt, schreibt er keine Compose-Datei."
  },
  "not-allowlisted": { message: "Diesen Container führt der Arm nicht in seiner Allowlist." },
  "name-not-usable-as-directory": {
    message: "Der Name dieses Containers taugt nicht als Verzeichnisname; der Arm findet so kein Projektverzeichnis."
  },
  "invalid-compose-file-name": { message: "Der Arm hält den Namen der Compose-Datei dieses Containers für ungültig." },
  "compose-project-name-missing-or-invalid": { message: "Der Projektname dieses Stacks fehlt oder ist ungültig." },
  "project-dir-outside-base-path": {
    message: "Das Projektverzeichnis dieses Stacks liegt außerhalb des Basispfads des Arms."
  },
  "self-management-locked": { message: "Der Arm sperrt dieses Verzeichnis gegen Selbstverwaltung." },
  "compose-file-missing": { message: "Der Arm findet für diesen Container keine Compose-Datei." },
  // The three keys of agent v0.30.0 (#234): why there is no unambiguous anchor.
  "compose-anchor-labels-missing": {
    message:
      "Dieser Container trägt nicht alle Compose-Labels (Projekt, Dienst, Arbeitsverzeichnis); der Arm findet keine Datei, zu der er gehört."
  },
  "compose-anchor-outside-base-path": {
    message: "Das Compose-Arbeitsverzeichnis dieses Containers liegt außerhalb des Basispfads, den der Arm verwaltet."
  },
  "compose-anchor-file-ambiguous": {
    message: "Die Labels dieses Containers nennen nicht genau eine Compose-Datei im Arbeitsverzeichnis."
  },
  // Only on creation (`POST /stacks/raw`); listed because the table is the set.
  "directory-taken": { message: "Dieses Verzeichnis ist schon belegt." },
  "stack-service-not-allowlisted": {
    message: "Nicht jeder Dienst dieses Stacks steht auf der Allowlist des Arms. Solange das so ist, bearbeitet er die Datei nicht."
  },
  "externally-managed": {
    message: "Ein Dienst dieses Stacks wird fremdverwaltet. Seine Definition bleibt beim Verwalter; der Arm schreibt die Datei nicht."
  },
  "compose-hash-missing": { message: "Zum Anwenden gehört der Hash des Standes, auf dem bearbeitet wurde." },
  "confirmation-missing": { message: "Der Arm verlangt den Namen des Stacks als Bestätigung." },
  "too-many-streams": {
    message: "Der Arm führt bereits die Höchstzahl gleichzeitiger Ströme. Ein geschlossener Strom gibt einen Platz frei."
  },
  "stack-busy": { message: "An diesem Stack arbeitet gerade ein anderer Vorgang. Danach noch einmal versuchen." },

  // ── The verdict on the draft, and the anchor under the lock ───────────────
  "invalid-content": { message: DRAFT_INVALID, question: invalidDraft },
  "invalid-compose-file": { message: DRAFT_INVALID, question: invalidDraft },
  "no-services": { message: DRAFT_INVALID, question: invalidDraft },
  "service-without-image": { message: DRAFT_INVALID, question: invalidDraft },
  // ⚠️ Questions WITHOUT an answer: they fall in the check phase before a byte
  // is written and carry no `rolledBack`. The surface shows them as what they
  // are and offers no button (#113).
  "stack-anchor-stale": {
    message: "Der Container dieses Stacks hat sich seit dem letzten Abgleich geändert; die Liste des Arms ist veraltet.",
    question: () => ({ kind: "anchor-stale" })
  },
  "image-ref-unreadable": {
    message: "Eine Image-Angabe der Datei ist nicht lesbar.",
    question: (body) => ({ kind: "image-ref-unreadable", ref: asText(body.ref) })
  },
  // ⚠️ The three that need a decision: the same request with the list goes
  // through. `services`, `images` (and `hardening` below) carry the list that
  // the person confirms; the hub does not form it.
  "service-confirmation-missing": {
    message: "Die Datei fügt Services hinzu oder entfernt welche. Der Arm verlangt, dass das bestätigt wird.",
    question: (body) => ({ kind: "services", added: asTextList(body.new), removed: asTextList(body.removed) })
  },
  // Only on creation (`POST /stacks/raw`), like `directory-taken`.
  "external-source-confirmation-missing": {
    message: "Das neue Projekt bindet Verzeichnisse außerhalb seines Projektordners ein. Der Arm verlangt, dass jede Quelle bestätigt wird.",
    question: (body) => ({ kind: "external-sources", sources: asTextList(body.externalSources) })
  },
  "image-not-local": {
    message: "Für diese Datei fehlen Images auf dem Host. Der Arm verlangt, dass das Ziehen bestätigt wird.",
    question: (body) => ({ kind: "images", missing: asTextList(body.missingImages) })
  },

  // ── Execute: something real has been written ──────────────────────────────
  // ⚠️ Each of these carries `rolledBack`, which says WHERE the stack stands.
  "file-changed-externally": {
    message: "Die Datei wurde seit dem Laden von jemand anderem geändert.",
    question: (body) => ({ kind: "changed-elsewhere", actualHash: asText(body.actualHash) })
  },
  // Only on creation; see `directory-taken`.
  "file-already-exists": { message: "Diese Datei existiert bereits." },
  "compose-up-failed": {
    message: "„docker compose up“ ist fehlgeschlagen. Ob der Arm zurückgerollt hat, steht in der Antwort.",
    question: (body) => ({ kind: "start-failed", detail: asText(body.detail), rolledBack: asFlag(body.rolledBack) })
  },
  "container-not-resolvable": {
    message: "Nach dem Start fand der Arm einen Container des Stacks nicht. Ob er zurückgerollt hat, steht in der Antwort.",
    question: (body) => ({ kind: "container-missing", detail: asText(body.detail), rolledBack: asFlag(body.rolledBack) })
  },
  "hardening-newly-violated": {
    message: "Die Datei verletzt eine Regel der Härtung, die vorher nicht verletzt war. Der Arm verlangt, dass das bestätigt wird.",
    question: (body) => ({
      kind: "hardening",
      newViolations: asTextList(body.newViolations),
      rolledBack: asFlag(body.rolledBack)
    })
  },

  // ── The stream ────────────────────────────────────────────────────────────
  // ⚠️ NOT AN OUTCOME OF APPLYING: it is the `error` line, and what it says is
  // that the state of the stack is UNKNOWN. It is no HTTP answer; the sentence
  // is for a caller that reads it anyway.
  "compose-raw-failed": {
    message: "Der Arm hat das Anwenden mit einem Fehler verlassen. Der Stand des Stacks ist unbekannt."
  }
};

/** The entry of a key — only for keys the table KNOWS, and never for `toString` and its kin. */
function entryOf(key: string | null): ReasonEntry | null {
  return key !== null && Object.hasOwn(COMPOSE_REASONS, key) ? (COMPOSE_REASONS as Record<string, ReasonEntry>)[key]! : null;
}

/**
 * Makes a refused attempt an answerable question — or `null`.
 *
 * ⚠️ ONLY THE KEYS THAT HAVE A QUESTION. A `403` of the allowlist, a `503` of
 * the kill switch and a `404` are no questions to the operator but states of the
 * system — they stay an `AgentError` and are translated by the route. Whoever
 * caught them here would offer the person a button that can change nothing.
 * Twelve of the keys run through here; the key is read from `error` of the
 * body, and from `reason` where an answer carries it there.
 */
export function composeQuestionOf(error: AgentError): ComposeQuestion | null {
  const detail = error.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const body = detail as Record<string, unknown>;
  const key = asText(body.error ?? body.reason);
  return entryOf(key === "" ? null : key)?.question?.(body) ?? null;
}

// ---------------------------------------------------------------------------
// The answer of the hub
// ---------------------------------------------------------------------------

/** What the route writes: the status and the body of the JSON answer. */
export type ComposeRejection = { status: number; body: Record<string, unknown> };

/** The key of the agent for "I found no compose file" (`compose-file-missing`). */
const FILE_MISSING = "compose-file-missing";

/**
 * The anchor reasons the agent reports on `compose-raw` instead of falling
 * back to `compose-file-missing` (agent v0.30.0, #234).
 *
 * ⚠️ THEY TAKE THE SAME WAY AS `compose-file-missing` (#185), because they
 * mean the same for the surface: for THIS container the arm finds no file, and
 * the next container of the stack is asked. As `agent-conflict` they ended
 * the search at the first container — measured at the stack
 * `minecraft_arc_2026` on 2026-09-29 (#183), whose first container carries
 * `compose-anchor-file-ambiguous`. The reason travels on verbatim; the
 * surface names it, and offers the selection by hand where it can.
 */
const ANCHOR_REASONS: ReadonlySet<ComposeRawFailureReason> = new Set([
  "compose-anchor-labels-missing",
  "compose-anchor-outside-base-path",
  "compose-anchor-file-ambiguous"
]);

// These 404 reasons are explicit agent refusals, so they must not trigger
// the unknown-route fallback used by older agents.
const NOT_FOUND_ANSWERS: ReadonlySet<string> = new Set(["not-allowlisted", "container-gone"]);

/**
 * Does this `404` mean "the arm does not know the route"?
 *
 * Only then does it start a fallback. A `404` with a reason from the set above
 * is an answer and goes out as one.
 */
export function isRouteUnknown(error: unknown): boolean {
  if (!(error instanceof AgentError) || error.status !== 404) return false;
  const reason = agentFailureReason(error);
  return reason === null || !NOT_FOUND_ANSWERS.has(reason);
}

/**
 * The directory the arm looked in, when it found no compose file (#183).
 *
 * ⚠️ AN ANSWER OF ITS OWN AND NOT THE CATCH-ALL `agent-conflict`. It went out
 * as `agent-conflict` with `reason` next to it, and the directory from the
 * arm's body fell away at the border (`translateAgentOutcome` hands on only
 * `error`, `message` and `reason`). The directory is exactly what the operator
 * can use: measured on 2026-09-29 at the arm `unraid`, `fileflows` did not lie
 * where the arm looks — visible only in the path.
 *
 * ⚠️ IT IS THE DIRECTORY THE ARM SEARCHED, not necessarily the one from the
 * compose labels. The agent (v0.24.0) falls back to `<base path>/<container
 * name>` for a refused anchor and reports that directory
 * (dashboard-docker-agent#102). The hub passes it on verbatim and claims no
 * more than what stands there. The path of a foreign machine goes to the
 * browser, which is no new leak: the route is behind `requireAdmin`, and the
 * success answer carries the same field (`projectDir`).
 *
 * ⚠️ `projectDir` ONLY AS A NON-EMPTY STRING. Another type from the body is not
 * reshaped but falls to `null` — the surface then says the sentence without a
 * path.
 */
function fileMissingOf(error: AgentError, selectionSupported: boolean | undefined): ComposeRejection | null {
  const found = agentFailureReason(error);
  if (found !== FILE_MISSING && !ANCHOR_REASONS.has(found as ComposeRawFailureReason)) return null;
  const reason = found as ComposeRawFailureReason;
  const detail = error.detail as Record<string, unknown>;
  const projectDir = typeof detail.projectDir === "string" && detail.projectDir.length > 0 ? detail.projectDir : null;
  return {
    status: 409,
    body: {
      error: "compose-file-missing",
      message: COMPOSE_REASONS[reason].message,
      reason,
      projectDir,
      // Does the hub offer the selection by hand for this arm (#185)? Only the
      // reading route knows and says so; elsewhere the field is absent.
      ...(selectionSupported === undefined ? {} : { selectionSupported })
    }
  };
}

/**
 * What the hub answers to a refusal of the agent on this surface.
 *
 * Status and code come from the general table (`translateAgentOutcome`), the
 * sentence from the table above where the key is known, and the key itself
 * travels on as `reason` — known or not. A refusal that makes the hub fall back
 * to `agent-unreachable` (a wrong secret, a fault of the hub's set-up) keeps
 * the text of the transport: the sentence of the key would be a claim about the
 * arm that the arm did not make.
 */
export function describeComposeRejection(error: AgentError, selectionSupported?: boolean): ComposeRejection {
  // ⚠️ BEFORE everything else: otherwise this case would go out as
  // `agent-conflict`, and the directory the arm searched would fall away.
  const missing = fileMissingOf(error, selectionSupported);
  if (missing) return missing;

  const reason = agentFailureReason(error);
  const outcome = translateAgentOutcome(error.status, reason, error.message);
  const known = entryOf(reason);
  const message = known !== null && outcome.error !== "agent-unreachable" ? known.message : outcome.message;
  const body = { error: outcome.error, message };
  return { status: outcome.status, body: reason === null ? body : { ...body, reason } };
}
