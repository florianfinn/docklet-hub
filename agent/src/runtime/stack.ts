import {
  type RawInspect
} from "../engine.js";
import {
  normalizePath
} from "../hardening.js";
import {
  COMPOSE_FILE_NAME,
  composeContextOf,
  isInsideBase,
  isValidComposeFileName,
  isValidProjectName,
  locationFor
} from "../compose.js";
import { forcedManagement } from "../stacks.js";
import {
  composeConfig,
  type NamedComposeProject
} from "../compose-cli.js";
import { type RegistryEntry } from "../registry.js";
import {
  stackDefinitionFromConfig,
  stackMutationBaseDeny,
  type StackCoupling,
  type StackDefinition
} from "../stack-control.js";
import { config, engine, registry } from "./state.js";
import { composeBasePath } from "./containers.js";
import { AgentTier } from "./http.js";
import { gate } from "./gate.js";

export type StackResolvedProject = NamedComposeProject & {
  anchorServiceName: string;
  anchorEntry: RegistryEntry;
};

export type StackServiceSnapshot = {
  serviceName: string;
  containerId: string | null;
  containerName: string | null;
  imageRef: string | null;
  status: string;
  running: boolean;
  missing: boolean;
  allowed: boolean;
  // Only the boolean visibility signal leaves the agent. Rule details and host
  // paths stay reserved for the dedicated hardening endpoint.
  delegationLocked: boolean;
  hardeningVerified: boolean;
};

export type StackContextResponse = {
  projectName: string;
  state: "running" | "stopped" | "partial" | "down";
  readOnly: boolean;
  // Host paths do not leave the agent on the external tier. The server does
  // not need them for the stack UI either; internally they stay available for
  // diagnosis/administration.
  projectDir: string | null;
  composeFileName: string | null;
  anchorServiceName: string;
  services: StackServiceSnapshot[];
  couplings: Array<StackCoupling & { fingerprint: string }>;
  missingServices: string[];
  runningServices: string[];
  capabilities: { startRequiresApply: boolean };
};

export type PreparedStack = {
  project: StackResolvedProject;
  definition: StackDefinition;
  context: StackContextResponse;
  entriesByService: Map<string, RegistryEntry>;
};

export class StackEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(code);
    this.name = "StackEndpointError";
  }
}

export function stackProjectFromRegistry(anchorContainerId: string): StackResolvedProject {
  const anchorEntry = registry.get(anchorContainerId);
  if (!anchorEntry || !registry.isAllowed(anchorContainerId)) {
    throw new StackEndpointError(404, "not-allowlisted");
  }

  if (anchorEntry.compose) {
    const { projectDir, projectName, serviceName, composeFileName } = anchorEntry.compose;
    // `projectName` is only missing in a registry file from before S11. Do not
    // guess it from the request or from the directory name: a sync of the main
    // API has to supply the Docker label value.
    if (!projectName) throw new StackEndpointError(409, "compose-project-name-missing");
    if (!isValidProjectName(projectName)) {
      throw new StackEndpointError(409, "invalid-compose-project-name");
    }
    if (!isValidComposeFileName(composeFileName)) {
      throw new StackEndpointError(409, "invalid-compose-file-name");
    }
    if (!isInsideBase(projectDir, composeBasePath)) {
      throw new StackEndpointError(409, "project-dir-outside-base-path");
    }
    return {
      projectDir: normalizePath(projectDir),
      projectName,
      composeFileName,
      anchorServiceName: serviceName,
      anchorEntry
    };
  }

  // Compatibility for old single-service entries created by the dashboard
  // itself: identity and location are derived exclusively from the name in the
  // agent's own registry. For adopted stacks this fallback is not allowed; they
  // always carry a Compose anchor.
  const own = locationFor(anchorEntry.containerName, composeBasePath);
  if (!own) throw new StackEndpointError(409, "compose-anchor-missing");
  return {
    projectDir: own.projectDir,
    projectName: anchorEntry.containerName,
    composeFileName: COMPOSE_FILE_NAME,
    anchorServiceName: own.serviceName,
    anchorEntry
  };
}

export type CurrentStackContainer = {
  serviceName: string;
  containerId: string;
  containerName: string;
  imageRef: string;
  status: string;
};

// Determines the containers ACTUALLY affected by the Compose project name via
// daemon labels. That includes orphans, which `down` can touch as well. The
// same project name in a different directory is not ignored but blocks the
// action: with `--project-name` it could not be proven that Compose leaves it
// untouched.
export async function currentStackContainers(
  project: StackResolvedProject
): Promise<Map<string, CurrentStackContainer>> {
  const all = await engine.listWithComposeLabels();
  const sameProjectName = all.filter(
    (entry) => entry.labels["com.docker.compose.project"] === project.projectName
  );
  const current = new Map<string, CurrentStackContainer>();

  for (const entry of sameProjectName) {
    const context = composeContextOf(entry.labels, composeBasePath);
    if (
      !context ||
      context.project !== project.projectName ||
      context.projectDir !== project.projectDir ||
      context.composeFileName !== project.composeFileName
    ) {
      throw new StackEndpointError(409, "compose-project-name-collision");
    }
    if (current.has(context.serviceName)) {
      // The current permission model is one container per service. For scaled
      // services a single registry/grant anchor would be ambiguous; so do not
      // pick an arbitrary first instance.
      throw new StackEndpointError(409, "scaled-service-unsupported", {
        serviceName: context.serviceName
      });
    }
    current.set(context.serviceName, {
      serviceName: context.serviceName,
      containerId: entry.id,
      containerName: entry.name,
      imageRef: entry.image,
      status: entry.status
    });
  }
  return current;
}

export function registryEntriesByService(project: StackResolvedProject): Map<string, RegistryEntry> {
  const entries = registry.entriesForCompose(
    project.projectDir,
    project.projectName,
    project.composeFileName
  );
  // Fallback only for the old own single-service stack described above.
  if (entries.length === 0 && !project.anchorEntry.compose) entries.push(project.anchorEntry);

  const byService = new Map<string, RegistryEntry>();
  for (const entry of entries) {
    const serviceName = entry.compose?.serviceName ?? project.anchorServiceName;
    if (byService.has(serviceName)) {
      throw new StackEndpointError(409, "ambiguous-registry-service", { serviceName });
    }
    byService.set(serviceName, entry);
  }
  return byService;
}

export function stackState(services: readonly StackServiceSnapshot[]): StackContextResponse["state"] {
  const existing = services.filter((service) => !service.missing);
  if (existing.length === 0) return "down";
  if (services.every((service) => service.running && !service.missing)) return "running";
  if (services.every((service) => service.missing || !service.running) && !services.some((service) => service.missing)) {
    return "stopped";
  }
  return "partial";
}

export async function prepareStack(
  project: StackResolvedProject,
  tier: AgentTier,
  options: { mutating: boolean; action: string; actor: string | null }
): Promise<PreparedStack> {
  if (options.mutating) {
    const denied = stackMutationBaseDeny({
      readOnly: config.readOnly,
      selfManaged: forcedManagement(project.projectDir) === "read-only"
    });
    if (denied) throw new StackEndpointError(denied.status, denied.code);
  }

  let normalized: unknown;
  try {
    normalized = await composeConfig(project);
  } catch (error) {
    console.error(`[agent] compose config for stack ${project.projectName} failed:`, error);
    throw new StackEndpointError(409, "compose-config-failed");
  }
  const definition = stackDefinitionFromConfig(normalized);
  if (!definition) throw new StackEndpointError(409, "compose-services-missing");

  const current = await currentStackContainers(project);
  const entriesByService = registryEntriesByService(project);

  // Gate JEDEN derzeit vom projektweiten CLI-Aufruf erreichbaren Container,
  // einschliesslich Orphans. Ein nicht allowlisteter Nachbar blockiert die
  // ganze Aktion; der Agent kann Rechte nicht durch Weglassen herstellen.
  const inspectByService = new Map<string, RawInspect>();
  const delegationByService = new Map<string, boolean>();
  const deniedServices: Array<{ serviceName: string; reason: string; status: number }> = [];
  for (const [serviceName, container] of current) {
    const result = await gate(container.containerId, {
      mutating: options.mutating,
      action: options.action,
      tier,
      actor: options.actor
    });
    if (!result.ok) {
      deniedServices.push({ serviceName, reason: result.reason, status: result.status });
      continue;
    }
    inspectByService.set(serviceName, result.inspect);
    delegationByService.set(serviceName, result.delegationLocked);
  }
  if (deniedServices.length > 0) {
    const onlyAllowlist = deniedServices.every((entry) => entry.reason === "not-allowlisted");
    throw new StackEndpointError(
      onlyAllowlist ? 403 : deniedServices[0].status,
      onlyAllowlist ? "stack-service-not-allowlisted" : "stack-service-gate-denied",
      {
        services: deniedServices
          .sort((a, b) => a.serviceName.localeCompare(b.serviceName))
          .map(({ serviceName, reason }) => ({ serviceName, reason }))
      }
    );
  }

  const allServiceNames = [...new Set([...definition.services, ...current.keys()])].sort();
  const services: StackServiceSnapshot[] = allServiceNames.map((serviceName) => {
    const container = current.get(serviceName);
    const inspect = inspectByService.get(serviceName);
    const registryEntry = entriesByService.get(serviceName);
    const missing = !container;
    const status = missing ? "missing" : (inspect?.State?.Status ?? container.status ?? "unknown");
    return {
      serviceName,
      containerId: container?.containerId ?? null,
      containerName: container?.containerName ?? null,
      imageRef: inspect?.Config?.Image ?? container?.imageRef ?? registryEntry?.imageRef ?? null,
      status,
      running: inspect?.State?.Running === true || status === "running",
      missing,
      // Bei einem fehlenden Container ist der alte Registry-Eintrag genau der
      // Reanchor, der ein sicheres `up` erlaubt. Bei einem vorhandenen muss die
      // aktuelle Id selbst allowlistet sein.
      allowed: container
        ? registry.isAllowed(container.containerId)
        : registryEntry ? registry.isAllowed(registryEntry.containerId) : false,
      delegationLocked: container ? delegationByService.get(serviceName) === true : false,
      hardeningVerified: Boolean(container)
    };
  });
  const missingServices = definition.services.filter((serviceName) => !current.has(serviceName));
  const runningServices = services.filter((service) => service.running).map((service) => service.serviceName);
  const couplings = definition.couplings.map((coupling) => ({
    ...coupling,
    fingerprint: `${coupling.kind}:${coupling.sourceService}->${coupling.targetService}`
  }));
  const context: StackContextResponse = {
    projectName: project.projectName,
    state: stackState(services),
    readOnly: config.readOnly || forcedManagement(project.projectDir) === "read-only",
    projectDir: tier === "internal" ? project.projectDir : null,
    composeFileName: tier === "internal" ? project.composeFileName : null,
    anchorServiceName: project.anchorServiceName,
    services,
    couplings,
    missingServices,
    runningServices,
    capabilities: { startRequiresApply: missingServices.length > 0 }
  };
  return { project, definition, context, entriesByService };
}

export function ensureCreateScopeAllowlisted(prepared: PreparedStack): void {
  const denied = prepared.definition.services.filter(
    (serviceName) => {
      const entry = prepared.entriesByService.get(serviceName);
      return !entry || !registry.isAllowed(entry.containerId);
    }
  );
  if (denied.length > 0) {
    throw new StackEndpointError(403, "stack-service-not-allowlisted", { services: denied });
  }
}

export async function reanchorStackRegistry(prepared: PreparedStack): Promise<void> {
  const current = await currentStackContainers(prepared.project);
  const replacements = new Map<string, string>();
  for (const [serviceName, container] of current) {
    const old = prepared.entriesByService.get(serviceName);
    if (old && old.containerId !== container.containerId) {
      replacements.set(old.containerId, container.containerId);
    }
  }
  if (replacements.size > 0 && !registry.replaceContainerIds(replacements)) {
    throw new StackEndpointError(409, "registry-reanchor-failed", {
      containerIds: Object.fromEntries(
        [...current.entries()].map(([serviceName, container]) => [serviceName, container.containerId])
      )
    });
  }
}

export function containerIdsOf(context: StackContextResponse): Record<string, string> {
  return Object.fromEntries(
    context.services
      .filter((service): service is StackServiceSnapshot & { containerId: string } => Boolean(service.containerId))
      .map((service) => [service.serviceName, service.containerId])
  );
}
