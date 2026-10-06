// Pure S11 building blocks for project-wide Compose actions. No engine or
// file system access here: coupling detection and action policy thereby stay
// small, deterministic and separately testable.

import type { ExpectedStack } from "contract";

export type { ExpectedStack };

export type StackCouplingKind = "network_mode" | "pid" | "ipc" | "service_healthy";

export type StackCoupling = {
  kind: StackCouplingKind;
  sourceService: string;
  targetService: string;
};

export type StackDefinition = {
  services: string[];
  couplings: StackCoupling[];
};

// The shape is checked by `expectedStackSchema` (contract) when the request is
// read; here only the comparison remains.
export function expectedStackMatches(expected: ExpectedStack, actual: ExpectedStack): boolean {
  const sortServices = (
    services: ExpectedStack["services"]
  ) => [...services].sort((left, right) => left.serviceName.localeCompare(right.serviceName));
  const expectedServices = sortServices(expected.services);
  const actualServices = sortServices(actual.services);
  return (
    expected.projectName === actual.projectName &&
    expected.projectDir === actual.projectDir &&
    expected.composeFileName === actual.composeFileName &&
    expectedServices.length === actualServices.length &&
    expectedServices.every(
      (service, index) =>
        service.serviceName === actualServices[index]?.serviceName &&
        service.containerId === actualServices[index]?.containerId &&
        service.status === actualServices[index]?.status &&
        service.startedAt === actualServices[index]?.startedAt
    )
  );
}

// Resolve shared namespaces only through explicit names in the definition.
// Compose-generated container names depend on the project and replica count.
function namespaceTarget(value: unknown, serviceByContainerName: ReadonlyMap<string, string>): string | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("service:")) {
    const target = value.slice("service:".length);
    return target || null;
  }
  if (value.startsWith("container:")) {
    const containerName = value.slice("container:".length);
    return containerName ? (serviceByContainerName.get(containerName) ?? null) : null;
  }
  return null;
}

export function stackDefinitionFromConfig(config: unknown): StackDefinition | null {
  const rawServices = (config as { services?: unknown } | null)?.services;
  if (!rawServices || typeof rawServices !== "object" || Array.isArray(rawServices)) return null;
  const records = rawServices as Record<string, unknown>;
  const services = Object.keys(records).sort();
  if (services.length === 0) return null;
  const known = new Set(services);
  const couplings: StackCoupling[] = [];

  // Two services with the same `container_name` are already invalid — the
  // engine assigns a name only once. If the file says so anyway, the
  // alphabetically first one wins, so that the set of couplings (and thus its
  // fingerprint) stays deterministic.
  const serviceByContainerName = new Map<string, string>();
  for (const serviceName of services) {
    const raw = records[serviceName];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const containerName = (raw as Record<string, unknown>).container_name;
    if (typeof containerName !== "string" || !containerName) continue;
    if (!serviceByContainerName.has(containerName)) serviceByContainerName.set(containerName, serviceName);
  }

  const add = (kind: StackCouplingKind, sourceService: string, targetService: string | null) => {
    // A reference to an unknown service is already an invalid Compose
    // definition; `docker compose config` normally rejects it. Should a
    // version output it nevertheless, it is no use as a selectable coupling
    // and is not invented here.
    if (!targetService || !known.has(targetService)) return;
    couplings.push({ kind, sourceService, targetService });
  };

  for (const sourceService of services) {
    const raw = records[sourceService];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const service = raw as Record<string, unknown>;
    add("network_mode", sourceService, namespaceTarget(service.network_mode, serviceByContainerName));
    add("pid", sourceService, namespaceTarget(service.pid, serviceByContainerName));
    add("ipc", sourceService, namespaceTarget(service.ipc, serviceByContainerName));

    const dependsOn = service.depends_on;
    if (!dependsOn || typeof dependsOn !== "object" || Array.isArray(dependsOn)) continue;
    for (const [targetService, rawDependency] of Object.entries(dependsOn as Record<string, unknown>)) {
      if (!rawDependency || typeof rawDependency !== "object" || Array.isArray(rawDependency)) continue;
      if ((rawDependency as Record<string, unknown>).condition === "service_healthy") {
        add("service_healthy", sourceService, targetService);
      }
    }
  }

  const key = (entry: StackCoupling) => `${entry.sourceService}\0${entry.targetService}\0${entry.kind}`;
  return {
    services,
    couplings: [...new Map(couplings.map((entry) => [key(entry), entry])).values()].sort((a, b) =>
      key(a).localeCompare(key(b))
    )
  };
}

export type StackAction = "start" | "stop" | "restart" | "apply" | "down";

export function isStackAction(value: string): value is StackAction {
  return value === "start" || value === "stop" || value === "restart" || value === "apply" || value === "down";
}

export type StackPolicyDeny = { status: number; code: string };

export function stackMutationBaseDeny(options: {
  readOnly: boolean;
  selfManaged: boolean;
}): StackPolicyDeny | null {
  if (options.readOnly) return { status: 503, code: "agent-read-only" };
  if (options.selfManaged) return { status: 403, code: "self-management-locked" };
  return null;
}

export function stackActionDeny(options: {
  action: StackAction;
  projectName: string;
  confirmation: unknown;
}): StackPolicyDeny | null {
  if (options.action === "down" && options.confirmation !== options.projectName) {
    return { status: 409, code: "stack-confirmation-wrong" };
  }
  return null;
}

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
