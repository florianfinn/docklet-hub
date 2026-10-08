import * as z from "zod/mini";
import { updateStartDeadlineSchema } from "./update-deadlines.js";
import { stopIntentTargetSchema } from "./stop-intents.js";
import { fileSourceSelectionSchema, FILE_SOURCE_ERRORS } from "./file-access.js";
import { runtimeStateSchema, expectedContainerSchema } from "./runtime-actions.js";

export const BACKUP_RETENTION_COUNT = 3;
export const BACKUP_FREE_RESERVE_BYTES = 1024 * 1024 * 1024;
export const BACKUP_DIRECTORY_ENV = "DOCKER_AGENT_BACKUP_DIR";
export const BACKUP_DIRECTORY_DEFAULT = "backups";
export const BACKUP_DIRECTORY_MODE = 0o700;
export const BACKUP_ARCHIVE_MODE = 0o600;
export const BACKUP_DEFAULT_MODE = "stop";
export const BACKUP_ERRORS = [
  ...FILE_SOURCE_ERRORS, "scaled-service-unsupported", "backup-space-insufficient", "backup-size-unavailable",
  "backup-copy-failed", "backup-deadline-exceeded", "backup-unknown", "backup-target-mismatch",
  "backup-mount-mismatch", "backup-incomplete", "restore-extract-failed", "restore-deadline-exceeded",
  "restore-path-unsafe", "stop-failed", "resume-failed", "state-changed", "action-queue-timeout"
] as const;
export const backupErrorSchema = z.enum(BACKUP_ERRORS);
export type BackupError = z.infer<typeof backupErrorSchema>;
export const backupModeSchema = z.enum(["stop", "live"]);
export const backupOptionsSchema = z.object({
  mode: backupModeSchema,
  mounts: z.array(fileSourceSelectionSchema).check(z.minLength(1), z.refine((mounts) =>
    new Set(mounts.map((mount) => mount.sourceId)).size === mounts.length))
});
export type BackupOptions = z.infer<typeof backupOptionsSchema>;
export const backupArchiveSchema = z.object({
  sourceId: fileSourceSelectionSchema.shape.sourceId,
  mountTarget: z.string(), archiveId: z.string().check(z.minLength(1)), bytes: z.int().check(z.minimum(0))
});
export const backupEntrySchema = z.object({
  backupId: z.string().check(z.minLength(1)), target: stopIntentTargetSchema,
  completedAt: z.iso.datetime(), mode: backupModeSchema,
  archives: z.array(backupArchiveSchema).check(z.minLength(1))
});
export type BackupEntry = z.infer<typeof backupEntrySchema>;
export const backupListRequestSchema = z.object({ target: stopIntentTargetSchema });
export const backupListResponseSchema = z.object({
  target: stopIntentTargetSchema, backups: z.array(backupEntrySchema).check(z.maxLength(BACKUP_RETENTION_COUNT))
});
export const backupStartRequestSchema = z.object({
  target: stopIntentTargetSchema, expectedContainer: expectedContainerSchema, options: backupOptionsSchema
});
export const restorePreviewRequestSchema = z.object({
  target: stopIntentTargetSchema, backupId: backupEntrySchema.shape.backupId,
  mounts: backupOptionsSchema.shape.mounts
});
export const restorePreviewResponseSchema = z.object({
  ...restorePreviewRequestSchema.shape, previewId: z.string().check(z.minLength(1)),
  expectedContainer: expectedContainerSchema, warnings: z.array(z.enum(["data-overwrite", "database-consistency-not-guaranteed"]))
});
export const restoreStartRequestSchema = z.object({
  ...restorePreviewRequestSchema.shape, previewId: restorePreviewResponseSchema.shape.previewId,
  expectedContainer: expectedContainerSchema, startDeadlineSeconds: updateStartDeadlineSchema, confirmed: z.literal(true)
});
export type RestoreStartRequest = z.input<typeof restoreStartRequestSchema>;
export const restoreResultSchema = z.object({
  target: stopIntentTargetSchema, backupId: backupEntrySchema.shape.backupId, ok: z.boolean(),
  state: runtimeStateSchema, restoreError: z.nullable(z.string()), resumeError: z.nullable(z.string())
});
export type RestoreResult = z.infer<typeof restoreResultSchema>;
export type BackupMode = z.infer<typeof backupModeSchema>;
export type BackupArchive = z.infer<typeof backupArchiveSchema>;
export type BackupListRequest = z.infer<typeof backupListRequestSchema>;
export type BackupListResponse = z.infer<typeof backupListResponseSchema>;
export type BackupStartRequest = z.infer<typeof backupStartRequestSchema>;
export type RestorePreviewRequest = z.infer<typeof restorePreviewRequestSchema>;
export type RestorePreviewResponse = z.infer<typeof restorePreviewResponseSchema>;
