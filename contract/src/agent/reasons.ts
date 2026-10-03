import * as z from "zod/mini";

// The named error keys of the agent protocol (#272). The raw editor has its
// own file, `compose-reasons.ts`, because its keys are a set of sets.
//
// ⚠️ EVERY VALUE IS ENGLISH since contract 6 (#278), checked by
// `web/tests/agent-contract-language.test.mjs`. Hub and agent import these
// lists, so a renamed value is one change here that `tsc` follows to every use
// on both sides.
//
// Arrays and not only type unions: a type is gone at runtime, but a test can
// import an array and count it. Each type is DERIVED from its schema, never
// the other way round.
//
// ⚠️ A KEY THE READER DOES NOT KNOW TRAVELS ON VERBATIM. These enums type what
// the agent SENDS; the stream line schemas (`streams.ts`) read `reason` as a
// plain string, so that a key of a newer agent reaches the hub's caller as
// `reason` instead of failing a parser.

// --- Rejections every route can give ------------------------------------------

/**
 * The shared HTTP rejections. Route-specific Docker and file system errors
 * come on top; this list claims no completeness for them.
 */
export const SHARED_HTTP_ERRORS = [
  // Since contract 5 (#272): a body or query that does not fit its schema,
  // and a body that is no JSON at all. The body names the field
  // (`requestRejectionSchema`); a route may answer with one of the older keys
  // of `REQUEST_REJECTION_REASONS` instead.
  { status: 400, code: "invalid-request" },
  { status: 400, code: "invalid-json" },
  { status: 400, code: "tier-missing" },
  { status: 401, code: "unauthorized" },
  { status: 403, code: "internal-only-action" },
  { status: 403, code: "observe-only" },
  { status: 403, code: "externally-managed" },
  { status: 429, code: "too-many-streams" },
  { status: 429, code: "too-many-sessions" }
] as const;

// --- Rejected requests ------------------------------------------------------------

/**
 * Why the agent rejects a request whose body or query does not fit its schema.
 *
 * `invalid-request` is the generic key; the others name the field for the
 * checks that had a key of their own before #272, kept so the hub's
 * translations stay valid. A schema names one of them as the `error` of a
 * check; whatever check names none is reported as `invalid-request`.
 */
export const REQUEST_REJECTION_REASONS = [
  "invalid-request",
  "invalid-json",
  "env-hash-missing",
  "invalid-env-value",
  "no-change",
  "compose-hash-missing",
  "content-missing",
  "expected-hash-missing",
  "too-large",
  "input-too-large",
  "container-id-missing",
  "invalid-proof",
  "unknown-action",
  "invalid-spec"
] as const;

export const requestRejectionReasonSchema = z.enum(REQUEST_REJECTION_REASONS);
export type RequestRejectionReason = z.infer<typeof requestRejectionReasonSchema>;

/**
 * The body of a rejected request: the key and WHERE it failed.
 *
 * ⚠️ NEVER THE CONTENT. `field` is the path of the failing field
 * (`entries.3.imageRef`, `set.API_KEY`), never its value: a value can be a
 * secret or a host path, and the agent writes the rejection to its audit log,
 * which is append-only.
 */
export const requestRejectionSchema = z.object({
  error: requestRejectionReasonSchema,
  field: z.string()
});
export type RequestRejection = z.infer<typeof requestRejectionSchema>;

/** The part of a zod issue this module reads. */
type IssueLike = { readonly message: string; readonly path: readonly PropertyKey[] };

const KNOWN_REJECTIONS: ReadonlySet<string> = new Set(REQUEST_REJECTION_REASONS);

/**
 * Turns the issues of a failed `safeParse` into the rejection the agent sends.
 *
 * The FIRST issue decides: one named reason is what the caller can act on, and
 * a list would only tempt a reader to show it.
 *
 * ⚠️ zod's own message is never passed on. It names the expected and the
 * received type today; that it never quotes the input is no promise of zod's,
 * so only a key from `REQUEST_REJECTION_REASONS` leaves the agent.
 */
export function requestRejectionOf(issues: readonly IssueLike[]): RequestRejection {
  const first = issues[0];
  if (!first) return { error: "invalid-request", field: "" };
  const error = KNOWN_REJECTIONS.has(first.message) ? (first.message as RequestRejectionReason) : "invalid-request";
  return { error, field: first.path.map(String).join(".") };
}

// --- Streams -----------------------------------------------------------------------

/**
 * `GET /containers/:id/logs-stream`, in a `error` line.
 *
 * ⚠️ A cancellation by the caller is none of these: since agent v0.24.0 it
 * sends nothing at all then, because the connection the line would go into is
 * exactly the one that just closed. The last value catches what is none of
 * the named cases.
 */
export const LOGS_STREAM_FAILURE_REASONS = [
  "container-gone",
  "engine-refused",
  "engine-unreachable",
  "logs-failed"
] as const;
export const logsStreamFailureReasonSchema = z.enum(LOGS_STREAM_FAILURE_REASONS);
export type LogsStreamFailureReason = z.infer<typeof logsStreamFailureReasonSchema>;

/** `POST /containers/:id/pull-stream`, in a `error` line. */
export const PULL_STREAM_FAILURE_REASONS = [
  "image-not-found",
  "pull-rejected",
  "engine-refused",
  "engine-unreachable",
  "pull-failed"
] as const;
export const pullStreamFailureReasonSchema = z.enum(PULL_STREAM_FAILURE_REASONS);
export type PullStreamFailureReason = z.infer<typeof pullStreamFailureReasonSchema>;

/** Why a log file path is refused before anything is opened. */
export const LOG_PATH_FAILURE_REASONS = [
  "path-empty",
  "path-absolute",
  "path-traversal",
  "path-invalid-characters",
  "path-blocked",
  "path-outside"
] as const;
export type LogPathFailureReason = (typeof LOG_PATH_FAILURE_REASONS)[number];

/** Why a log file cannot be opened, the path reasons included. */
export const LOG_OPEN_FAILURE_REASONS = [
  ...LOG_PATH_FAILURE_REASONS,
  "file-missing",
  "not-a-file",
  "not-readable",
  "file-replaced"
] as const;
export type LogOpenFailureReason = (typeof LOG_OPEN_FAILURE_REASONS)[number];

/** `GET /containers/:id/log-file`, in a `error` line or as the status body. */
export const LOG_FILE_FAILURE_REASONS = [...LOG_OPEN_FAILURE_REASONS, "log-file-failed"] as const;
export const logFileFailureReasonSchema = z.enum(LOG_FILE_FAILURE_REASONS);
export type LogFileFailureReason = z.infer<typeof logFileFailureReasonSchema>;

// --- Shell --------------------------------------------------------------------------

/**
 * Why `POST /containers/:id/exec` refuses to open a session. All of them come
 * before the first stream line, as a status with this key in `error`.
 *
 * ⚠️ TWO KEYS CARRY A TEXT AFTER A COLON: `self-management-locked: <dir>`
 * and `hardening-violated: <rule>`. Whoever compares them with `===` never
 * hits them; `execRejectionKey` in `server/src/features/shell/rejections.ts` cuts the text.
 */
export const EXEC_REJECTION_KEYS = [
  "unauthorized",
  "tier-missing",
  "internal-only-action",
  "observe-only",
  "agent-read-only",
  "not-allowlisted",
  "container-gone",
  "self-management-locked",
  "hardening-violated",
  "container-not-started",
  "too-many-sessions",
  "no-shell",
  "exec-start-failed"
] as const;
export const execRejectionKeySchema = z.enum(EXEC_REJECTION_KEYS);
export type ExecRejectionKey = z.infer<typeof execRejectionKeySchema>;

/**
 * The answer of `POST /exec/:session/*` for a session the agent does not know,
 * or that belongs to another actor (`404`).
 */
export const EXEC_SESSION_REJECTION_KEY = "session-unknown";
