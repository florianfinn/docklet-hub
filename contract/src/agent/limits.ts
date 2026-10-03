// The limits of the agent protocol, one number each for both sides (#272).
//
// Until #272 the hub kept its own copy of these numbers in a hand-written
// contract file (removed in #274) and the agent its own in its source;
// #234 measured them apart (`MAX_OPEN_STREAMS`: hub 8, agent 32). Now the agent
// enforces exactly what the hub reads, because both import this file.

// --- Log excerpt -------------------------------------------------------------

/**
 * The smallest excerpt the hub asks for.
 *
 * ⚠️ `tail=0` IS NOT "NO HISTORY BY MISTAKE": on the stream routes it is the
 * agent's internal alarm stream that only sends new lines. A browser must
 * never reach it through the hub, hence the hub's lower bound is one.
 */
export const MIN_TAIL = 1;

/** The largest excerpt the agent delivers; a larger `tail` is rejected. */
export const MAX_TAIL = 2_000;

/** The excerpt when `tail` is missing. */
export const DEFAULT_TAIL = 200;

// --- Streams -----------------------------------------------------------------

/**
 * Open observable streams per agent, for all callers together: log stream,
 * log file stream, pull stream and compose apply stream. The next one gets
 * `429 too-many-streams`.
 *
 * 32 since agent v0.29.1: the hub shows the log of a whole stack and opens one
 * stream per container; eight capped a stack at four containers.
 */
export const MAX_OPEN_STREAMS = 32;

/** The agent's own continuous monitor stream, counted apart from the above. */
export const MAX_MONITOR_STREAMS = 4;

// --- Files -------------------------------------------------------------------

/**
 * The largest upload. The agent builds the tar archive for `put-archive` in
 * memory, so the file sits in its RAM twice during the upload.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** The largest text file the editor reads or writes, in UTF-8 bytes. */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** How many entries a listing carries at most; the rest is cut and flagged. */
export const MAX_ENTRIES = 1000;

// --- Compose -----------------------------------------------------------------

/**
 * The largest compose file the raw editor accepts, in UTF-8 bytes.
 *
 * It is also the largest line of the protocol, which is why the one NDJSON
 * reader caps a line at the same size (`NDJSON_MAX_LINE_CHARS`).
 */
export const MAX_COMPOSE_BYTES = 256 * 1024;

// --- Shell -------------------------------------------------------------------

/** Open shell sessions per agent. The next one gets `429 too-many-sessions`. */
export const EXEC_MAX_SESSIONS = 4;

/** The hard end of every session, whatever happens in it. */
export const EXEC_MAX_DURATION_MS = 30 * 60_000;

/** A session without input or output for this long ends. */
export const EXEC_IDLE_MS = 15 * 60_000;

/** The terminal size when a request names none or an unusable one. */
export const EXEC_DEFAULT_COLS = 80;
export const EXEC_DEFAULT_ROWS = 24;

/**
 * The range a terminal size is clamped to.
 *
 * ⚠️ CLAMPED, NOT REJECTED: the size is display, not a permission, and a `400`
 * while someone types is the worse answer (`terminalSizeSchema`).
 */
export const EXEC_MIN_COLS = 8;
export const EXEC_MAX_COLS = 500;
export const EXEC_MIN_ROWS = 4;
export const EXEC_MAX_ROWS = 300;

/**
 * The longest input of one `POST /exec/:session/input`, in characters of the
 * base64 STRING, not in bytes: about a third less payload than it looks.
 * Above it the agent answers `413 input-too-large`.
 */
export const EXEC_MAX_INPUT_BASE64_CHARS = 64 * 1024;

/** The shells the agent tries, in this order. */
export const EXEC_SHELL_CANDIDATES = ["bash", "sh"] as const;
