import { runtimeCall, type RuntimeBudget } from "../runtime-budget.js";
import fs from "node:fs";
import {
  EngineError,
  resolveVolumeBinds,
  toInspectedContainer,
  volumeNamesOf,
  type RawInspect,
  type RawVolume,
  type VolumeBindResolution
} from "../engine.js";
import {
  selfCheckViolations,
  violationValue,
  type HardeningOptions,
  type InspectedContainer
} from "../hardening.js";
import {
  composeContextOf,
  isValidProjectName,
  locationFor,
  type ComposeContext
} from "../compose.js";
import { forcedManagement } from "../stacks.js";
import {
  resolveContainerId,
  type ComposeProject
} from "../compose-cli.js";
import { collectStatsWave, CpuCounterHistory } from "../stats.js";
import { composeCandidates } from "../compose-selection.js";
import { createImageManagerLabelLookup } from "../external-management.js";
import { config, engine, registry, composeSelections, statsHistory, hardeningOptions } from "./state.js";

// Stage 5c: the same path is also the root of the compose directories. A
// container lives in /home/docker/<name>, and its bind sources must lie below
// /home/docker — one rule, one path. (Stage 5e turns this into a base path PER
// container for the "protected" class; then they are two levels of the same
// rule, not two rules — see hardeningOptionsFor.)
export const composeBasePath = config.bindBasePath;

export function availableComposeCandidates(labels: Record<string, string> | undefined) {
  return composeCandidates(labels, composeBasePath).filter((candidate) => {
    if (forcedManagement(candidate.projectDir) === "read-only") return false;
    try {
      return forcedManagement(fs.realpathSync(candidate.projectDir)) !== "read-only";
    } catch {
      return false;
    }
  });
}

export function selectedComposeContext(
  containerName: string,
  labels: Record<string, string> | undefined
): ComposeContext | null {
  const selected = composeSelections.get(containerName, availableComposeCandidates(labels));
  const serviceName = labels?.["com.docker.compose.service"];
  const project = labels?.["com.docker.compose.project"];
  if (!selected || !serviceName || !isValidProjectName(project)) return null;
  return {
    projectDir: selected.projectDir,
    composeFileName: selected.composeFileName,
    serviceName,
    project
  };
}

export function composeContextFor(containerName: string, labels: Record<string, string> | undefined): ComposeContext | null {
  return selectedComposeContext(containerName, labels) ?? composeContextOf(labels, composeBasePath);
}

// Stage 5e: the hardening options for a SPECIFIC, already allowlisted
// container. If it is marked as "protected", its own universe is added — then
// the check reports a neighbour mount as bind-outside-universe.
//
// ⚠️ The class AND the universe are read from the agent's OWN registry copy,
// never from the request of the action (security review 5c, finding 4). The
// universe is the project directory: for adopted containers the anchor from
// the sync, otherwise the path derived from the name (locationFor) — the same
// order in which the action paths determine the location.
export function hardeningOptionsFor(containerId: string): HardeningOptions {
  const entry = registry.get(containerId);
  if (!entry?.secured) return hardeningOptions;
  const universe = entry.compose?.projectDir ?? locationFor(entry.containerName, composeBasePath)?.projectDir;
  // If the universe cannot be determined (adopted container without an anchor
  // and with a name that yields no valid directory), the check falls back
  // fail-closed to the base path and reports that — instead of silently
  // lowering "protected" to "normal".
  if (!universe) {
    console.warn(`[hardening] protected container ${containerId} has no determinable universe — checking against base path only`);
    return hardeningOptions;
  }
  // Spread instead of rebuilding: otherwise `selfPaths` silently drops out for
  // protected containers — exactly the kind of gap that arises when the same
  // set of options is assembled by hand in two places.
  return { ...hardeningOptions, secureUniverse: universe };
}

// Named volumes can bind host paths through driver options. Every hardening
// check resolves them; unresolved volumes remain visible to the gate.
export async function volumeBindsOf(raw: RawInspect, budget?: RuntimeBudget): Promise<VolumeBindResolution> {
  const names = volumeNamesOf(raw);

  const volumes = new Map<string, RawVolume>();
  for (const name of names) {
    try {
      const volume = await runtimeCall(budget, (options) => engine.inspectVolume(name, options));
      if (volume) volumes.set(name, volume);
    } catch (error) {
      budget?.remaining();
      // Keep unreadable volumes unresolved instead of dropping their risk.
      console.error(`[agent] volume ${name} not readable:`, error);
    }
  }
  return resolveVolumeBinds(raw, volumes);
}

export async function inspectedContainer(raw: RawInspect, budget?: RuntimeBudget): Promise<InspectedContainer> {
  const base = toInspectedContainer(raw);
  const resolution = await volumeBindsOf(raw, budget);
  return {
    ...base,
    binds: [...base.binds, ...resolution.binds],
    unresolvedVolumes: resolution.unresolved
  };
}

// Comparison keys of a container's blocking violations (S9).
//
// Word for word the same as rawOps.violationsOf (runtime/raw-ops.ts), and that
// is intentional: the raw editor and the update/recreate path ask the same
// question ("does this change introduce something new?") and must answer it
// the same way. Two slightly different keys would be two slightly different
// security statements.
//
// ⚠️ For bind-derived rules the normalised HOST PATH, not the full `detail`
// (PR #176): otherwise the same docker.sock counts as "new" as soon as only
// its spelling changes — target path, `:ro`, a different Compose version on
// recreate.
export async function violationKey(raw: RawInspect, containerId: string): Promise<string[]> {
  return selfCheckViolations(
    await inspectedContainer(raw),
    hardeningOptionsFor(containerId)
  ).map(violationValue);
}

export const imageManagerLabelOf = createImageManagerLabelLookup((imageId) => engine.inspectImage(imageId));

// Docker lists the image ID instead of the creation reference once that reference resolves
// to another image, e.g. after a pull. Inventories feeding the registry keep the reference.
export async function creationImageRef(container: { id: string; image: string; imageId: string }): Promise<string> {
  if (!container.imageId || container.image !== container.imageId) return container.image;
  try { return (await engine.inspect(container.id)).Config?.Image || container.image; }
  catch (error) {
    if (error instanceof EngineError && error.status === 404) return container.image;
    throw error;
  }
}

// CPU/RAM sampling (S13); the CPU baseline per container lives only here.
const cpuCounters = new CpuCounterHistory();

export let statsCollectionRunning = false;

export async function collectStats(): Promise<void> {
  // A wave that outlasts the interval is not stacked with a second one on the
  // same socket; the buffer keeps the last consistent sample.
  if (statsCollectionRunning) return;
  statsCollectionRunning = true;
  try {
    await collectStatsWave(registry.allowedIds(), {
      history: statsHistory,
      counters: cpuCounters,
      fetchStats: (containerId) => engine.stats(containerId)
    });
  } finally {
    statsCollectionRunning = false;
  }
}

// The bridge from the choreography (compose-apply.ts) to engine and CLI.
// Passed as an object, so that the choreography stays testable without Docker.
// ⚠️ `docker compose ps` returns the SHORT container id (12 characters),
// `inspect` everywhere else the full one. Found live 2026-07-21: a short id in
// the allowlist makes the container invisible as soon as someone addresses it
// with the full id — and that is exactly what the container list does,
// because it comes from `inspect`. `isAllowed(fullId)` then fails and the
// container drops out of management.
//
// That is the same class of bug this stage is meant to eliminate. Hence there
// is only ONE form: the full id from `inspect`. Docker accepts the short id as
// a prefix, so the resolution costs only one inspect.
export async function resolveFullContainerId(
  project: ComposeProject,
  serviceName: string
): Promise<string | null> {
  const short = await resolveContainerId(project, serviceName);
  if (!short) return null;
  try {
    return (await engine.inspect(short)).Id;
  } catch (error) {
    if (error instanceof EngineError && error.status === 404) return null;
    throw error;
  }
}
