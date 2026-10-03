// Creating a hub-owned project (#3, decisions in #128): the raw compose chain
// plus what only a create needs — occupancy under the project lock, the
// ownership marker and cleanup of an empty directory after a failure.

import type { ComposeConfirmations } from "contract";
import { COMPOSE_FILE_NAME, locationFor } from "../compose.js";
import { validateRawContent } from "../compose-raw.js";
import { directoryOccupied, ensureProjectDir, removeEmptyProjectDir } from "../compose-store.js";
import { externalSourcesOf } from "../mount-sources.js";
import { writeProjectMarker } from "../project-marker.js";
import { inspectRawApply, planFromInspection, type RawLocation } from "../raw-apply.js";
import { forcedManagement } from "../stacks.js";
import { composeBasePath } from "./containers.js";
import type { AgentTier } from "./http.js";
import { executeRawLocked, rawLockKey, rawOps, rawReason } from "./raw-ops.js";
import { audit, stackLocks } from "./state.js";

type Outcome = { status: number; body: Record<string, unknown> };

type Located = { ok: true; location: RawLocation } | { ok: false; outcome: Outcome };

function newProjectLocation(name: string): Located {
  const own = locationFor(name, composeBasePath);
  if (!own) return { ok: false, outcome: { status: 400, body: { error: rawReason("name-not-usable-as-directory") } } };
  if (forcedManagement(own.projectDir) === "read-only") {
    return {
      ok: false,
      outcome: { status: 403, body: { error: rawReason("self-management-locked"), projectDir: own.projectDir } }
    };
  }
  return {
    ok: true,
    location: { projectDir: own.projectDir, composeFileName: COMPOSE_FILE_NAME, projectName: name }
  };
}

function taken(projectDir: string): Outcome {
  return { status: 409, body: { error: rawReason("directory-taken"), projectDir } };
}

export type ProjectCreation = {
  name: string;
  content: string;
  confirmations: ComposeConfirmations;
  confirmExternalSources: readonly string[];
  actor: string | null;
  tier: AgentTier;
};

export async function createProject(operation: ProjectCreation): Promise<Outcome> {
  const located = newProjectLocation(operation.name);
  if (!located.ok) return located.outcome;
  const { location } = located;
  const auditDenied = (reason: string): void => {
    audit.write({
      action: "compose-raw",
      containerId: null,
      containerName: operation.name,
      actor: operation.actor,
      networkTier: operation.tier,
      outcome: "denied",
      reason
    });
  };

  return stackLocks.runExclusive(rawLockKey({ location, containerId: null, stackName: operation.name }), async () => {
    // Checked under the lock: two creates of the same name must not both pass.
    if (directoryOccupied(location.projectDir)) {
      auditDenied("directory-taken");
      return taken(location.projectDir);
    }
    ensureProjectDir(location.projectDir, composeBasePath);

    const result = await executeRawLocked({
      location,
      content: operation.content,
      expectedHash: null,
      currentServices: [],
      confirmations: operation.confirmations,
      confirmExternalSources: operation.confirmExternalSources,
      actor: operation.actor,
      tier: operation.tier,
      containerId: null,
      stackName: operation.name
    });

    if (result.status === 200) {
      writeProjectMarker(location.projectDir, composeBasePath);
      audit.write({
        action: "project-marker",
        containerId: null,
        containerName: operation.name,
        actor: operation.actor,
        networkTier: operation.tier,
        outcome: "allowed",
        reason: location.projectDir
      });
      return { status: 200, body: { ...result.body, hubOwned: true } };
    }

    // A failed rollback may leave containers behind; then nothing is removed.
    if (result.body.rolledBack === false) return result;
    const removed = removeEmptyProjectDir(location.projectDir, composeBasePath);
    if (!removed) {
      audit.write({
        action: "project-cleanup",
        containerId: null,
        containerName: operation.name,
        actor: operation.actor,
        networkTier: operation.tier,
        outcome: "error",
        reason: `${location.projectDir}: data left`
      });
    }
    return {
      status: result.status,
      body: { ...result.body, projectDir: location.projectDir, projectDirRemoved: removed }
    };
  });
}

export type ProjectPreview = {
  name: string;
  content: string;
  actor: string | null;
  tier: AgentTier;
};

// The dry run of a create. It needs the directory for `docker compose config`
// to resolve relative sources, and removes it again if it created it.
export async function previewProject(operation: ProjectPreview): Promise<Outcome> {
  const located = newProjectLocation(operation.name);
  if (!located.ok) return located.outcome;
  const { location } = located;

  return stackLocks.runExclusive(rawLockKey({ location, containerId: null, stackName: operation.name }), async () => {
    if (directoryOccupied(location.projectDir)) return taken(location.projectDir);
    const auditEntry = (reason: string): void => {
      audit.write({
        action: "compose-raw-preview",
        containerId: null,
        containerName: operation.name,
        actor: operation.actor,
        networkTier: operation.tier,
        outcome: "allowed",
        reason
      });
    };
    const frame = {
      projectDir: location.projectDir,
      composeFileName: location.composeFileName,
      stackName: operation.name
    };

    const contentErrors = validateRawContent(operation.content);
    if (contentErrors.length > 0) {
      auditEntry(`${location.projectDir}: invalid-content`);
      return {
        status: 200,
        body: {
          ...frame,
          valid: false,
          reason: rawReason("invalid-content"),
          errors: contentErrors,
          configError: null,
          services: null,
          imagesByService: {},
          missingImages: null,
          servicesWithoutImage: [],
          mountSources: [],
          externalSources: []
        }
      };
    }

    ensureProjectDir(location.projectDir, composeBasePath);
    try {
      const inspection = await inspectRawApply(rawOps, {
        location,
        content: operation.content,
        basePath: composeBasePath,
        currentServices: []
      });
      const plan = planFromInspection(inspection);
      auditEntry(`${location.projectDir}: ${plan.ok ? "valid" : plan.reason}`);
      return {
        status: 200,
        body: {
          ...frame,
          valid: plan.ok,
          reason: plan.ok ? null : plan.reason,
          errors: [],
          configError: inspection.configError,
          services: inspection.services,
          imagesByService: inspection.imagesByService,
          missingImages: inspection.missingImages,
          servicesWithoutImage: inspection.servicesWithoutImage,
          mountSources: inspection.mountSources,
          externalSources: externalSourcesOf(inspection.mountSources)
        }
      };
    } finally {
      removeEmptyProjectDir(location.projectDir, composeBasePath);
    }
  });
}
