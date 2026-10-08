import { type RestorePreviewRequest, type RestoreResult } from "contract";
import { StackEndpointError } from "../stack-control.js";
import { RestoreRunner, type RestoreSnapshot } from "../restore-runner.js";
import { UpdateBudget, UpdateFailure } from "../update-budget.js";
import { agentJobs, updateCompose, authorizeUpdateSelection } from "./updates.js";
import { dataJournal, backupStore, backupSources, restoreArchives, stopForData, resumeAfterData, dataIntent } from "./backups.js";
import { containerIdsForTarget } from "../routes/contract-route-stubs.js";
import { engine, stackLocks, audit } from "./state.js";
import { runtimeStateOf } from "../runtime-actions.js";
import { appendRecoveryIncident } from "../update-recovery.js";
import { selfHealingState, dockerEvents } from "./state.js";

async function prepare(request: RestorePreviewRequest, actor: string | null, budget: UpdateBudget): Promise<RestoreSnapshot> {
  const ids = containerIdsForTarget(request.target);
  if (ids.length === 0) throw new StackEndpointError(404, "not-allowlisted");
  if (ids.length !== 1) throw new UpdateFailure(ids.length > 1 ? "scaled-service-unsupported" : "backup-target-mismatch");
  const raw = await budget.run((options) => engine.inspect(ids[0], options));
  const state = runtimeStateOf(raw);
  const expectedContainer = { containerId: raw.Id, status: state.status, startedAt: state.startedAt };
  await authorizeUpdateSelection({ target: request.target, expectedContainer, startDeadlineSeconds: 120, backup: null }, actor, budget);
  if (raw.Config?.Labels?.["com.docker.compose.oneoff"]?.toLowerCase() === "true") throw new UpdateFailure("source-protected");
  if (request.target.kind === "compose") {
    const target = request.target;
    const matches = (await budget.run((options) => engine.listWithComposeLabels(options))).filter((container) =>
      container.labels["com.docker.compose.project"] === target.projectName && container.labels["com.docker.compose.service"] === target.serviceName);
    if (matches.length !== 1) throw new UpdateFailure("scaled-service-unsupported");
  }
  const backup = (await backupStore.list(request.target)).find((entry) => entry.backupId === request.backupId);
  if (!backup) throw new UpdateFailure("backup-unknown");
  const sources = await backupSources(raw.Id, actor, budget);
  if (request.target.kind === "compose") {
    if (!sources.context) throw new UpdateFailure("backup-target-mismatch");
    const context = sources.context;
    const definition = await budget.run((options) => updateCompose.config({ projectDir: context.projectDir,
      composeFileName: context.composeFileName, projectName: context.project }, options)) as { services?: Record<string, { scale?: number; deploy?: { replicas?: number } }> };
    const service = definition.services?.[request.target.serviceName];
    if (!service) throw new UpdateFailure("backup-target-mismatch");
    if (Number(service.scale ?? service.deploy?.replicas ?? 1) > 1) throw new UpdateFailure("scaled-service-unsupported");
  }
  const targets = request.mounts.map((mount) => {
    const source = sources.resolved.find((item) => item.source.sourceId === mount.sourceId)?.source;
    if (!source || !source.restoreEligible) throw new UpdateFailure(source?.writeBlocker === "source-shared" ? "source-shared" : "source-ownership-unknown");
    const archive = backup.archives.find((entry) => entry.sourceId === mount.sourceId);
    if (!archive || archive.mountTarget !== source.target) throw new UpdateFailure("backup-mount-mismatch");
    return source;
  });
  return { raw, data: sources, preview: { ...request, previewId: "pending", expectedContainer, backup, targets,
    warnings: ["data-overwrite", "database-consistency-not-guaranteed"] } };
}
function archives(snapshot: RestoreSnapshot, budget: UpdateBudget, validateOnly: boolean) {
  return restoreArchives(snapshot.data as Awaited<ReturnType<typeof backupSources>>, snapshot.preview.target,
    snapshot.preview.backupId, snapshot.preview.mounts, budget, validateOnly);
}
function finished(result: RestoreResult, actor: string | null) {
  audit.write({ action: "restore", actor, containerId: result.state.containerId, containerName: null,
    outcome: result.ok ? "allowed" : "error", reason: result.restoreError ?? result.resumeError ?? result.outcome });
  if (result.resumeError) {
    appendRecoveryIncident(selfHealingState, result.target, result.state.containerId ?? "unresolved", `restore-resume-failed: ${result.resumeError}`);
    dockerEvents.notifyLifecycleChange(result.state.containerId ?? "unresolved");
  }
}
export const restoreRunner = new RestoreRunner(agentJobs, stackLocks, {
  prepare, validate: (snapshot, budget) => archives(snapshot, budget, true),
  async stop(snapshot, budget) {
    dataJournal.begin(snapshot.preview.target, snapshot.raw, "restore"); await stopForData(snapshot.raw, budget);
  },
  async extract(snapshot, budget) { dataJournal.extracting(snapshot.preview.target); await archives(snapshot, budget, false); },
  async resume(snapshot, budget) {
    const raw = await resumeAfterData(snapshot.raw, budget); dataJournal.complete(snapshot.preview.target); return raw;
  },
  read: (snapshot, budget) => budget.run((options) => engine.inspect(snapshot.raw.Id, options)),
  intentional: (snapshot) => dataIntent(snapshot.raw), finished
});
