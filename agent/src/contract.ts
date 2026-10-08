import {
  AGENT_JOB_RESULT_RETENTION_MS, agentJobKindSchema, agentJobStartResponseSchema, agentJobProgressFieldsSchema,
  agentJobsQuerySchema, agentJobsResponseSchema, UPDATE_PREVIEW_TIMEOUT_MS, UPDATE_PREVIEW_MANIFEST_MODE,
  RESTORE_CANCEL_BOUNDARY, restorePhaseSchema, restoreProgressSchema, restorePreviewResponseSchema,
  backupMountSelectionSchema, updateServiceResultSchema,
  UPDATE_START_DEADLINE_SECONDS, UPDATE_STABILITY_WINDOW_MS, UPDATE_PRECHECK_TIMEOUT_MS, UPDATE_PULL_TIMEOUT_MS,
  BACKUP_COPY_TIMEOUT_MS, UPDATE_STOP_TIMEOUT_MS, UPDATE_CREATE_TIMEOUT_MS, UPDATE_READBACK_TIMEOUT_MS,
  UPDATE_MUTATION_RESERVE_MS, BACKUP_PHASE_TIMEOUT_MS, MUTATION_QUEUE_POLICY,
  UPDATE_CANCEL_BOUNDARY, UPDATE_COMPLETION_RULE, UPDATE_ERRORS, BACKUP_ERRORS, FILE_ACCESS_ERRORS,
  BACKUP_RETENTION_COUNT, BACKUP_FREE_RESERVE_BYTES, BACKUP_DIRECTORY_ENV, BACKUP_DIRECTORY_DEFAULT,
  BACKUP_DIRECTORY_MODE, BACKUP_ARCHIVE_MODE, BACKUP_DEFAULT_MODE, EDITOR_TEXT_LIMITS,
  updatePreviewRequestSchema, updatePreviewResponseSchema, updateServiceSelectionSchema, updateServicePreviewSchema,
  updateStartRequestSchema, updateProgressSchema, updateResultSchema, updatePhaseSchema, updateOutcomeSchema,
  updateWarningSchema, backupOptionsSchema, backupEntrySchema, backupArchiveSchema, restoreStartRequestSchema,
  restorePreviewRequestSchema, restoreResultSchema, fileSourceSchema, sourceFileTextWriteRequestSchema,
  shareQuerySchema, fileUploadQuerySchema, fileSourcesResponseSchema,
  backupListResponseSchema, agentJobResponseSchema, agentJobCancelResponseSchema,
  agentJobRequestSchema,
  SELF_HEALING_LIMITS,
  selfHealingConfigSchema,
  selfHealingMaintenanceRequestSchema, selfHealingIncidentSchema, selfHealingBudgetSchema,
  selfHealingStatusResponseSchema, SELF_HEALING_SYSTEM_ACTOR, SELF_HEALING_RECOMMENDATION,
  ACTOR_HEADER,
  stackActionStreamLineSchema,
  RUNTIME_ACTION_ERRORS,
  COMPOSE_RAW_FAILURE_REASONS,
  composeApplyStreamLineSchema,
  CONTRACT_VERSION,
  execStreamLineSchema,
  LOG_FILE_FAILURE_REASONS,
  logFileStreamLineSchema,
  LOGS_STREAM_FAILURE_REASONS,
  logsStreamLineSchema,
  PULL_STREAM_FAILURE_REASONS,
  pullStreamLineSchema,
  registryComposeSchema,
  registryEntrySchema,
  registryOriginSchema,
  SECRET_HEADER,
  SHARED_HTTP_ERRORS
} from "contract";

import { ROUTES } from "./route-policy.js";

// What `GET /contract` reports. Since #272 every value here comes from the
// shared schemas in `contract/src/agent/`; this file only arranges them in
// the form the route has had since v0.28.0.

export { CONTRACT_VERSION };

// "required" or "optional", read off the schema of today's entry of
// `PUT /registry`, so that the report cannot disagree with the check.
function fieldPresence<Shape extends Record<string, { _zod: { optin?: string } }>>(
  shape: Shape
): { [Key in keyof Shape]: "required" | "optional" } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema._zod.optin === "optional" ? "optional" : "required"])
  ) as { [Key in keyof Shape]: "required" | "optional" };
}

export const CONTRACT_HEADERS = {
  secret: SECRET_HEADER,
  actor: ACTOR_HEADER
} as const;

// The `kind` values a stream schema allows, in its order.
type KindOption = { _zod: { def: { shape: { kind: { _zod: { def: { values: readonly unknown[] } } } } } } };

function kindsOf(schema: { _zod: { def: { options: readonly unknown[] } } }): string[] {
  return schema._zod.def.options.map((option) => String((option as KindOption)._zod.def.shape.kind._zod.def.values[0]));
}

// A stream kind is only promised for the route named. In particular, "output"/"end"
// belong to the exec session and "step" to the raw editor, not to the log.
const NDJSON_KINDS = {
  logsStream: kindsOf(logsStreamLineSchema),
  logFile: kindsOf(logFileStreamLineSchema),
  pullStream: kindsOf(pullStreamLineSchema),
  composeRawStream: kindsOf(composeApplyStreamLineSchema),
  exec: kindsOf(execStreamLineSchema),
  stackActions: kindsOf(stackActionStreamLineSchema)
};

export const AGENT_CONTRACT = {
  contractVersion: CONTRACT_VERSION,
  headers: CONTRACT_HEADERS,
  routes: ROUTES.map((route) => ({ ...route })),
  registry: {
    entryFields: fieldPresence(registryEntrySchema.shape),
    composeFields: fieldPresence(registryComposeSchema.shape),
    composeOrigins: registryOriginSchema.options
  },
  selfHealing: {
    fields: fieldPresence(selfHealingConfigSchema.shape), limits: SELF_HEALING_LIMITS, unlimitedMaintenanceDuration: null,
    actor: SELF_HEALING_SYSTEM_ACTOR, recommendation: SELF_HEALING_RECOMMENDATION,
    maintenanceFields: fieldPresence(selfHealingMaintenanceRequestSchema.shape),
    statusFields: fieldPresence(selfHealingStatusResponseSchema.shape),
    budgetFields: fieldPresence(selfHealingBudgetSchema.shape), incidentFields: fieldPresence(selfHealingIncidentSchema.shape)
  },
  updates: {
    startDeadlineSeconds: UPDATE_START_DEADLINE_SECONDS, stabilityWindowMs: UPDATE_STABILITY_WINDOW_MS,
    preview: { timeoutMs: UPDATE_PREVIEW_TIMEOUT_MS, manifestMode: UPDATE_PREVIEW_MANIFEST_MODE },
    phaseTimeouts: { precheck: UPDATE_PRECHECK_TIMEOUT_MS, pull: UPDATE_PULL_TIMEOUT_MS, backupCopy: BACKUP_COPY_TIMEOUT_MS,
      stop: UPDATE_STOP_TIMEOUT_MS, create: UPDATE_CREATE_TIMEOUT_MS, readback: UPDATE_READBACK_TIMEOUT_MS,
      mutationReserve: UPDATE_MUTATION_RESERVE_MS, backup: BACKUP_PHASE_TIMEOUT_MS },
    queuePolicy: MUTATION_QUEUE_POLICY, cancelBoundary: UPDATE_CANCEL_BOUNDARY, completionRule: UPDATE_COMPLETION_RULE,
    phases: updatePhaseSchema.options, outcomes: updateOutcomeSchema.options, warnings: updateWarningSchema.options,
    previewRequestFields: fieldPresence(updatePreviewRequestSchema.shape),
    previewResponseFields: fieldPresence(updatePreviewResponseSchema.shape),
    serviceResultFields: fieldPresence(updateServiceResultSchema.shape),
    selectionFields: fieldPresence(updateServiceSelectionSchema.shape), previewServiceFields: fieldPresence(updateServicePreviewSchema.shape),
    startFields: fieldPresence(updateStartRequestSchema.shape), progressFields: fieldPresence(updateProgressSchema.shape),
    resultFields: fieldPresence(updateResultSchema.shape)
  },
  backups: {
    retention: BACKUP_RETENTION_COUNT, freeReserveBytes: BACKUP_FREE_RESERVE_BYTES,
    directoryEnv: BACKUP_DIRECTORY_ENV, directoryDefault: BACKUP_DIRECTORY_DEFAULT,
    directoryMode: BACKUP_DIRECTORY_MODE, archiveMode: BACKUP_ARCHIVE_MODE, defaultMode: BACKUP_DEFAULT_MODE,
    optionFields: fieldPresence(backupOptionsSchema.shape), entryFields: fieldPresence(backupEntrySchema.shape),
    mountSelectionFields: fieldPresence(backupMountSelectionSchema.shape),
    listResponseFields: fieldPresence(backupListResponseSchema.shape),
    restorePreviewResponseFields: fieldPresence(restorePreviewResponseSchema.shape),
    restorePhases: restorePhaseSchema.options, restoreCancelBoundary: RESTORE_CANCEL_BOUNDARY,
    restoreProgressFields: fieldPresence(restoreProgressSchema.shape),
    archiveFields: fieldPresence(backupArchiveSchema.shape), restorePreviewFields: fieldPresence(restorePreviewRequestSchema.shape),
    restoreStartFields: fieldPresence(restoreStartRequestSchema.shape), restoreResultFields: fieldPresence(restoreResultSchema.shape)
  },
  jobs: {
    kinds: agentJobKindSchema.options, resultRetentionMs: AGENT_JOB_RESULT_RETENTION_MS,
    startResponseFields: fieldPresence(agentJobStartResponseSchema.shape),
    requestFields: fieldPresence(agentJobRequestSchema.shape),
    responseFields: fieldPresence(agentJobResponseSchema.shape),
    cancelResponseFields: fieldPresence(agentJobCancelResponseSchema.shape),
    queryEncoding: { target: "json", kind: "string" },
    progressFields: fieldPresence(agentJobProgressFieldsSchema.shape),
    queryFields: fieldPresence(agentJobsQuerySchema.shape), listFields: fieldPresence(agentJobsResponseSchema.shape)
  },
  fileAccess: {
    textLimits: EDITOR_TEXT_LIMITS, sourceFields: fieldPresence(fileSourceSchema.shape),
    sourcesResponseFields: fieldPresence(fileSourcesResponseSchema.shape),
    queryFields: fieldPresence(shareQuerySchema.shape), uploadQueryFields: fieldPresence(fileUploadQuerySchema.shape),
    textWriteFields: fieldPresence(sourceFileTextWriteRequestSchema.shape), conflict: "file-changed-externally"
  },
  ndjsonKinds: NDJSON_KINDS,
  errors: {
    updates: UPDATE_ERRORS, backups: BACKUP_ERRORS, fileAccess: FILE_ACCESS_ERRORS,
    sharedHttp: SHARED_HTTP_ERRORS,
    runtimeActions: RUNTIME_ACTION_ERRORS,
    logsStream: LOGS_STREAM_FAILURE_REASONS,
    logFile: LOG_FILE_FAILURE_REASONS,
    pullStream: PULL_STREAM_FAILURE_REASONS,
    composeRaw: [...new Set(COMPOSE_RAW_FAILURE_REASONS)]
  }
} as const;
