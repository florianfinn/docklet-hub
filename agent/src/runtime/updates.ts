import { backupStore, dataJournal, backupSources, copyBackup, stopForData, resumeAfterData } from "./backups.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { updateAcceptance, UPDATE_STOP_TIMEOUT_MS, UPDATE_CREATE_TIMEOUT_MS, UPDATE_READBACK_TIMEOUT_MS,
  SELF_HEALING_RECOMMENDATION, updateDigestSchema, type UpdateServiceSelection, type UpdateResult } from "contract";
import { updateJournal, updateRecovery } from "./update-recovery.js";
export { updateJournal } from "./update-recovery.js";
import { AgentJobs } from "../agent-jobs.js";
import { UpdateRunner, type UpdateSnapshot, type UpdateOps } from "../update-runner.js";
import { UpdateBudget, UpdateFailure } from "../update-budget.js";
import { verifyUpdate, rollbackStateMatches, verifyRollback } from "../update-verification.js";
import { buildCreatePayload } from "../recreate.js";
import { composeConfig, composeUp, type ComposeProject } from "../compose-cli.js";
import { parseImageRef } from "../image-ref.js";
import { carriesSecret } from "../own-container-id.js";
import { localManifestDigest } from "../update.js";
import { runtimeStateOf } from "../runtime-actions.js";
import { stopIntentTarget } from "../stop-intent.js";
import { foreignManagementOf } from "../external-management.js";
import { forcedManagement } from "../stacks.js";
import { gate } from "./gate.js";
import { composeContextFor, composeBasePath } from "./containers.js";
import { config, engine, registry, stackLocks, stopIntents, audit, selfHealingState, dockerEvents } from "./state.js";
import { containerIdsForTarget } from "../routes/contract-route-stubs.js";
import { StackEndpointError } from "../stack-control.js";
import type { RawInspect } from "../engine.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rollbackTags = new Map<string, string>();
const sameTarget = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Definition = { project: ComposeProject | null; normalized: { services: Record<string, Record<string, unknown>> } | null; currentId: string; parkedId?: string; actor: string | null };
export const updateCompose = { config: composeConfig, up: composeUp };
export const agentJobs = new AgentJobs((target) => {
  const ids = containerIdsForTarget(target);
  return ids.length === 1 && (target.kind === "compose" || !registry.get(ids[0])?.compose);
});

export async function authorizeUpdateSelection(selection: UpdateServiceSelection, actor: string | null, budget: UpdateBudget) {
  if (updateRecovery.blocks(selection.target)) throw new UpdateFailure("state-changed");
  const id = selection.expectedContainer.containerId;
  const entry = registry.get(id);
  // Stable identity is checked independently of allowlist permission (R8).
  if (entry && !containerIdsForTarget(selection.target).includes(id)) throw new UpdateFailure("state-changed");
  const result = await budget.run(() => gate(id, { action: "update", mutating: true, actor, onDelegation: () => {}, budget }));
  if (!result.ok) throw new StackEndpointError(result.status, result.reason.split(":")[0]);
  if ((selection.target.kind === "container" && entry?.compose) || !sameTarget(stopIntentTarget(result.inspect), selection.target)) throw new UpdateFailure("state-changed");
  const projectName = entry?.compose?.projectName ?? result.inspect.Config?.Labels?.["com.docker.compose.project"];
  const repo = (entry?.imageRef ?? result.inspect.Config?.Image ?? "").split("@")[0].split("/").at(-1)?.split(":")[0];
  if (repo === "docklet-hub" || repo === "docklet-hub-agent" || projectName === "docklet-hub"
    || projectName === "docklet-hub-agent" || projectName?.startsWith("docklet-hub-agent-")
    || carriesSecret(result.inspect.Config?.Env ?? [], config.sharedSecret)) throw new StackEndpointError(403, "self-management-locked");
  const state = runtimeStateOf(result.inspect);
  if (state.containerId !== id || state.status !== selection.expectedContainer.status
    || state.startedAt !== selection.expectedContainer.startedAt) throw new UpdateFailure("state-changed");
  return result.inspect;
}
async function prepare(selection: UpdateServiceSelection, actor: string | null, budget: UpdateBudget): Promise<UpdateSnapshot> {
  const raw = await authorizeUpdateSelection(selection, actor, budget);
  const entry = registry.get(raw.Id)!;
  const imageRef = registry.expectedImageRef(raw.Id) ?? raw.Config?.Image ?? "";
  const image = await budget.run((options) => engine.inspectImage(raw.Image ?? "", options));
  const currentDigest = localManifestDigest(image?.RepoDigests, imageRef);
  const context = composeContextFor(entry.containerName, raw.Config?.Labels ?? undefined);
  let project: ComposeProject | null = null;
  let normalized: Definition["normalized"] = null;
  let dependencies: string[] = [];
  let scaled = false;
  let completion = false; let restart: string | null = null;
  if (selection.target.kind === "compose") {
    if (!context || context.project !== selection.target.projectName || context.serviceName !== selection.target.serviceName
      || context.projectDir !== entry.compose?.projectDir || context.composeFileName !== entry.compose?.composeFileName) {
      throw new UpdateFailure("state-changed");
    }
    const matches = (await budget.run((options) => engine.listWithComposeLabels(options))).filter((container) =>
      container.labels["com.docker.compose.project"] === context.project && container.labels["com.docker.compose.service"] === context.serviceName);
    if (matches.length === 0) throw new UpdateFailure("state-changed");
    scaled = matches.length > 1;
    if (forcedManagement(context.projectDir) === "read-only") throw new StackEndpointError(403, "self-management-locked");
    const relative = path.relative(fs.realpathSync(composeBasePath), fs.realpathSync(context.projectDir));
    if (fs.lstatSync(context.projectDir).isSymbolicLink() || relative.startsWith("..") || path.isAbsolute(relative)) throw new UpdateFailure("state-changed");
    project = { projectDir: context.projectDir, composeFileName: context.composeFileName, projectName: context.project };
    normalized = await budget.run((options) => updateCompose.config(project!, options)) as Definition["normalized"];
    const service = normalized?.services?.[context.serviceName];
    if (!service || service.image !== imageRef) throw new UpdateFailure("state-changed");
    if (Number(service.scale ?? (service.deploy as { replicas?: number } | undefined)?.replicas ?? 1) > 1) {
      scaled = true;
    }
    restart = typeof service.restart === "string" ? service.restart : null;
    const depends = service.depends_on;
    dependencies = Array.isArray(depends) ? depends : depends && typeof depends === "object" ? Object.keys(depends) : [];
    for (const field of ["network_mode", "ipc", "pid"]) {
      const value = service[field]; if (typeof value === "string" && value.startsWith("service:")) dependencies.push(value.slice(8));
    }
    for (const field of ["links", "volumes_from"]) {
      const value = service[field]; if (Array.isArray(value)) dependencies.push(...value.filter((v) => typeof v === "string").map((v: string) => v.split(":")[0]));
    }
    completion = Object.values(normalized!.services).some((other) =>
      (other.depends_on as Record<string, { condition?: string }> | undefined)?.[context.serviceName]?.condition === "service_completed_successfully");
  } else if (context || entry.compose) throw new UpdateFailure("state-changed");
  if (foreignManagementOf(raw.Config?.Labels ?? {}, image ? image.Config?.Labels?.["net.unraid.docker.managed"] ?? null : undefined) !== null) {
    throw new StackEndpointError(403, "externally-managed");
  }
  const initialState = runtimeStateOf(raw);
  const warnings: UpdateSnapshot["preview"]["warnings"] = ["rollback-does-not-restore-data"];
  if (initialState.health === "unhealthy") warnings.push("unhealthy");
  if (initialState.status === "paused" || initialState.status === "restarting") warnings.push(initialState.status);
  const blocker = scaled ? "scaled-service-unsupported" : raw.Config?.Labels?.["com.docker.compose.oneoff"]?.toLowerCase() === "true" ? "oneoff-unsupported"
    : !currentDigest ? "local-image-no-registry-digest"
      : !image?.Id || image.Id !== raw.Image ? "update-rollback-unavailable" : null;
  const sources = raw.Mounts?.length ? await backupSources(raw.Id, actor, budget) : null;
  let backupBlocker = null;
  if (selection.backup) {
    for (const selected of selection.backup.mounts) {
      const source = sources?.resolved.find((item) => item.source.sourceId === selected.sourceId)?.source;
      if (!source?.backupEligible) backupBlocker = "source-protected" as const;

    }
    if (selection.backup.mode === "live") warnings.push("live-backup-inconsistent");
    if (selection.backup.mounts.some((mount) => sources?.resolved.some((item) => item.source.sourceId === mount.sourceId && item.source.shared))) warnings.push("shared-source-writers");
  }
  return { raw: structuredClone(raw), dependencies, definition: { project, normalized, currentId: raw.Id, actor } satisfies Definition,
    preview: { ...selection, imageRef, currentDigest, offeredDigest: null, rollbackImageId: raw.Image ?? null,
      definitionHash: hash(normalized ?? buildCreatePayload(raw, { imageRef })), initialState, warnings, blocker: blocker ?? backupBlocker, mounts: sources?.resolved.map((item) => item.source) ?? [],
      acceptance: updateAcceptance(initialState.status, completion, restart, selection.target.kind) } };
}
async function read(snapshot: UpdateSnapshot, budget: UpdateBudget): Promise<RawInspect> {
  const definition = snapshot.definition as Definition;
  if (definition.project) {
    const target = snapshot.preview.target as { projectName: string; serviceName: string };
    const matches = (await budget.run((options) => engine.listWithComposeLabels(options))).filter((container) =>
      container.labels["com.docker.compose.project"] === target.projectName && container.labels["com.docker.compose.service"] === target.serviceName
      && container.labels["com.docker.compose.project.working_dir"] === snapshot.raw.Config?.Labels?.["com.docker.compose.project.working_dir"]);
    if (matches.length !== 1) throw new UpdateFailure("update-state-mismatch");
    definition.currentId = matches[0].id;
  }
  const raw = await budget.run((options) => engine.inspect(definition.currentId, options), UPDATE_READBACK_TIMEOUT_MS);
  if (raw.Name !== snapshot.raw.Name || !sameTarget(stopIntentTarget(raw), snapshot.preview.target)) throw new UpdateFailure("update-state-mismatch");
  const original = snapshot.raw.Id;
  if (raw.Id !== original && registry.get(original)) {
    if (!registry.replaceContainerId(original, raw.Id)) throw new UpdateFailure("update-state-mismatch");
  } else if (!registry.get(raw.Id)) {
    const known = containerIdsForTarget(snapshot.preview.target);
    if (known.length === 1 && !registry.replaceContainerId(known[0], raw.Id)) throw new UpdateFailure("update-state-mismatch");
  }
  return raw;
}
async function mutate(snapshot: UpdateSnapshot, imageId: string, budget: UpdateBudget, rollback: boolean): Promise<number> {
  const definition = snapshot.definition as Definition;
  const wasRunning = snapshot.preview.acceptance !== "created";
  if (definition.project) {
    const target = snapshot.preview.target as { serviceName: string };
    let startedAt = Date.now();
    await budget.run((options) => updateCompose.up(definition.project!, {
      ...options, removeOrphans: false, serviceName: target.serviceName, pullNever: true, noDeps: true,
      forceRecreate: true, wait: false, noStart: true
    }), UPDATE_STOP_TIMEOUT_MS + UPDATE_CREATE_TIMEOUT_MS);
    const created = await read(snapshot, budget);
    if (created.Image !== imageId) throw new UpdateFailure(rollback ? "update-rollback-failed" : "update-state-mismatch");
    if (wasRunning) {
      startedAt = Date.now(); await budget.run((options) => engine.start(created.Id, options), UPDATE_CREATE_TIMEOUT_MS);
    }
    return startedAt;
  }
  const previousParkedId = definition.parkedId;
  let current: RawInspect;
  try { current = await read(snapshot, budget); }
  catch { current = snapshot.raw; }
  if (runtimeStateOf(current).status === "paused") await budget.run((options) => engine.pause(current.Id, false, options));
  if (current.State?.Running) await budget.run((options) => engine.stop(current.Id, current.Config?.StopTimeout, options), UPDATE_STOP_TIMEOUT_MS);
  const name = snapshot.raw.Name.replace(/^\//, "");
  const parked = `${name}-update-${randomUUID()}`;
  await budget.run((options) => engine.rename(current.Id, parked, options), UPDATE_CREATE_TIMEOUT_MS);
  definition.parkedId = current.Id;
  const payload = buildCreatePayload(snapshot.raw, { imageRef: snapshot.preview.imageRef });
  try {
    const id = await budget.run((options) => engine.create(name, payload.config, options), UPDATE_CREATE_TIMEOUT_MS);
    definition.currentId = id;
    const created = await budget.run((options) => engine.inspect(id, options));
    if (created.Image !== imageId) throw new UpdateFailure(rollback ? "update-rollback-failed" : "update-state-mismatch");
    for (const network of payload.additionalNetworks) await budget.run((options) => engine.connectNetwork(network.name, id, network.endpoint, options));
    if (!registry.replaceContainerId(current.Id, id)) throw new UpdateFailure("update-state-mismatch");
    const startedAt = Date.now();
    if (wasRunning) await budget.run((options) => engine.start(id, options), UPDATE_CREATE_TIMEOUT_MS);
    await budget.run((options) => engine.remove(current.Id, { force: true, ...options }), UPDATE_CREATE_TIMEOUT_MS);
    if (previousParkedId && previousParkedId !== current.Id) await budget.run((options) => engine.remove(previousParkedId, { force: true, ...options }), UPDATE_CREATE_TIMEOUT_MS);
    definition.parkedId = undefined;
    return startedAt;
  } catch (error) {
    // Keep the captured definition usable even when creation or start failed.
    if (definition.currentId === current.Id) {
      await budget.run((options) => engine.rename(current.Id, name, options), UPDATE_CREATE_TIMEOUT_MS);
      definition.parkedId = undefined;
    }
    if (rollback) throw new UpdateFailure("update-rollback-failed");
    throw error;
  }
}
function finished(result: UpdateResult, actor: string | null): void {
  audit.write({ action: "update", containerId: result.services[0]?.state.containerId ?? null, containerName: null, actor,
    outcome: result.updateError ? "error" : "allowed", reason: result.rollbackError ?? result.updateError ?? result.outcome });
  const at = new Date().toISOString();
  for (const service of result.services.filter((s) => s.rollbackError)) {
    selfHealingState.change((state) => {
      const tag = rollbackTags.get(JSON.stringify(service.target));
      const message = [service.updateError, tag].filter(Boolean).join("; ");
      const existing = state.incidents.find((incident) => sameTarget(incident.target, service.target) && incident.closedAt === null);
      if (existing) {
        if (message && !existing.cause.engineError?.includes(message)) existing.cause.engineError = [existing.cause.engineError, message].filter(Boolean).join("; ");
        return;
      }
      state.incidents.push({ id: randomUUID(), target: service.target, containerId: service.state.containerId ?? "unresolved",
        openedAt: at, closedAt: null, closedReason: null, cause: { exitCode: service.state.exitCode ?? 0, engineError: message || null },
        attempts: [{ attempt: 1, startedAt: at, finishedAt: at, result: "failed", error: service.rollbackError }],
        recommendation: SELF_HEALING_RECOMMENDATION, logs: { available: false, reason: "logs-unavailable" } });
    });
    if (service.state.containerId) dockerEvents.notifyLifecycleChange(service.state.containerId);
  }
  if (result.services.some((service) => service.resumeError)) updateRecovery.start();
  for (const service of result.services) rollbackTags.delete(JSON.stringify(service.target));
}
export const updateRuntimeOps: UpdateOps = {
  prepare,
  manifest: (snapshot, budget) => budget.run(async (options) => {
    const value = await engine.remoteManifestDigest(snapshot.preview.imageRef, undefined, options);
    return updateDigestSchema.safeParse(value).success ? value : null;
  }),
  async estimateBackup(snapshot, budget) {
    if (!snapshot.preview.backup) return;
    const sources = await backupSources(snapshot.raw.Id, (snapshot.definition as Definition).actor, budget,
      snapshot.preview.backup.mounts.map((mount) => mount.sourceId));
    snapshot.preview.mounts = sources.resolved.map((item) => item.source);
  },
  async pull(snapshot, budget) {
    const parsed = parseImageRef(snapshot.preview.imageRef); if (!parsed) throw new UpdateFailure("update-pull-failed");
    await budget.run((options) => engine.pull(parsed, undefined, options.signal));
    const image = await budget.run((options) => engine.inspectImage(parsed.fullRef, options));
    if (!image?.Id) throw new UpdateFailure("update-pull-failed");
    return { imageId: image.Id, digest: localManifestDigest(image.RepoDigests, parsed.fullRef) };
  },
  async backup(snapshot, budget, cancelled) {
    const sources = await backupSources(snapshot.raw.Id, (snapshot.definition as Definition).actor, budget, snapshot.preview.backup!.mounts.map((mount) => mount.sourceId));
    const options = structuredClone(snapshot.preview.backup!);
    for (const selected of options.mounts) {
      const source = sources?.resolved.find((item) => item.source.sourceId === selected.sourceId)?.source;
      if (!source?.backupEligible) throw new UpdateFailure("source-protected");
      selected.estimatedBytes = source.estimatedBytes;
    }
    await backupStore.checkSpace(snapshot.preview.target, options);
    if (snapshot.preview.backup!.mode === "stop") {
      dataJournal.begin(snapshot.preview.target, snapshot.raw, "backup");
      await stopForData(snapshot.raw, budget);
    }
    return (await copyBackup(snapshot.raw, snapshot.preview.target, options,
      (snapshot.definition as Definition).actor, budget, cancelled, sources)).backupId;
  },
  async resume(snapshot, budget) {
    const raw = await resumeAfterData(snapshot.raw, budget); dataJournal.complete(snapshot.preview.target); return raw;
  },
  async exchange(snapshot, image, budget, verify, beginExchange) {
    const definition = snapshot.definition as Definition;
    beginExchange();
    updateJournal.begin({ target: snapshot.preview.target, containerId: snapshot.raw.Id, containerName: snapshot.raw.Name.replace(/^\//, "") });
    dataJournal.complete(snapshot.preview.target);
    const started = await mutate(snapshot, image, budget, false); verify();
    await verifyUpdate(() => read(snapshot, budget), snapshot.preview, image, budget, started);
    let raw = await read(snapshot, budget);
    if (!definition.project && hash(buildCreatePayload(raw, { imageRef: snapshot.preview.imageRef })) !== snapshot.preview.definitionHash) throw new UpdateFailure("update-state-mismatch");
    if (snapshot.preview.initialState.status === "paused") {
      await budget.run((options) => engine.pause(raw.Id, true, options)); raw = await read(snapshot, budget);
    }
    updateJournal.complete(snapshot.preview.target);
    return raw;
  },
  async rollback(snapshot, budget) {
    updateJournal.begin({ target: snapshot.preview.target, containerId: snapshot.raw.Id, containerName: snapshot.raw.Name.replace(/^\//, "") });
    rollbackTags.delete(JSON.stringify(snapshot.preview.target));
    const reference = parseImageRef(snapshot.preview.imageRef);
    if (!reference) throw new UpdateFailure("update-rollback-failed");
    if (!reference.digest) {
      await budget.run((options) => engine.tagImage(snapshot.raw.Image!, reference.fromImage, reference.tag ?? "latest", options));
      rollbackTags.set(JSON.stringify(snapshot.preview.target), `tag-restored: ${snapshot.preview.imageRef} -> ${snapshot.raw.Image}`);
    }
    const started = await mutate(snapshot, snapshot.raw.Image!, budget, true);
    let raw = await read(snapshot, budget);
    if (snapshot.preview.initialState.status === "paused") {
      await budget.run((options) => engine.pause(raw.Id, true, options)); raw = await read(snapshot, budget);
    }
    const definition = snapshot.definition as Definition;
    if (definition.project) {
      const originalHash = snapshot.raw.Config?.Labels?.["com.docker.compose.config-hash"];
      if (!originalHash || raw.Config?.Labels?.["com.docker.compose.config-hash"] !== originalHash) throw new UpdateFailure("update-rollback-failed");
    } else if (hash(buildCreatePayload(raw, { imageRef: snapshot.preview.imageRef })) !== snapshot.preview.definitionHash) throw new UpdateFailure("update-rollback-failed");
    if (!rollbackStateMatches(raw, snapshot.raw)) raw = await verifyRollback(() => read(snapshot, budget), snapshot.preview, snapshot.raw, budget, started);
    updateJournal.complete(snapshot.preview.target);
    return raw;
  },
  read, intentional: (snapshots) => stopIntents.beginUpdate(snapshots.map((s) => s.raw)), finished
};
export const updateRunner = new UpdateRunner(agentJobs, stackLocks, updateRuntimeOps);
