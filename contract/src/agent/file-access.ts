import * as z from "zod/mini";
import { COMPOSE_RAW_GATE_FAILURE_REASONS } from "./compose-reasons.js";
import { mountSourceSchema } from "./projects.js";
import { MAX_TEXT_BYTES, MAX_COMPOSE_BYTES } from "./limits.js";
import { fileTextWriteRequestSchema } from "./requests.js";

export const EDITOR_TEXT_LIMITS = { files: MAX_TEXT_BYTES, compose: MAX_COMPOSE_BYTES } as const;
export const FILE_SOURCE_ERRORS = [
  "source-unknown", "source-protected", "source-shared", "source-ownership-unknown",
  "source-read-only", "backup-directory-protected", "not-mounted"
] as const;
export const FILE_ACCESS_ERRORS = [
  ...FILE_SOURCE_ERRORS, ...COMPOSE_RAW_GATE_FAILURE_REASONS, "path-empty", "path-absolute", "path-traversal", "path-invalid-characters",
  "path-blocked", "path-outside", "file-replaced", "not-readable", "not-writable", "wrong-kind",
  "not-a-text-file", "too-large", "already-exists", "file-changed-externally", "expected-hash-missing", "busy"
] as const;
export const fileAccessErrorSchema = z.enum(FILE_ACCESS_ERRORS);
export type FileAccessError = z.infer<typeof fileAccessErrorSchema>;

export const estimatedBytesSchema = z.nullable(z.int().check(z.minimum(0)));

// IDs identify agent-resolved sources; callers cannot nominate arbitrary host paths.
export const fileSourceSelectionSchema = z.object({ sourceId: z.string().check(z.minLength(1)) });
export const fileSourceSchema = z.object({
  ...mountSourceSchema.shape,
  sourceId: fileSourceSelectionSchema.shape.sourceId,
  readable: z.boolean(), writable: z.boolean(),
  writeBlocker: z.nullable(fileAccessErrorSchema),
  estimatedBytes: estimatedBytesSchema,
  backupEligible: z.boolean(), restoreEligible: z.boolean(),
  protection: z.enum(["none", "system", "agent", "backup", "unknown"]),
  ownership: z.enum(["exclusive", "shared", "unknown"])
}).check(z.refine((source) => {
  const safe = source.protection === "none";
  const exclusive = source.ownership === "exclusive" && !source.shared;
  return (source.protection !== "backup" || !source.readable) && (!source.writable || (safe && exclusive && !source.readOnly))
    && (!source.backupEligible || safe) && (!source.restoreEligible || (safe && exclusive && !source.readOnly));
}));
export type FileSource = z.infer<typeof fileSourceSchema>;
export const fileSourcesResponseSchema = z.object({ sources: z.array(fileSourceSchema) });
export const sourceFileQuerySchema = z.object({ ...fileSourceSelectionSchema.shape, path: z.string() });
export const sourceFileTextWriteRequestSchema = z.object({
  ...sourceFileQuerySchema.shape, ...fileTextWriteRequestSchema.shape
});
export type SourceFileTextWriteRequest = z.input<typeof sourceFileTextWriteRequestSchema>;
export const fileContentConflictSchema = z.object({ error: z.literal("file-changed-externally"), hash: z.string() });
export type FileContentConflict = z.infer<typeof fileContentConflictSchema>;
export type FileSourceSelection = z.infer<typeof fileSourceSelectionSchema>;
export type FileSourcesResponse = z.infer<typeof fileSourcesResponseSchema>;
export type SourceFileQuery = z.infer<typeof sourceFileQuerySchema>;
