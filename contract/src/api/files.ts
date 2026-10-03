// `zod/mini` and not `zod`: see `contract/README.md` and `api/hosts.ts`.
import * as z from "zod/mini";

// The response shapes of the file surface (#248): the shares of a container,
// a directory listing, a text file and the receipts of upload, save and
// folder actions — plus the one request body the web builds itself.
//
// Most of these shapes are the agent's, passed through by the hub; the share
// itself (`containerShareSchema`) is the hub's own, the content of its table
// `container_share`.

/** A bind mount that can serve as a share (agent `src/index.ts:4105` ff.). */
export const shareCandidateSchema = z.object({
  // The path relative to the project directory — never the host's absolute
  // one. ⚠️ It is the VALUE that goes to `PUT …/share`, not `destination`:
  // the server compares the choice character by character with `relative`
  // from the same candidate list.
  relative: z.string(),
  // Where the mount points INSIDE the container — for display, not choice.
  destination: z.string(),
  writable: z.boolean()
});
export type ShareCandidate = z.infer<typeof shareCandidateSchema>;

/**
 * `GET …/share-candidates`. An empty list is a valid answer: a container
 * without a bind mount below its project directory has no candidates.
 */
export const shareCandidatesSchema = z.object({
  candidates: z.array(shareCandidateSchema)
});

/**
 * One entry of a directory listing (agent `src/webftp.ts:290` ff.).
 *
 * ⚠️ `changedAt` is a number in SECONDS since the epoch — not milliseconds
 * and not an ISO text: `changedAt: Math.floor(stat.mtimeMs / 1000)` in
 * `agent/src/webftp.ts`, measured on 2026-09-07. A bare
 * `new Date(<seconds>)` does not throw, it yields an instant shortly after
 * 1970; the web converts in exactly one place (`entryChangedAt`).
 *
 * ⚠️ `kind` is a STRING on purpose, not an enumeration. The four measured
 * values are `WEBFTP_ENTRY_KINDS` (`webftp.ts`) and serve for comparison; a
 * fifth from the agent is passed through, not failed.
 */
export const webftpEntrySchema = z.object({
  name: z.string(),
  kind: z.string(),
  size: z.number(),
  changedAt: z.number(),
  uid: z.number(),
  gid: z.number()
});
export type WebftpEntry = z.infer<typeof webftpEntrySchema>;

/**
 * Why something works in this directory or not (agent `src/index.ts:4244` ff.).
 *
 * ⚠️ `deletable` says whether this DIRECTORY may be written: deleting and
 * renaming need the write right on the directory, not on the file.
 *
 * ⚠️ `uploadable` does NOT follow `readable`/`deletable`. Those two are the
 * agent's rights on the host; an upload goes through the daemon, and only
 * whether the container mounts this directory writable counts.
 */
export const shareDiagnosticsSchema = z.object({
  readable: z.boolean(),
  deletable: z.boolean(),
  uid: z.number(),
  gid: z.number(),
  uploadable: z.boolean()
});
export type ShareDiagnostics = z.infer<typeof shareDiagnosticsSchema>;

export const fileListingSchema = z.object({
  share: z.string(),
  path: z.string(),
  entries: z.array(webftpEntrySchema),
  // Whether the list was cut at the agent's `MAX_ENTRIES`. ⚠️ Whoever drops
  // this field shows a directory that looks complete and is not.
  truncated: z.boolean(),
  // `null`: the agent could not judge the directory — "no answer", not "no".
  diagnostics: z.nullable(shareDiagnosticsSchema)
});
export type FileListing = z.infer<typeof fileListingSchema>;

/**
 * `GET …/files`.
 *
 * ⚠️ `maxUploadBytes` belongs to the ENVELOPE, not to the listing: the
 * listing is the agent's shape, the limit is the hub's word next to it. It
 * arrives as a number, so the web holds a too-large file back before it
 * leaves, without a constant of its own (#136).
 */
export const fileListingResponseSchema = z.object({
  listing: fileListingSchema,
  maxUploadBytes: z.number()
});

/**
 * The operator's choice of share, as `GET`/`PUT …/share` return it — the
 * hub's own shape (server `domain/containers/shares.ts`).
 *
 * ⚠️ `containerName` and NOT the id: the choice is stored per (arm, container
 * name) (`011-container-shares.sql`); the id of the moment is nowhere in it.
 */
export const containerShareSchema = z.object({
  containerName: z.string(),
  path: z.string()
});
export type ContainerShare = z.infer<typeof containerShareSchema>;

/**
 * `GET …/share`. ⚠️ `share: null` is the answer "nobody has chosen" and not
 * an error; it comes with `200`. An unreachable arm is `503`, not `null`.
 */
export const containerShareLookupSchema = z.object({
  share: z.nullable(containerShareSchema)
});

/** `PUT …/share`: the choice just stored. */
export const containerShareResponseSchema = z.object({
  share: containerShareSchema
});

/**
 * A text file as `GET …/file-text` returns it.
 *
 * ⚠️ `hash` is the POINT of this shape: it goes back as `expectedHash` on
 * saving and is the only lock against silently overwriting someone else's
 * change.
 */
export const fileTextSchema = z.object({
  path: z.string(),
  content: z.string(),
  hash: z.string()
});
export type FileText = z.infer<typeof fileTextSchema>;

/** `GET …/file-text`. */
export const fileTextResponseSchema = z.object({
  text: fileTextSchema
});

/**
 * `PUT …/file-text` (200): the hash the file carries now. A conflict is a
 * `409` with the current hash in the error body, not this shape.
 */
export const fileTextSavedSchema = z.object({
  hash: z.string()
});

/**
 * The receipt of an upload. `ok` is the literal `true`: the answer only comes
 * on success, every other case is a status code.
 */
export const fileUploadedSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  size: z.number()
});
export type FileUploaded = z.infer<typeof fileUploadedSchema>;

/** `PUT …/file`. */
export const fileUploadResponseSchema = z.object({
  uploaded: fileUploadedSchema
});

/**
 * The receipt of a folder action. Both fields are nullable because the agent
 * names only one of them per action: the new name for `create-directory` and
 * `rename`, the kind of the removed entry for `delete`.
 */
export const fileActionDoneSchema = z.object({
  name: z.nullable(z.string()),
  kind: z.nullable(z.string())
});
export type FileActionDone = z.infer<typeof fileActionDoneSchema>;

/** `POST …/files`. */
export const fileActionResponseSchema = z.object({
  done: fileActionDoneSchema
});

/**
 * The three actions `POST …/files` accepts.
 *
 * ⚠️ These are the HUB's English names, not the agent's. The agent has German
 * names for the same three acts (`FILE_ACTIONS`, `contract/src/agent/`);
 * the translation lives in the server
 * (`OWN_ACTION_NAMES`, `api/routes/file-routes.ts`) and is typed against this
 * list.
 */
export const fileCommandActionSchema = z.enum(["create-directory", "rename", "delete"]);
export type FileCommandAction = z.infer<typeof fileCommandActionSchema>;

/**
 * The body of `POST …/files` — a request, built by the web.
 *
 * ⚠️ `path` means something different per action: for `create-directory`
 * the TARGET DIRECTORY, for `rename` and `delete` the entry ITSELF.
 */
export const fileCommandSchema = z.object({
  action: fileCommandActionSchema,
  path: z.string(),
  // Only for `create-directory` and `rename`.
  name: z.optional(z.string())
});
export type FileCommand = z.infer<typeof fileCommandSchema>;
