import * as z from "zod/mini";
import { stopIntentTargetSchema } from "./stop-intents.js";
import { expectedContainerSchema, runtimeStateSchema } from "./runtime-actions.js";
import { backupOptionsSchema, backupErrorSchema } from "./backups.js";
import { fileSourceSchema, fileAccessErrorSchema } from "./file-access.js";
import { agentJobScopeSchema, agentJobRequestSchema, agentJobStartResponseSchema, agentJobCancelResponseSchema,
  agentJobProgressFieldsSchema, agentJobProgressIsConsistent } from "./jobs.js";
import { updateStartDeadlineSchema } from "./update-deadlines.js";
import { ACTION_QUEUE_WAIT_MS } from "./runtime-deadlines.js";

export const MUTATION_QUEUE_POLICY = {
  update: ACTION_QUEUE_WAIT_MS, restore: ACTION_QUEUE_WAIT_MS, composeApply: ACTION_QUEUE_WAIT_MS, fileWrite: 0
} as const;
export const UPDATE_CANCEL_BOUNDARY = "before-first-exchange";
export const UPDATE_COMPLETION_RULE = {
  restartPolicy: "no", dependencyCondition: "service_completed_successfully",
  initialStates: ["running", "restarting"]
} as const;
export const UPDATE_ERRORS = [
  "scaled-service-unsupported", "oneoff-unsupported", "local-image-no-registry-digest", "manifest-query-failed",
  "update-preview-stale", "update-digest-changed", "update-rollback-unavailable", "update-pull-failed",
  "update-phase-deadline-exceeded", "update-exchange-failed", "update-start-failed", "update-health-timeout",
  "update-container-exited", "update-container-restarted", "update-completion-failed", "update-state-mismatch",
  "update-rollback-failed", "update-cancel-too-late", "update-job-unknown", "update-cancel-resume-failed",
  "state-changed", "action-queue-timeout"
] as const;
export const updateErrorSchema = z.enum(UPDATE_ERRORS);
export type UpdateError = z.infer<typeof updateErrorSchema>;
export const updateWarningSchema = z.enum([
  "unhealthy", "restarting", "paused", "live-backup-inconsistent", "shared-source-writers",
  "database-consistency-not-guaranteed", "rollback-does-not-restore-data"
]);
export type UpdateWarning = z.infer<typeof updateWarningSchema>;
export const updatePhaseSchema = z.enum([
  "queued", "precheck", "pull", "backup", "exchange", "verify", "rollback", "resume", "completed"
]);
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;
export const updateOutcomeSchema = z.enum([
  "unchanged", "updated", "cancelled", "failed", "rolled-back", "rollback-failed"
]);
export type UpdateOutcome = z.infer<typeof updateOutcomeSchema>;
export const updateTargetSchema = stopIntentTargetSchema;
export type UpdateTarget = z.infer<typeof updateTargetSchema>;
export const updateScopeSchema = agentJobScopeSchema;
export type UpdateScope = z.infer<typeof updateScopeSchema>;
export { updateStartDeadlineSchema } from "./update-deadlines.js";
export const updateContainerSettingsSchema = z.object({ startDeadlineSeconds: updateStartDeadlineSchema });
export type UpdateContainerSettings = z.infer<typeof updateContainerSettingsSchema>;
export const updateDigestSchema = z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/));
export const updateServiceSelectionSchema = z.object({
  target: updateTargetSchema, expectedContainer: expectedContainerSchema,
  startDeadlineSeconds: updateStartDeadlineSchema, backup: z.nullable(backupOptionsSchema)
});
export const updatePreviewRequestSchema = z.object({
  target: updateScopeSchema, services: z.array(updateServiceSelectionSchema).check(z.minLength(1))
}).check(z.refine((request) => {
  const target = request.target;
  const keys = request.services.map((service) => JSON.stringify(service.target));
  if (new Set(keys).size !== keys.length) return false;
  return target.kind === "stack"
    ? request.services.every((service) => service.target.kind === "compose"
      && service.target.projectName === target.projectName)
    : request.services.length === 1 && keys[0] === JSON.stringify(target);
}));
export type UpdatePreviewRequest = z.input<typeof updatePreviewRequestSchema>;
export const updateFailureSchema = z.union([updateErrorSchema, backupErrorSchema, fileAccessErrorSchema]);
export const updateServicePreviewSchema = z.object({
  ...updateServiceSelectionSchema.shape,
  imageRef: z.string().check(z.minLength(1)), currentDigest: z.nullable(updateDigestSchema),
  offeredDigest: z.nullable(updateDigestSchema), rollbackImageId: z.nullable(z.string()),
  definitionHash: z.string().check(z.minLength(1)),
  acceptance: z.enum(["created", "service", "completion-job"]),
  initialState: runtimeStateSchema, mounts: z.array(fileSourceSchema), warnings: z.array(updateWarningSchema), blocker: z.nullable(updateFailureSchema)
});
export type UpdateServicePreview = z.infer<typeof updateServicePreviewSchema>;
export const updatePreviewResponseSchema = z.object({
  previewId: z.string().check(z.minLength(1)), target: updateScopeSchema,
  digestSource: z.literal("registry-manifest"), services: z.array(updateServicePreviewSchema).check(z.minLength(1))
});
export type UpdatePreviewResponse = z.infer<typeof updatePreviewResponseSchema>;
export const updateStartRequestSchema = z.object({
  previewId: updatePreviewResponseSchema.shape.previewId, target: updateScopeSchema,
  services: z.array(z.object({
    ...updateServiceSelectionSchema.shape, offeredDigest: updateDigestSchema,
    definitionHash: updateServicePreviewSchema.shape.definitionHash
  })).check(z.minLength(1)), confirmed: z.literal(true)
}).check(z.refine((request) => updatePreviewRequestSchema.safeParse(request).success));
export type UpdateStartRequest = z.input<typeof updateStartRequestSchema>;
export const updateJobRequestSchema = agentJobRequestSchema;
export const updateStartResponseSchema = agentJobStartResponseSchema;
export const updateCancelRequestSchema = agentJobRequestSchema;
export const updateCancelResponseSchema = agentJobCancelResponseSchema;
export const updateServiceResultSchema = z.object({
  target: updateTargetSchema, outcome: updateOutcomeSchema, state: runtimeStateSchema,
  imageId: z.nullable(z.string()), definitionHash: z.nullable(z.string()), backupId: z.nullable(z.string()),
  updateError: z.nullable(updateFailureSchema), rollbackError: z.nullable(updateErrorSchema), resumeError: z.nullable(backupErrorSchema)
});
export type UpdateServiceResult = z.infer<typeof updateServiceResultSchema>;
export const updateResultSchema = z.object({
  target: updateScopeSchema, outcome: updateOutcomeSchema, services: z.array(updateServiceResultSchema),
  updateError: z.nullable(updateFailureSchema), rollbackError: z.nullable(updateErrorSchema)
});
export type UpdateResult = z.infer<typeof updateResultSchema>;
export const updateProgressSchema = z.object({
  ...agentJobProgressFieldsSchema.shape, kind: z.literal("update"), target: updateScopeSchema,
  service: z.nullable(updateTargetSchema), phase: updatePhaseSchema,
  firstExchangeStarted: z.boolean(),
  result: z.nullable(updateResultSchema)
}).check(z.refine((progress) => agentJobProgressIsConsistent(progress)
  && (!progress.cancelAllowed || (!progress.firstExchangeStarted && !["exchange", "verify", "rollback", "resume", "completed"].includes(progress.phase)))));
export type UpdateProgress = z.infer<typeof updateProgressSchema>;
export const updateJobResponseSchema = z.object({ progress: updateProgressSchema });

// Completion jobs must be running at entry; finished jobs keep the created-only path.
export function updateAcceptance(initialStatus: string, completionDependency: boolean, restartPolicy: string | null, targetKind: "compose" | "container"):
  "created" | "service" | "completion-job" {
  if (!["running", "restarting", "paused"].includes(initialStatus)) return "created";
  return targetKind === "compose" && initialStatus !== "paused" && completionDependency && (restartPolicy === null || restartPolicy === "no")
    ? "completion-job" : "service";
}
export type UpdateStartDeadline = z.infer<typeof updateStartDeadlineSchema>;
export type UpdateDigest = z.infer<typeof updateDigestSchema>;
export type UpdateServiceSelection = z.infer<typeof updateServiceSelectionSchema>;
export type UpdateJobRequest = z.infer<typeof updateJobRequestSchema>;
export type UpdateStartResponse = z.infer<typeof updateStartResponseSchema>;
export type UpdateCancelRequest = z.infer<typeof updateCancelRequestSchema>;
export type UpdateCancelResponse = z.infer<typeof updateCancelResponseSchema>;
export type UpdateJobResponse = z.infer<typeof updateJobResponseSchema>;
