const reasons = {
  "source-unknown": "backupReasonUnknown",
  "source-protected": "backupReasonProtected",
  "source-shared": "backupReasonShared",
  "source-ownership-unknown": "backupReasonOwnership",
  "source-read-only": "backupReasonReadOnly",
  "backup-directory-protected": "backupReasonProtected",
  "not-mounted": "backupReasonUnknown",
  "backup-space-insufficient": "backupReasonSpace",
  "backup-size-unavailable": "backupReasonSize",
  "backup-copy-failed": "backupReasonCopy",
  "backup-deadline-exceeded": "backupReasonDeadline",
  "backup-unknown": "backupReasonMissing",
  "backup-target-mismatch": "backupReasonTarget",
  "backup-mount-mismatch": "backupReasonMount",
  "backup-incomplete": "backupReasonCopy",
  "restore-extract-failed": "backupReasonExtract",
  "restore-deadline-exceeded": "backupReasonDeadline",
  "restore-path-unsafe": "backupReasonPath",
  "restore-cancel-too-late": "backupReasonCancelLate",
  "restore-job-unknown": "backupReasonUnknown",
  "restore-cancel-resume-failed": "backupReasonResume",
  "stop-failed": "backupReasonStop",
  "resume-failed": "backupReasonResume",
  "state-changed": "backupReasonTarget",
  "action-queue-timeout": "backupReasonTarget",
  "live-backup-inconsistent": "backupReasonLive",
  "shared-source-writers": "backupReasonShared",
} as const satisfies Readonly<Record<string, string>>;

export const RESTORE_PHASE_MESSAGES = { queued: "updatePhaseQueued", stop: "restorePhaseStop", extract: "restorePhaseExtract", resume: "restorePhaseResume", completed: "updatePhaseCompleted" } as const;

export const BACKUP_REASON_MESSAGES: Readonly<Record<string, (typeof reasons)[keyof typeof reasons]>> = reasons;
