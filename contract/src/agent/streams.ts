import * as z from "zod/mini";

// The lines of the agent's NDJSON streams (#272): one JSON object per line,
// told apart by `kind`. The first line is always `start`.
//
// ⚠️ WHO READS WHAT. The agent types every line it writes with the type of its
// stream (`satisfies LogsStreamLine`); the hub parses every line it reads
// against the same schema (`parseStreamLine` in
// `server/src/platform/agent-transport/stream-lines.ts`). A line of an
// unknown `kind` fails the schema with a named issue on `kind`, and the hub
// drops it — a newer agent may add a kind without breaking an older hub.
//
// ⚠️ `reason` IN A `error` LINE IS A STRING, NOT THE ENUM. The enums in
// `reasons.ts` type what the agent sends; the reader passes a key it does not
// know on verbatim. It is optional for the reader for the same reason: a line
// without a reason is still a failure (#176).

const failureLine = z.object({ kind: z.literal("error"), reason: z.optional(z.string()) });

// --- Container log: GET /containers/:id/logs-stream ---------------------------

export const logLineStreamSchema = z.enum(["stdout", "stderr"]);

export const logsStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), containerName: z.string(), tty: z.boolean() }),
  z.object({
    kind: z.literal("line"),
    stream: logLineStreamSchema,
    // Docker's RFC3339Nano timestamp, or `null` when the line carried none.
    ts: z.nullable(z.string()),
    text: z.string()
  }),
  failureLine
]);
export type LogsStreamLine = z.infer<typeof logsStreamLineSchema>;

// --- Log file: GET /containers/:id/log-file -----------------------------------

export const logFileStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), containerName: z.string(), path: z.string() }),
  z.object({
    kind: z.literal("line"),
    // A file has no timestamp per line; the field is there so that a reader of
    // both logs can treat their lines alike.
    ts: z.null(),
    text: z.string(),
    // The last line of the file before its `\n` arrived.
    partial: z.optional(z.literal(true))
  }),
  failureLine
]);
export type LogFileStreamLine = z.infer<typeof logFileStreamLineSchema>;

// --- Image pull: POST /containers/:id/pull-stream -----------------------------

/** How firmly an image ref names its image. */
export const imageMutabilitySchema = z.enum(["pinned", "tag", "floating"]);
export type ImageMutability = z.infer<typeof imageMutabilitySchema>;

export const pullStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), imageRef: z.string() }),
  z.object({
    kind: z.literal("progress"),
    // The engine's status text, capped by the agent; it comes from the registry.
    status: z.string(),
    id: z.nullable(z.string()),
    progress: z.nullable(z.string())
  }),
  z.object({
    kind: z.literal("result"),
    ok: z.literal(true),
    imageRef: z.string(),
    imageChanged: z.boolean(),
    recreateRequired: z.boolean(),
    imageMutability: imageMutabilitySchema
  }),
  failureLine
]);
export type PullStreamLine = z.infer<typeof pullStreamLineSchema>;

// --- Compose apply: POST /containers/:id/compose-raw-stream -------------------

/**
 * The steps of applying a compose file (#86), in the order they can come.
 * `detail` names the concrete subject where there is one, such as the image
 * being pulled.
 */
export const composeApplyStepSchema = z.enum([
  // Phase 1 as a whole: `docker compose config` on the draft, then the image
  // inventory and the hardening of the current state (agent/src/runtime/raw-ops.ts).
  "check",
  // The service diff and the question whether the caller named new/dropped
  // services (agent/src/runtime/raw-ops.ts).
  "confirmations",
  // A missing image is pulled. `detail` names the ref.
  "pull-images",
  // `docker compose ps` — before writing (which containers exist now) and
  // after the `up` (which exist afterwards).
  "resolve-containers",
  "write-file",
  "start",
  "check-hardening",
  // The containers of the dropped services are removed.
  "clean-up",
  // The way back. Exactly the step the caller previously could not tell apart
  // from a hanging `up`.
  "roll-back"
]);
export type ComposeApplyStep = z.infer<typeof composeApplyStepSchema>;

export const composeApplyStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    projectDir: z.string(),
    composeFileName: z.string(),
    stackName: z.string()
  }),
  // ⚠️ `step` is read as a string, like `reason`: a step a newer agent adds is
  // shown, not dropped. The agent writes `ComposeApplyStep`.
  z.object({ kind: z.literal("step"), step: z.string(), detail: z.optional(z.string()) }),
  // The final line: verbatim the response the synchronous route would have
  // given, status and body.
  z.object({
    kind: z.literal("result"),
    status: z.number(),
    body: z.record(z.string(), z.unknown())
  }),
  // ⚠️ Different from an `result` with an error: there the outcome is named.
  // Here it is UNKNOWN, and the caller has to read the state again.
  failureLine
]);
export type ComposeApplyStreamLine = z.infer<typeof composeApplyStreamLineSchema>;

// --- Shell: POST /containers/:id/exec ------------------------------------------

export const execStreamLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    // The id for `POST /exec/:session/*` — 256 random bits.
    session: z.string(),
    shell: z.string(),
    containerName: z.string()
  }),
  // Output, already redacted.
  z.object({ kind: z.literal("output"), text: z.string() }),
  // ⚠️ `exitCode` is `null` after an end from outside (duration, idle, the
  // caller left); only the agent's audit log says which. A missing or
  // unusable value reads as `null` and does NOT drop the line: `end` can be
  // the only line of a stream, and without it the caller could not tell an
  // ended session from a broken connection.
  z.object({ kind: z.literal("end"), exitCode: z.catch(z.nullable(z.number()), null) })
]);
export type ExecStreamLine = z.infer<typeof execStreamLineSchema>;

// --- Monitor: GET /monitor-events ------------------------------------------------

/** The agent's continuous container event stream. It has no `kind`. */
export const monitorEventLineSchema = z.object({ action: z.string(), containerId: z.string() });
export type MonitorEventLine = z.infer<typeof monitorEventLineSchema>;
