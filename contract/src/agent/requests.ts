import * as z from "zod/mini";

import {
  DEFAULT_TAIL,
  EXEC_DEFAULT_COLS,
  EXEC_DEFAULT_ROWS,
  EXEC_MAX_COLS,
  EXEC_MAX_INPUT_BASE64_CHARS,
  EXEC_MAX_ROWS,
  EXEC_MIN_COLS,
  EXEC_MIN_ROWS,
  MAX_TAIL,
  MAX_TEXT_BYTES,
  MIN_TAIL
} from "./limits.js";
import { since } from "./version.js";

// The requests the agent accepts (#272), except the compose surface, which has
// its own file (`compose-requests.ts`). The hub builds its requests with the
// input types (`z.input<typeof …>`), the agent checks every incoming request
// with `safeParse` against the same schema.
//
// ⚠️ WHAT A SCHEMA CHECKS AND WHAT IT LEAVES TO THE AGENT. A schema checks the
// shape of a field: type, presence, length, range, pattern. Whatever depends
// on the host — is a path inside the share, is a name free, does the hash
// still match the file — stays in the agent's handler, next to the state it
// reads. A schema that knew the base path would be a second agent.
//
// ⚠️ A CHECK NAMES ITS KEY IN `error`. `requestRejectionOf` (`reasons.ts`)
// passes on a key from `REQUEST_REJECTION_REASONS` and turns every other
// message into `invalid-request`; zod's own text never leaves the agent.
//
// ⚠️ QUERIES ARRIVE AS STRINGS. The agent reads the first value of each query
// parameter into a plain object (`queryObject` in
// `agent/src/request-keys.ts`) and parses that. A number in a query is
// therefore a string of digits here, and the schema turns it into a number.
//
// Unknown fields are stripped, not rejected (`z.object`): a newer hub may send
// a field this agent does not read yet.

/** UTF-8 length of a string, without `TextEncoder` (the package loads no DOM). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const digits = z.string().check(z.regex(/^\d{1,9}$/));

/** A whole number in a query, from `min` to `max`, with a default when missing. */
function queryNumber(min: number, max: number, fallback: number) {
  return z._default(
    z.pipe(digits, z.pipe(z.transform(Number), z.int().check(z.minimum(min), z.maximum(max)))),
    fallback
  );
}

// --- Log excerpt ------------------------------------------------------------------

/**
 * `GET /containers/:id/logs?tail=N`: the log as one snapshot.
 *
 * ⚠️ NO ZERO HERE. On a route without `follow` a zero would not mean "only
 * from now on" but an empty answer.
 */
export const logsSnapshotQuerySchema = z.object({ tail: queryNumber(MIN_TAIL, MAX_TAIL, DEFAULT_TAIL) });
export type LogsSnapshotQuery = z.input<typeof logsSnapshotQuerySchema>;

/**
 * `GET /containers/:id/logs-stream?tail=N`: the running container log.
 *
 * ⚠️ `tail=0` IS THE AGENT'S INTERNAL ALARM STREAM: no history, only new
 * lines, so that a planned reconnect does not report old hits again. The hub
 * never sends it (`MIN_TAIL`).
 */
export const logsStreamQuerySchema = z.object({ tail: queryNumber(0, MAX_TAIL, DEFAULT_TAIL) });
export type LogsStreamQuery = z.input<typeof logsStreamQuerySchema>;

/**
 * `GET /containers/:id/log-file?path=…&tail=N`: a log file below the project
 * directory. `path` is checked against the directory by the agent.
 */
export const logFileQuerySchema = z.object({
  path: z._default(z.string(), ""),
  tail: queryNumber(0, MAX_TAIL, DEFAULT_TAIL)
});
export type LogFileQuery = z.input<typeof logFileQuerySchema>;

// --- Environment file ---------------------------------------------------------

/**
 * `GET /containers/:id/env?plaintext=1`. Values leave the agent unmasked only
 * on this explicit request; anything but `1` reads masked.
 */
export const envQuerySchema = z.object({
  plaintext: z.pipe(z.optional(z.string()), z.transform((value) => value === "1"))
});
export type EnvQuery = z.input<typeof envQuerySchema>;

/**
 * `PUT /containers/:id/env`: set and remove keys of the project's `.env`.
 *
 * ⚠️ `expectedEnvHash` HAS NO "DON'T CARE": either the hash of the file as
 * last read, or explicitly `null` when none may exist yet. Missing is an error.
 */
export const envWriteRequestSchema = z
  .object({
    expectedEnvHash: z.nullable(z.pipe(z.string({ error: "env-hash-missing" }), z.transform((value) => value.trim()))),
    set: z._default(
      z.record(
        z.string(),
        // A null byte would never come out of the file intact again.
        z.string({ error: "invalid-env-value" }).check(z.refine((value) => !value.includes("\0"), { error: "invalid-env-value" }))
      ),
      {}
    ),
    remove: z._default(z.array(z.string()), [])
  })
  .check(
    z.refine((request) => Object.keys(request.set).length > 0 || request.remove.length > 0, { error: "no-change" })
  );
export type EnvWriteRequest = z.input<typeof envWriteRequestSchema>;

// --- Files (Web FTP) ------------------------------------------------------------

/**
 * The share and the path below it, for listing, download and reading text.
 * Without `share` the agent takes the container's only share or refuses.
 */
export const shareQuerySchema = z.object({
  share: z.optional(z.string()),
  path: z._default(z.string(), "")
});
export type ShareQuery = z.input<typeof shareQuerySchema>;

/** `PUT /containers/:id/file?share=…&path=…&name=…`: an upload, raw bytes. */
export const fileUploadQuerySchema = z.object({
  share: z.optional(z.string()),
  path: z._default(z.string(), ""),
  name: z._default(z.string(), "")
});
export type FileUploadQuery = z.input<typeof fileUploadQuerySchema>;

/**
 * `PUT /containers/:id/file-text`: save a text file.
 *
 * ⚠️ THE LIMIT IS IN UTF-8 BYTES, NOT CHARACTERS (`MAX_TEXT_BYTES`). Above it
 * the agent answers `413 too-large`.
 */
export const fileTextWriteRequestSchema = z.object({
  content: z
    .string({ error: "content-missing" })
    .check(z.refine((value) => utf8ByteLength(value) <= MAX_TEXT_BYTES, { error: "too-large" })),
  // The hash of the file as last read; a file changed in between is refused.
  expectedHash: z.string({ error: "expected-hash-missing" }).check(z.minLength(1, { error: "expected-hash-missing" }))
});
export type FileTextWriteRequest = z.input<typeof fileTextWriteRequestSchema>;

/** The three actions of `POST /containers/:id/files`. */
export const fileActionSchema = z.enum(["create-folder", "rename", "delete"]);
export type FileAction = z.infer<typeof fileActionSchema>;
export const FILE_ACTIONS = fileActionSchema.options;

/**
 * `POST /containers/:id/files`: create a folder, rename or delete.
 *
 * `path` is the folder to create in, or the entry to rename or delete; `name`
 * the new folder or the new name. Both are checked against the share by the
 * agent.
 */
export const fileActionRequestSchema = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("create-folder"), path: z._default(z.string(), ""), name: z._default(z.string(), "") }),
    z.object({ action: z.literal("rename"), path: z._default(z.string(), ""), name: z._default(z.string(), "") }),
    z.object({ action: z.literal("delete"), path: z._default(z.string(), "") })
  ],
  { error: "unknown-action" }
);
export type FileActionRequest = z.input<typeof fileActionRequestSchema>;

// --- Shell --------------------------------------------------------------------------

function terminalDimension(min: number, max: number, fallback: number) {
  return z.catch(
    z.pipe(
      z.number().check(z.refine(Number.isFinite)),
      z.transform((value) => Math.min(max, Math.max(min, Math.trunc(value))))
    ),
    fallback
  );
}

/**
 * The terminal size of `POST /containers/:id/exec` and `POST /exec/:session/size`.
 *
 * ⚠️ CLAMPED, NOT REJECTED. The size is display and not a permission, and a
 * `400` while someone types is the worse answer: a value out of range is
 * clamped, a missing or unusable one becomes 80 × 24.
 */
export const terminalSizeSchema = z.object({
  cols: terminalDimension(EXEC_MIN_COLS, EXEC_MAX_COLS, EXEC_DEFAULT_COLS),
  rows: terminalDimension(EXEC_MIN_ROWS, EXEC_MAX_ROWS, EXEC_DEFAULT_ROWS)
});
export type TerminalSize = z.output<typeof terminalSizeSchema>;
export type TerminalSizeRequest = z.input<typeof terminalSizeSchema>;

/**
 * `POST /exec/:session/input`: keystrokes as base64, because they are bytes
 * (control characters, incomplete UTF-8 while typing fast) and no text.
 */
export const execInputRequestSchema = z.object({
  data: z._default(
    z.string().check(z.maxLength(EXEC_MAX_INPUT_BASE64_CHARS, { error: "input-too-large" })),
    ""
  )
});
export type ExecInputRequest = z.input<typeof execInputRequestSchema>;

// --- Allowlist and monitors -------------------------------------------------------

const nonEmpty = () => z.string().check(z.minLength(1));

/** Who owns the compose file of an adopted container. */
export const registryOriginSchema = z.enum(["dashboard", "adopted"]);
export type RegistryOrigin = z.infer<typeof registryOriginSchema>;

/**
 * The origin the hub sends for every anchor: the hub only adopts, it never
 * writes a compose file from a spec. `dashboard` stays the agent's own case.
 */
export const HUB_REGISTRY_ORIGIN = "adopted" satisfies RegistryOrigin;

/** The compose anchor of a container, from the labels at adoption. */
export const registryComposeSchema = z.object({
  projectDir: nonEmpty(),
  // Strictly needed for stack actions; optional only so that an entry from
  // before agent S11 is not dropped at startup.
  projectName: z.optional(nonEmpty()),
  serviceName: nonEmpty(),
  composeFileName: nonEmpty(),
  origin: registryOriginSchema
});
export type RegistryCompose = z.infer<typeof registryComposeSchema>;

/**
 * One entry of the allowlist the hub syncs to the agent (`PUT /registry`).
 *
 * ⚠️ The agent decides on ITS copy of this list only, never on a field of the
 * request of an action.
 */
export const registryEntrySchema = z.object({
  containerId: nonEmpty(),
  containerName: z.string(),
  // The one image ref a pull may pull.
  imageRef: z.string(),
  allowed: z.boolean(),
  // Logs without control (#78). With `allowed` too, the narrower class wins.
  observeOnly: since(z.optional(z.boolean()), 2),
  // Controllable, but its definition is someone else's (#78): pull, recreate,
  // apply-spec and remove are refused. Grants nothing without `allowed`.
  externallyManaged: since(z.optional(z.boolean()), 3),
  // Bind mounts restricted to the container's own directory (stage 5e).
  secured: z.optional(z.boolean()),
  // One share, relative to the project directory (S19); folded into `shares`.
  sharePath: z.optional(nonEmpty()),
  // The shares for Web FTP (S20), relative to the project directory.
  shares: z.optional(z.array(nonEmpty())),
  compose: z.optional(registryComposeSchema)
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** `PUT /registry`: the whole allowlist, replaced at once. */
export const registrySyncRequestSchema = z.object({ entries: z.array(registryEntrySchema) });
export type RegistrySyncRequest = z.input<typeof registrySyncRequestSchema>;

/** One container the agent only observes for the hub's monitoring. */
export const monitorEntrySchema = z.object({
  containerId: nonEmpty(),
  // The hub's id; stable across Docker recreates. If present, not empty.
  monitorId: z.optional(nonEmpty()),
  // Unique per host and kept across a compose recreate; without it the agent
  // falls back to the id. If present, not blank.
  containerName: z.optional(z.string().check(z.refine((value) => value.trim().length > 0)))
});
export type MonitorEntry = z.infer<typeof monitorEntrySchema>;

/** `PUT /monitors`: the whole watch-only list, replaced at once. */
export const monitorSyncRequestSchema = z.object({ entries: z.array(monitorEntrySchema) });
export type MonitorSyncRequest = z.input<typeof monitorSyncRequestSchema>;

// --- Audit archive and self-update ------------------------------------------------

/**
 * `POST /audit-archive/discard`: proof of the copy, not an order to delete.
 * The agent recomputes that its log still begins with exactly these bytes.
 */
export const auditDiscardRequestSchema = z.object({
  bytes: z.int({ error: "invalid-proof" }).check(z.minimum(0, { error: "invalid-proof" })),
  sha256: z.string({ error: "invalid-proof" }).check(z.regex(/^[0-9a-f]{64}$/, { error: "invalid-proof" }))
});
export type AuditDiscardRequest = z.input<typeof auditDiscardRequestSchema>;

/**
 * `POST /self-update`, with an optional target image (agent v0.30.0). Without
 * it the agent swaps to its own ref again; whether the target is a readable
 * ref of the same repository is the agent's check.
 */
export const selfUpdateRequestSchema = z.object({ imageRef: z.optional(z.nullable(z.string())) });
export type SelfUpdateRequest = z.input<typeof selfUpdateRequestSchema>;
