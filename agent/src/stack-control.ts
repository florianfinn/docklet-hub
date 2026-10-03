// Pure S11 building blocks for project-wide Compose actions. No engine or
// file system access here: coupling detection and tier decision thereby stay
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

// `docker compose restart` starts engine containers largely in parallel and
// ignores Compose dependencies without `restart: true` while doing so. With
// service-shared network/PID/IPC namespaces the dependent container can
// therefore start against the anchor that has just been stopped. As soon as a
// detected S11 coupling exists, the stack needs the ordered stop->start path.
export function stackNeedsDependencySafeRestart(couplings: readonly StackCoupling[]): boolean {
  return couplings.length > 0;
}

// The shape is checked by `expectedStackSchema` (contract) when the request is
// read; here only the comparison remains.
export function expectedStackMatches(expected: ExpectedStack, actual: ExpectedStack): boolean {
  const sortServices = (
    services: Array<{ serviceName: string; containerId: string | null }>
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
        service.containerId === actualServices[index]?.containerId
    )
  );
}

// For `network_mode`, `pid` and `ipc` Compose knows TWO spellings that mean
// the same shared namespace:
//
//   network_mode: service:gluetun            -> service name in the same project
//   network_mode: container:gluetun_arrstack -> CONTAINER name
//
// ⚠️ Up to v0.12.1 this function only knew the first. `arr_stack` uses only
// the second — four services there hung off gluetun without a single
// `network_mode` coupling being reported. On 2026-08-25 a stack update
// therefore replaced gluetun and left sonarr, prowlarr and sabnzbd behind in a
// netns that no longer existed; Docker kept reporting them as `running`. That
// the single `restart` still triggered a confirmation prompt back then came
// solely from `service_healthy` — a lucky hit of the same topology that a
// stack without `depends_on` would not have had.
//
// ⚠️ Resolution only goes through an explicit `container_name:` in the same
// file. Reproducing the name ASSIGNED by Compose (`<project>-<service>-1`)
// here would be guesswork: it depends on the project name and the replica
// counter, and `docker compose config` does not output it. If a reference
// points to a container outside the project, "no coupling" is correctly the
// result — a stack action could not take it along anyway.
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

// `start` is normally a safe action. As soon as a declared container is
// missing, however, Compose has to create it with `up`; from then on it is
// internal-only like apply/destructive. This decision is made BEFORE the CLI
// call and therefore does not depend on a Compose error message.
export function stackActionNeedsInternal(action: StackAction, missingServices: readonly string[]): boolean {
  return action === "apply" || action === "down" || (action === "start" && missingServices.length > 0);
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
  tier: "internal" | "external";
  missingServices: readonly string[];
  projectName: string;
  confirmation: unknown;
  allowFallbackUp: boolean;
}): StackPolicyDeny | null {
  if (stackActionNeedsInternal(options.action, options.missingServices) && options.tier !== "internal") {
    return { status: 403, code: "internal-only-action" };
  }
  if (options.action === "start" && options.missingServices.length > 0 && !options.allowFallbackUp) {
    return { status: 409, code: "stack-start-requires-apply" };
  }
  if (options.action === "down" && options.confirmation !== options.projectName) {
    return { status: 409, code: "stack-confirmation-wrong" };
  }
  return null;
}
