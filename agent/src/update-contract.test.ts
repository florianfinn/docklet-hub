import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION, UPDATE_START_DEADLINE_SECONDS, UPDATE_STABILITY_WINDOW_MS,
  BACKUP_FREE_RESERVE_BYTES, BACKUP_RETENTION_COUNT, MUTATION_QUEUE_POLICY,
  UPDATE_COMPLETION_RULE, UPDATE_CANCEL_BOUNDARY, EDITOR_TEXT_LIMITS,
  MAX_TEXT_BYTES, MAX_COMPOSE_BYTES, UPDATE_ERRORS, BACKUP_ERRORS, FILE_ACCESS_ERRORS,
  updatePreviewRequestSchema, updateStartRequestSchema, updatePreviewResponseSchema,
  updateProgressSchema, updateResultSchema, updateAcceptance, updateStartDeadlineSchema,
  updateExchangeTimeoutMs, updateRollbackTimeoutMs, updateRunBudgetMs, restorePhaseTimeoutMs,
  backupOptionsSchema, backupListResponseSchema, restoreStartRequestSchema, restoreResultSchema,
  fileSourceSchema, sourceFileTextWriteRequestSchema, fileContentConflictSchema
} from "contract";
import { AGENT_CONTRACT } from "./contract.js";

const target = { kind: "compose", projectName: "demo", serviceName: "web" } as const;
const expectedContainer = { containerId: "original", status: "running", startedAt: "observed" };
const state = { ...expectedContainer, health: "healthy", exitCode: 0 };
const selection = { target, expectedContainer, startDeadlineSeconds: 120, backup: null };
const digest = `sha256:${"a".repeat(64)}`;
const request = { target, services: [selection] };
const start = { ...request, previewId: "preview", confirmed: true,
  services: [{ ...selection, offeredDigest: digest, definitionHash: "definition" }] };

for (const seconds of [10, 120, 1800]) test(`start deadline accepts ${seconds} seconds`, () => {
  assert.equal(updateStartDeadlineSchema.safeParse(seconds).success, true);
});
for (const seconds of [9, 1801, 10.5, NaN, Infinity]) test(`start deadline rejects ${seconds}`, () => {
  assert.equal(updateStartDeadlineSchema.safeParse(seconds).success, false);
  assert.throws(() => updateExchangeTimeoutMs(seconds), RangeError);
});

test("contract 13 reports shared values without advertising unimplemented routes", () => {
  assert.equal(CONTRACT_VERSION, 13);
  assert.deepEqual(AGENT_CONTRACT.updates.startDeadlineSeconds, UPDATE_START_DEADLINE_SECONDS);
  assert.equal(AGENT_CONTRACT.updates.cancelBoundary, UPDATE_CANCEL_BOUNDARY);
  assert.deepEqual(AGENT_CONTRACT.updates.completionRule, UPDATE_COMPLETION_RULE);
  assert.equal(AGENT_CONTRACT.backups.freeReserveBytes, BACKUP_FREE_RESERVE_BYTES);
  assert.equal(BACKUP_FREE_RESERVE_BYTES, 1_073_741_824);
  assert.equal(BACKUP_RETENTION_COUNT, 3);
  assert.deepEqual(EDITOR_TEXT_LIMITS, { files: MAX_TEXT_BYTES, compose: MAX_COMPOSE_BYTES });
  assert.deepEqual(MUTATION_QUEUE_POLICY, { update: 60_000, restore: 60_000, composeApply: 60_000, fileWrite: 0 });
  assert.equal(AGENT_CONTRACT.routes.some((route) => route.pattern.includes("update-jobs")), false);
  for (const errors of [UPDATE_ERRORS, BACKUP_ERRORS]) assert.ok(errors.includes("scaled-service-unsupported"));
  assert.ok(FILE_ACCESS_ERRORS.includes("file-changed-externally"));
});

test("budgets reserve recovery and sum per-service deadlines across a stack", () => {
  assert.equal(UPDATE_STABILITY_WINDOW_MS, 30_000);
  assert.equal(updateExchangeTimeoutMs(10), 750_000);
  assert.equal(updateExchangeTimeoutMs(120), 840_000);
  assert.equal(updateRollbackTimeoutMs(1800), 2_520_000);
  assert.equal(restorePhaseTimeoutMs(120), 4_440_000);
  for (const [count, backup, seconds, expected] of [
    [1, false, 120, 2_670_000], [3, false, 120, 7_950_000],
    [1, true, 120, 6_990_000], [3, true, 120, 20_910_000], [1, true, 1800, 10_350_000]
  ] as const) assert.equal(updateRunBudgetMs(Array.from({ length: count }, () => ({ startDeadlineSeconds: seconds, backup }))), expected);
});

test("preview and start bind stable scope, expected state, options, digest and definition", () => {
  assert.deepEqual(updatePreviewRequestSchema.parse(request), request);
  assert.deepEqual(updateStartRequestSchema.parse(start), start);
  assert.equal(updatePreviewRequestSchema.safeParse({ target: { kind: "stack", projectName: "demo" }, services: [selection] }).success, true);
  assert.equal(updatePreviewRequestSchema.safeParse({ target: { kind: "stack", projectName: "other" }, services: [selection] }).success, false);
  assert.equal(updatePreviewRequestSchema.safeParse({ ...request, services: [selection, selection] }).success, false);
  assert.equal(updateStartRequestSchema.safeParse({ ...start, services: [start.services[0], start.services[0]] }).success, false);
  assert.equal(updatePreviewRequestSchema.safeParse({ ...request, services: [{ ...selection, target: { kind: "container", containerName: "other" } }] }).success, false);
  assert.equal(updatePreviewRequestSchema.safeParse({ ...request, services: [] }).success, false);
});
for (const field of ["previewId", "confirmed"]) test(`update start requires ${field}`, () => {
  const value: Record<string, unknown> = { ...start }; delete value[field];
  assert.equal(updateStartRequestSchema.safeParse(value).success, false);
});
for (const field of ["expectedContainer", "startDeadlineSeconds", "backup", "offeredDigest", "definitionHash"]) {
  test(`update service requires ${field}`, () => {
    const value: Record<string, unknown> = { ...start.services[0] }; delete value[field];
    assert.equal(updateStartRequestSchema.safeParse({ ...start, services: [value] }).success, false);
  });
}

test("manifest-only preview explains local images and state warnings", () => {
  const preview = { previewId: "preview", target, digestSource: "registry-manifest", services: [{
    ...selection, imageRef: "demo:1.0.0", currentDigest: null, offeredDigest: null,
    rollbackImageId: "old-image", definitionHash: "definition", acceptance: "service", initialState: state,
    mounts: [], warnings: ["unhealthy", "restarting", "paused"], blocker: "local-image-no-registry-digest"
  }] };
  assert.deepEqual(updatePreviewResponseSchema.parse(preview), preview);
  assert.equal(updatePreviewResponseSchema.safeParse({ ...preview, digestSource: "pull" }).success, false);
  assert.equal(updateStartRequestSchema.safeParse({ ...start, services: [{ ...start.services[0], offeredDigest: null }] }).success, false);
});

for (const status of ["exited", "created", "dead"]) test(`finished ${status} jobs are created without a runtime check`, () => {
  assert.equal(updateAcceptance(status, true, "no", "compose"), "created");
});
test("completion acceptance requires active initial state and explicit successful dependency", () => {
  for (const status of ["running", "restarting"]) {
    assert.equal(updateAcceptance(status, true, null, "compose"), "completion-job");
    assert.equal(updateAcceptance(status, true, "no", "compose"), "completion-job");
    assert.equal(updateAcceptance(status, false, "no", "compose"), "service");
    assert.equal(updateAcceptance(status, true, "always", "compose"), "service");
  }
  assert.equal(updateAcceptance("paused", true, "no", "compose"), "service");
  assert.equal(updateAcceptance("running", true, "no", "container"), "service");
});

test("polling progress cannot permit cancellation after the first exchange", () => {
  const progress = { kind: "update", completedAt: null, jobId: "job", target, service: target, phase: "backup",
    phaseStartedAt: "2026-10-08T00:00:00Z", phaseDeadlineAt: "2026-10-08T01:12:00Z",
    cancelAllowed: true, firstExchangeStarted: false, result: null };
  assert.deepEqual(updateProgressSchema.parse(progress), progress);
  assert.equal(updateProgressSchema.safeParse({ ...progress, firstExchangeStarted: true }).success, false);
  assert.equal(updateProgressSchema.safeParse({ ...progress, phase: "completed" }).success, false);
  assert.equal(updateProgressSchema.safeParse({ ...progress, firstExchangeStarted: true, cancelAllowed: false }).success, true);
});

test("results preserve update, rollback and resume failures separately", () => {
  const result = { target, outcome: "rollback-failed", updateError: "update-health-timeout", rollbackError: "update-rollback-failed",
    services: [{ target, outcome: "rollback-failed", state, imageId: "new-image", definitionHash: "definition", backupId: "backup",
      updateError: "update-health-timeout", rollbackError: "update-rollback-failed", resumeError: "resume-failed" }] };
  assert.deepEqual(updateResultSchema.parse(result), result);
  const restore = { target, backupId: "backup", ok: false, outcome: "failed", state, restoreError: "restore-extract-failed", resumeError: "resume-failed" };
  assert.deepEqual(restoreResultSchema.parse(restore), restore);
});

const mount = { sourceId: "data" };
const backup = { backupId: "backup", target, completedAt: "2026-10-08T00:00:00Z", mode: "stop",
  archives: [{ sourceId: "data", mountTarget: "/data", archiveId: "archive", bytes: 42 }] };
test("backup list retains runs with mount archives rather than counting each archive", () => {
  const list = { target, backups: Array.from({ length: 3 }, () => backup) };
  assert.deepEqual(backupListResponseSchema.parse(list), list);
  assert.equal(backupListResponseSchema.safeParse({ target, backups: [...list.backups, backup] }).success, false);
  assert.equal(backupListResponseSchema.safeParse({ target, backups: [{ ...backup, archives: [] }] }).success, false);
  for (const mode of ["stop", "live"]) assert.equal(backupOptionsSchema.safeParse({ mode, mounts: [{ ...mount, estimatedBytes: 42 }] }).success, true);
  assert.equal(backupOptionsSchema.safeParse({ mode: "stop", mounts: [] }).success, false);
  assert.equal(backupOptionsSchema.safeParse({ mode: "stop", mounts: [mount, mount] }).success, false);
});
test("restore requires an explicit backup choice and confirmation independent of update", () => {
  const restore = { target, backupId: "backup", previewId: "restore-preview", mounts: [mount], expectedContainer, startDeadlineSeconds: 120, confirmed: true };
  assert.deepEqual(restoreStartRequestSchema.parse(restore), restore);
  for (const field of ["backupId", "previewId", "mounts", "confirmed", "expectedContainer", "startDeadlineSeconds"]) {
    const value: Record<string, unknown> = { ...restore }; delete value[field];
    assert.equal(restoreStartRequestSchema.safeParse(value).success, false);
  }
});

const source = { service: "web", kind: "project", source: "data", target: "/data", readOnly: false, shared: false,
  sourceId: "data", estimatedBytes: 42, readable: true, writable: true, writeBlocker: null, backupEligible: true,
  restoreEligible: true, protection: "none", ownership: "exclusive" };
test("file sources carry the existing class and action-specific capabilities", () => {
  assert.deepEqual(fileSourceSchema.parse(source), source);
  for (const kind of ["project", "external", "volume"]) assert.equal(fileSourceSchema.safeParse({ ...source, kind }).success, true);
  const shared = { ...source, shared: true, ownership: "shared", writable: false, restoreEligible: false, writeBlocker: "source-shared" };
  assert.equal(fileSourceSchema.safeParse(shared).success, true);
  assert.equal(fileSourceSchema.safeParse({ ...shared, writable: true }).success, false);
  assert.equal(fileSourceSchema.safeParse({ ...shared, restoreEligible: true }).success, false);
  for (const protection of ["system", "agent", "unknown"]) {
    assert.equal(fileSourceSchema.safeParse({ ...source, protection }).success, false);
    assert.equal(fileSourceSchema.safeParse({ ...source, protection, writable: false, backupEligible: false, restoreEligible: false }).success, true);
  }
});
test("source text writing retains mandatory hash and the existing conflict key and byte limit", () => {
  const write = { sourceId: "data", path: "settings.txt", content: "a".repeat(MAX_TEXT_BYTES), expectedHash: "hash" };
  assert.equal(sourceFileTextWriteRequestSchema.safeParse(write).success, true);
  assert.equal(sourceFileTextWriteRequestSchema.safeParse({ ...write, content: `${write.content}a` }).success, false);
  assert.equal(sourceFileTextWriteRequestSchema.safeParse({ ...write, content: "ä".repeat(MAX_TEXT_BYTES / 2 + 1) }).success, false);
  assert.equal(sourceFileTextWriteRequestSchema.safeParse({ ...write, expectedHash: "" }).success, false);
  assert.deepEqual(fileContentConflictSchema.parse({ error: "file-changed-externally", hash: "current" }),
    { error: "file-changed-externally", hash: "current" });
});
