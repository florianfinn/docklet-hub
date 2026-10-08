import * as z from "zod/mini";
import { COMPOSE_RAW_GATE_FAILURE_REASONS } from "./compose-reasons.js";
import { updateStartDeadlineSchema } from "./update-deadlines.js";
import { stopIntentTargetSchema } from "./stop-intents.js";
import { fileSourceSelectionSchema, fileSourceSchema, estimatedBytesSchema, FILE_SOURCE_ERRORS } from "./file-access.js";
import { agentJobRequestSchema, agentJobStartResponseSchema, agentJobCancelResponseSchema,
  agentJobProgressFieldsSchema, agentJobProgressIsConsistent } from "./jobs.js";
import { runtimeStateSchema, expectedContainerSchema } from "./runtime-actions.js";

export const BACKUP_RETENTION_COUNT = 3;
export const BACKUP_FREE_RESERVE_BYTES = 1024 * 1024 * 1024;
export const BACKUP_DIRECTORY_ENV = "DOCKER_AGENT_BACKUP_DIR";
export const BACKUP_DIRECTORY_DEFAULT = "backups";
export const BACKUP_DIRECTORY_MODE = 0o700;
export const BACKUP_ARCHIVE_MODE = 0o600;
export const BACKUP_DEFAULT_MODE = "stop";
export const BACKUP_ERRORS = [
  ...FILE_SOURCE_ERRORS, ...COMPOSE_RAW_GATE_FAILURE_REASONS, "scaled-service-unsupported", "backup-space-insufficient", "backup-size-unavailable",
  "backup-copy-failed", "backup-deadline-exceeded", "backup-unknown", "backup-target-mismatch",
  "backup-mount-mismatch", "backup-incomplete", "restore-extract-failed", "restore-deadline-exceeded",
  "restore-path-unsafe", "restore-cancel-too-late", "restore-job-unknown", "restore-cancel-resume-failed", "stop-failed", "resume-failed", "state-changed", "action-queue-timeout"
] as const;
export const backupErrorSchema = z.enum(BACKUP_ERRORS);
export type BackupError = z.infer<typeof backupErrorSchema>;
export const backupModeSchema = z.enum(["stop", "live"]);
export const backupMountSelectionSchema = z.object({ ...fileSourceSelectionSchema.shape, estimatedBytes: estimatedBytesSchema });
export const backupOptionsSchema = z.object({
  mode: backupModeSchema,
  mounts: z.array(backupMountSelectionSchema).check(z.minLength(1), z.refine((mounts) =>
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
export const restorePreviewRequestSchema = z.object({
  target: stopIntentTargetSchema, backupId: backupEntrySchema.shape.backupId,
  mounts: z.array(fileSourceSelectionSchema).check(z.minLength(1), z.refine((mounts) =>
    new Set(mounts.map((mount) => mount.sourceId)).size === mounts.length))
});

export const restorePreviewResponseSchema = z.object({
  ...restorePreviewRequestSchema.shape, previewId: z.string().check(z.minLength(1)),
  expectedContainer: expectedContainerSchema, backup: backupEntrySchema,
  targets: z.array(fileSourceSchema).check(z.minLength(1)), warnings: z.array(z.enum(["data-overwrite", "database-consistency-not-guaranteed"]))
}).check(z.refine((preview) => preview.backupId === preview.backup.backupId
  && JSON.stringify(preview.target) === JSON.stringify(preview.backup.target)
  && preview.targets.length === preview.mounts.length
  && preview.mounts.every((mount) => preview.backup.archives.some((archive) => archive.sourceId === mount.sourceId)
    && preview.targets.filter((source) => source.sourceId === mount.sourceId && source.restoreEligible).length === 1)));

export const restoreStartRequestSchema = z.object({
  ...restorePreviewRequestSchema.shape, previewId: restorePreviewResponseSchema.shape.previewId,
  expectedContainer: expectedContainerSchema, startDeadlineSeconds: updateStartDeadlineSchema, confirmed: z.literal(true)
});
export type RestoreStartRequest = z.input<typeof restoreStartRequestSchema>;
export const restoreResultSchema = z.object({
  target: stopIntentTargetSchema, backupId: backupEntrySchema.shape.backupId, ok: z.boolean(),
  outcome: z.enum(["restored", "cancelled", "failed"]),
  state: runtimeStateSchema, restoreError: z.nullable(backupErrorSchema), resumeError: z.nullable(backupErrorSchema)
});
export type RestoreResult = z.infer<typeof restoreResultSchema>;
export type BackupMode = z.infer<typeof backupModeSchema>;
export type BackupArchive = z.infer<typeof backupArchiveSchema>;
export type BackupListRequest = z.infer<typeof backupListRequestSchema>;
export type BackupListResponse = z.infer<typeof backupListResponseSchema>;
export type RestorePreviewRequest = z.infer<typeof restorePreviewRequestSchema>;
export type RestorePreviewResponse = z.infer<typeof restorePreviewResponseSchema>;

export const RESTORE_CANCEL_BOUNDARY = "before-extract";
export const restorePhaseSchema = z.enum(["queued", "stop", "extract", "resume", "completed"]);
export const restoreStartResponseSchema = agentJobStartResponseSchema;
export const restoreJobRequestSchema = agentJobRequestSchema;
export const restoreCancelRequestSchema = agentJobRequestSchema;
export const restoreCancelResponseSchema = agentJobCancelResponseSchema;
export const restoreProgressSchema = z.object({
  ...agentJobProgressFieldsSchema.shape, kind: z.literal("restore"), target: stopIntentTargetSchema,
  phase: restorePhaseSchema, extractStarted: z.boolean(), result: z.nullable(restoreResultSchema)
}).check(z.refine((progress) => agentJobProgressIsConsistent(progress)
  && (!progress.cancelAllowed || (!progress.extractStarted && ["queued", "stop"].includes(progress.phase)))
  && (progress.phase !== "extract" || progress.extractStarted)));
export const restoreJobResponseSchema = z.object({ progress: restoreProgressSchema });
export type BackupMountSelection = z.infer<typeof backupMountSelectionSchema>;
export type RestorePhase = z.infer<typeof restorePhaseSchema>;
export type RestoreStartResponse = z.infer<typeof restoreStartResponseSchema>;
export type RestoreJobRequest = z.infer<typeof restoreJobRequestSchema>;
export type RestoreCancelRequest = z.infer<typeof restoreCancelRequestSchema>;
export type RestoreCancelResponse = z.infer<typeof restoreCancelResponseSchema>;
export type RestoreProgress = z.infer<typeof restoreProgressSchema>;
export type RestoreJobResponse = z.infer<typeof restoreJobResponseSchema>;
