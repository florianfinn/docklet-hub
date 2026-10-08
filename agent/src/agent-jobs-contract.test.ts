import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as contract from "contract";
import {
  restorePhaseSchema, restoreStartResponseSchema, updateStartResponseSchema,
  restoreProgressSchema, restoreJobResponseSchema, agentJobProgressSchema,
  agentJobsQuerySchema, agentJobsResponseSchema, AGENT_JOB_RESULT_RETENTION_MS,
  RESTORE_CANCEL_BOUNDARY, UPDATE_PREVIEW_TIMEOUT_MS, UPDATE_PREVIEW_MANIFEST_MODE,
  updatePreviewResponseSchema, updateServicePreviewSchema, updateResultSchema,
  updateServiceResultSchema, restoreResultSchema, fileSourceSchema, fileSourcesResponseSchema,
  backupOptionsSchema, backupListResponseSchema, restorePreviewResponseSchema
} from "contract";

const target = { kind: "container", containerName: "demo" } as const;
const expectedContainer = { containerId: "original", status: "running", startedAt: "observed" };
const state = { ...expectedContainer, health: "healthy", exitCode: 0 };
const source = { sourceId: "data", service: "", kind: "volume", source: "demo-data", target: "/data",
  readOnly: false, shared: false, readable: true, writable: true, writeBlocker: null,
  estimatedBytes: 42, backupEligible: true, restoreEligible: true, protection: "none", ownership: "exclusive" };
const mount = { sourceId: "data", estimatedBytes: 42 };
const backup = { backupId: "backup", target, completedAt: "2026-10-08T00:00:00Z", mode: "stop",
  archives: [{ sourceId: "data", mountTarget: "/data", archiveId: "archive", bytes: 42 }] };
const previewService = { target, expectedContainer, startDeadlineSeconds: 120, backup: { mode: "stop", mounts: [mount] },
  imageRef: "demo:1.0.0", currentDigest: null, offeredDigest: null, rollbackImageId: "old", definitionHash: "definition",
  acceptance: "service", initialState: state, mounts: [source], warnings: [], blocker: null };
const serviceResult = { target, outcome: "updated", state, imageId: "new", definitionHash: "definition", backupId: null,
  updateError: null, rollbackError: null, resumeError: null };
const updateResult = { target, outcome: "updated", services: [serviceResult], updateError: null, rollbackError: null };
const restoreResult = { target, backupId: "backup", ok: true, outcome: "restored", state, restoreError: null, resumeError: null };
const common = { jobId: "job", phaseStartedAt: "2026-10-08T00:00:00Z", phaseDeadlineAt: "2026-10-08T01:00:00Z",
  completedAt: null, cancelAllowed: true };
const restoreProgress = { ...common, kind: "restore", target, phase: "queued", extractStarted: false, result: null };
const updateProgress = { ...common, kind: "update", target, phase: "queued", service: null, firstExchangeStarted: false, result: null };

// R1: long operations expose job IDs and polling, with no independent backup start.
test("restore jobs expose only IDs at start and all five phases through polling", () => {
  assert.deepEqual(restorePhaseSchema.options, ["queued", "stop", "extract", "resume", "completed"]);
  assert.equal(RESTORE_CANCEL_BOUNDARY, "before-extract");
  assert.equal("backupStartRequestSchema" in contract, false);
  for (const schema of [restoreStartResponseSchema, updateStartResponseSchema]) {
    assert.deepEqual(schema.parse({ jobId: "job" }), { jobId: "job" });
    assert.equal(schema.safeParse({ jobId: "job", result: restoreResult }).success, false);
    assert.equal(schema.safeParse({ result: restoreResult }).success, false);
  }
  for (const phase of ["queued", "stop", "extract", "resume", "completed"]) {
    const progress = { ...restoreProgress, phase, cancelAllowed: false, extractStarted: ["extract", "resume", "completed"].includes(phase),
      completedAt: phase === "completed" ? "2026-10-08T00:10:00Z" : null, result: phase === "completed" ? restoreResult : null };
    assert.deepEqual(restoreJobResponseSchema.parse({ progress }), { progress });
    assert.deepEqual(agentJobProgressSchema.parse(progress), progress);
  }
  assert.ok(contract.restorePhaseTimeoutMs(1800) > 760_000);
  assert.ok(contract.updateRunBudgetMs([{ startDeadlineSeconds: 1800, backup: true }]) > 760_000);
});

test("restore cancellation stops before extract even during later resume", () => {
  for (const phase of ["queued", "stop"]) assert.equal(restoreProgressSchema.safeParse({ ...restoreProgress, phase }).success, true);
  for (const phase of ["extract", "resume", "completed"]) {
    assert.equal(restoreProgressSchema.safeParse({ ...restoreProgress, phase }).success, false);
  }
  assert.equal(restoreProgressSchema.safeParse({ ...restoreProgress, phase: "stop", extractStarted: true }).success, false);
  assert.equal(restoreProgressSchema.safeParse({ ...restoreProgress, phase: "extract", cancelAllowed: false }).success, false);
  assert.equal(restoreProgressSchema.safeParse({ ...restoreProgress, phase: "resume", cancelAllowed: false, extractStarted: true }).success, true);
});

test("both job kinds put results exclusively into completed progress", () => {
  for (const [progress, result] of [[updateProgress, updateResult], [restoreProgress, restoreResult]]) {
    assert.equal(agentJobProgressSchema.safeParse(progress).success, true);
    assert.equal(agentJobProgressSchema.safeParse({ ...progress, result }).success, false);
    assert.equal(agentJobProgressSchema.safeParse({ ...progress, completedAt: "2026-10-08T00:10:00Z" }).success, false);
    const completed = { ...progress, phase: "completed", cancelAllowed: false, completedAt: "2026-10-08T00:10:00Z", result };
    assert.equal(agentJobProgressSchema.safeParse(completed).success, true);
    assert.equal(agentJobProgressSchema.safeParse({ ...completed, result: null }).success, false);
    assert.equal(agentJobProgressSchema.safeParse({ ...completed, completedAt: null }).success, false);
    assert.equal(agentJobProgressSchema.safeParse({ ...completed, cancelAllowed: true }).success, false);
  }
});

// R2: unknown sizes remain distinct from zero, including chosen backup mounts.
test("size estimates are present on preview sources and backup selections", () => {
  for (const estimatedBytes of [0, 42, null]) {
    const value = { ...source, estimatedBytes };
    assert.deepEqual(fileSourceSchema.parse(value), value);
    const selection = { mode: "stop", mounts: [{ ...mount, estimatedBytes }] };
    assert.deepEqual(backupOptionsSchema.parse(selection), selection);
    const preview = { previewId: "preview", target, digestSource: "registry-manifest",
      services: [{ ...previewService, mounts: [value], backup: selection }] };
    assert.deepEqual(updatePreviewResponseSchema.parse(preview), preview);
  }
  const { estimatedBytes: omitted, ...missing } = source;
  assert.equal(omitted, 42);
  assert.equal(fileSourceSchema.safeParse(missing).success, false);
  assert.equal(backupOptionsSchema.safeParse({ mode: "stop", mounts: [{ sourceId: "data" }] }).success, false);
  for (const estimatedBytes of [-1, 0.5, Infinity, "42"]) {
    assert.equal(fileSourceSchema.safeParse({ ...source, estimatedBytes }).success, false);
    assert.equal(backupOptionsSchema.safeParse({ mode: "stop", mounts: [{ ...mount, estimatedBytes }] }).success, false);
  }
});

test("restore preview carries the selected backup run, archive bytes and affected targets", () => {
  const preview = { target, backupId: "backup", mounts: [{ sourceId: "data" }], previewId: "preview",
    expectedContainer, backup, targets: [source], warnings: ["data-overwrite"] };
  assert.deepEqual(restorePreviewResponseSchema.parse(preview), preview);
  assert.deepEqual(backupListResponseSchema.parse({ target, backups: [backup] }), { target, backups: [backup] });
  for (const field of ["backup", "targets"]) {
    const value: Record<string, unknown> = { ...preview }; delete value[field];
    assert.equal(restorePreviewResponseSchema.safeParse(value).success, false);
  }
  for (const field of ["completedAt", "mode", "archives"]) {
    const value: Record<string, unknown> = { ...backup }; delete value[field];
    assert.equal(restorePreviewResponseSchema.safeParse({ ...preview, backup: value }).success, false);
    assert.equal(backupListResponseSchema.safeParse({ target, backups: [value] }).success, false);
  }
  for (const bytes of [-1, null, "42"]) {
    const value = { ...backup, archives: [{ ...backup.archives[0], bytes }] };
    assert.equal(restorePreviewResponseSchema.safeParse({ ...preview, backup: value }).success, false);
    assert.equal(backupListResponseSchema.safeParse({ target, backups: [value] }).success, false);
  }
  assert.equal(restorePreviewResponseSchema.safeParse({ ...preview, backupId: "other" }).success, false);
  assert.equal(restorePreviewResponseSchema.safeParse({ ...preview, targets: [] }).success, false);
  assert.equal(restorePreviewResponseSchema.safeParse({ ...preview, mounts: [{ sourceId: "other" }] }).success, false);
  assert.equal(restorePreviewResponseSchema.safeParse({ ...preview, targets: [{ ...source, restoreEligible: false }] }).success, false);
});

// R3: every free-form diagnostic field in these surfaces is an enumerated key.
test("source blockers accept known keys and reject unknown keys", () => {
  for (const writeBlocker of ["source-read-only", "agent-read-only", "not-allowlisted", "externally-managed"]) {
    assert.equal(fileSourceSchema.safeParse({ ...source, writeBlocker }).success, true);
  }
  assert.equal(fileSourceSchema.safeParse({ ...source, writeBlocker: "not-a-contract-key" }).success, false);
});
test("update blockers and every result error field reject unknown keys", () => {
  assert.equal(updateServicePreviewSchema.safeParse({ ...previewService, blocker: "local-image-no-registry-digest" }).success, true);
  assert.equal(updateServicePreviewSchema.safeParse({ ...previewService, blocker: "not-a-contract-key" }).success, false);
  for (const field of ["updateError", "rollbackError", "resumeError"]) {
    assert.equal(updateServiceResultSchema.safeParse({ ...serviceResult, [field]: "not-a-contract-key" }).success, false);
  }
  for (const field of ["updateError", "rollbackError"]) {
    assert.equal(updateResultSchema.safeParse({ ...updateResult, [field]: "not-a-contract-key" }).success, false);
  }
  for (const field of ["restoreError", "resumeError"]) {
    assert.equal(restoreResultSchema.safeParse({ ...restoreResult, [field]: "not-a-contract-key" }).success, false);
  }
  assert.equal(updateServiceResultSchema.safeParse({ ...serviceResult, updateError: "backup-size-unavailable" }).success, true);
});

test("local images without registry digests are blockers rather than warnings", () => {
  assert.equal(updateServicePreviewSchema.safeParse({ ...previewService, blocker: "local-image-no-registry-digest" }).success, true);
  assert.equal(updateServicePreviewSchema.safeParse({ ...previewService, warnings: ["local-image-no-registry-digest"] }).success, false);
  for (const warning of ["unhealthy", "restarting", "paused"]) {
    assert.equal(updateServicePreviewSchema.safeParse({ ...previewService, warnings: [warning] }).success, true);
  }
});

test("manifest previews have a parallel 60-second overall budget", () => {
  assert.equal(UPDATE_PREVIEW_TIMEOUT_MS, 60_000);
  assert.equal(UPDATE_PREVIEW_MANIFEST_MODE, "parallel");
  assert.ok(UPDATE_PREVIEW_TIMEOUT_MS < 760_000);
  assert.equal(contract.AGENT_JOB_RESULT_RETENTION_MS, 86_400_000);
  const sourceText = readFileSync(new URL("../../contract/src/agent/update-deadlines.ts", import.meta.url), "utf8");
  assert.equal(sourceText.includes("HUB_RUNTIME_TIMEOUT_MS"), false);
});

test("job rediscovery works for a host or stable target with 24-hour result retention", () => {
  assert.equal(AGENT_JOB_RESULT_RETENTION_MS, 86_400_000);
  assert.deepEqual(agentJobsQuerySchema.parse({}), {});
  assert.deepEqual(agentJobsQuerySchema.parse({ target, kind: "restore" }), { target, kind: "restore" });
  assert.equal(agentJobsQuerySchema.safeParse({ kind: "backup" }).success, false);
  const completed = { ...restoreProgress, jobId: "finished", phase: "completed", cancelAllowed: false,
    completedAt: "2026-10-08T00:10:00Z", result: restoreResult };
  const jobs = { active: [updateProgress, { ...restoreProgress, jobId: "restore" }], recent: [completed] };
  assert.deepEqual(agentJobsResponseSchema.parse(jobs), jobs);
  assert.equal(agentJobsResponseSchema.safeParse({ active: [completed], recent: [] }).success, false);
  assert.equal(agentJobsResponseSchema.safeParse({ active: [], recent: [restoreProgress] }).success, false);
  assert.equal(agentJobsResponseSchema.safeParse({ active: [updateProgress, restoreProgress], recent: [] }).success, false);
  assert.equal(agentJobsResponseSchema.safeParse({ active: [], recent: [{ ...completed, kind: "backup" }] }).success, false);
});

test("bundled backups use the persistent data volume without an unused root override", () => {
  const rootEnv = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const config = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  assert.equal(rootEnv.includes("DOCKER_AGENT_BACKUP_DIR"), false);
  const agentBlock = compose.slice(compose.indexOf("\n  docker-agent:"), compose.indexOf("\n  watcher:"));
  assert.match(agentBlock, /DOCKER_AGENT_REGISTRY_FILE: \/state\/registry\.json/);
  assert.match(agentBlock, /- docker-agent-state:\/state/);
  assert.equal(agentBlock.includes("DOCKER_AGENT_BACKUP_DIR"), false);
  assert.match(config, /registryFile: env\.DOCKER_AGENT_REGISTRY_FILE \?\? "\/state\/registry\.json"/);
  assert.equal(contract.BACKUP_DIRECTORY_DEFAULT, "backups");
  for (const name of ["unraid", "remote-wireguard"]) {
    const env = readFileSync(new URL(`../deploy/${name}/.env.example`, import.meta.url), "utf8");
    assert.match(env, /^DOCKER_AGENT_BACKUP_DIR=$/m);
    assert.equal(env.includes("Contract setting; consumed"), false);
  }
});

test("backup directories cannot appear as readable sources", () => {
  const protectedSource = { ...source, protection: "backup", writable: false,
    backupEligible: false, restoreEligible: false, writeBlocker: "backup-directory-protected" };
  assert.equal(fileSourceSchema.safeParse(protectedSource).success, false);
  assert.equal(fileSourcesResponseSchema.safeParse({ sources: [protectedSource] }).success, false);
  assert.equal(fileSourceSchema.safeParse({ ...protectedSource, readable: false }).success, true);
});
