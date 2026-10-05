// Container escape hardening: the last check before every action, run in the
// agent against a fresh `inspect`, because a check in the hub alone would be
// bypassed by exactly the attack it guards against, and containers change
// after they are allowlisted. Pure apart from the shared rule vocabulary in
// contract/, so it is testable without a Docker daemon.

import {
  DELEGATION_LOCK_RULES,
  HARDENING_RULE_SEVERITY,
  type HardeningRule,
  type HardeningSeverity
} from "contract";

export { DELEGATION_LOCK_RULES, type HardeningRule, type HardeningSeverity };

export type InspectedContainer = {
  id: string;
  name: string;
  image: string;
  privileged: boolean;
  capAdd: string[];
  capDrop: string[];
  securityOpt: string[];
  pidMode: string;
  ipcMode: string;
  networkMode: string;
  binds: string[];
  // Named volumes whose engine metadata could not be resolved reliably.
  // Unknown is security-relevant here: without an inspect it cannot be proven
  // that no `driver_opts.device` points at the host.
  unresolvedVolumes?: string[];
  devices: string[];
  // 0 = no limit (that is what the engine returns).
  memoryLimitBytes: number;
  // null = no limit set.
  pidsLimit: number | null;
  // true if NanoCpus or CpuQuota is set.
  cpuLimited: boolean;
  // Log driver and options as the engine resolved them at creation, so this is
  // the actual state, including the daemon default.
  logDriver: string;
  logOptions: Record<string, string>;
};

// Severity levels and their rules live in contract/src/agent/hardening.ts:
// "delegation-lock" means the container effectively is the host; the agent
// then refuses mutating actions from every tier but internal (runtime/gate.ts).
// "warning" marks a mounted host system directory, "notice" hygiene; neither
// blocks operation. `volume-unresolved` is the fail-closed stand-in while a
// volume's host source cannot be checked.

// Options of the check. Deliberately passed in instead of imported from
// config.ts, so this module stays pure and testable without an environment.
export type HardeningOptions = {
  // Allowlist root for bind mounts; without it the rule does not run.
  bindBasePath?: string;
  // The project directory of a "protected" container. Its binds must then lie
  // below exactly this directory; this only tightens bindBasePath. Without it
  // a neighbour's directory is the operator's trust decision.
  secureUniverse?: string;
  // The host directories that carry the management on this host: its state
  // and code directories and the agent container's own mounts. Only the caller
  // knows them; a mount reaching one from below or
  // above is a delegation lock. Missing or empty falls back to
  // DASHBOARD_SELF_PATHS, never to "nothing to protect".
  selfPaths?: readonly string[];
};

export function isDelegationLockRule(rule: string): boolean {
  return (DELEGATION_LOCK_RULES as readonly string[]).includes(rule);
}

export type HardeningViolation = {
  rule: HardeningRule;
  severity: HardeningSeverity;
  detail: string;
  // Bind-derived rules only: the normalised host path without target and
  // mode, the stable key of the before/after comparison (compose-raw.ts).
  hostPath?: string;
};

// "rule — subject", the comparison key of the compose paths. For bind-derived
// rules the normalised host path, so a changed spelling (target, `:ro`) of the
// same mount is not a new finding.
export const SUBJECT_SEPARATOR = " — ";

export function violationValue(violation: HardeningViolation): string {
  return `${violation.rule}${SUBJECT_SEPARATOR}${violation.hostPath ?? violation.detail}`;
}

export type HardeningReport = {
  // The only list that stops anything, and only outside the internal tier.
  delegationLock: HardeningViolation[];
  warning: HardeningViolation[];
  hint: HardeningViolation[];
};

// Capabilities that practically allow host compromise.
const FORBIDDEN_CAPABILITIES = new Set([
  "SYS_ADMIN",
  "SYS_MODULE",
  "SYS_RAWIO",
  "SYS_PTRACE",
  "SYS_BOOT",
  "DAC_READ_SEARCH",
  "NET_ADMIN",
  "ALL"
]);

// Host system directories whose mount, even read-only, is a warning. A
// denylist is incomplete by nature; the bind allowlist (bindBasePath) is the
// reliable rule and runs alongside. The agent's own directories are checked
// earlier by isDashboardSelfMount.
const SENSITIVE_HOST_PREFIXES = [
  "/etc",
  "/root",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/var/run",
  "/run",
  "/var/lib/docker"
];

// Fallback for HardeningOptions.selfPaths: the state (secrets) and code
// directories of the local management. A container holding one can rewrite
// the management, like docker.sock by another route. Callers pass the real
// paths of their host; this keeps a forgetful caller protective.
const DASHBOARD_SELF_PATHS = ["/home/docker/dashboard-state", "/home/docker/dashboard-repo"];

// Normalises a path without file system access: resolves "." and ".." and
// collapses multiple slashes. Important, because "/var/lib/../../etc" would
// otherwise slip past a plain prefix comparison.
export function normalizePath(input: string): string {
  const isAbsolute = input.startsWith("/");
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return (isAbsolute ? "/" : "") + segments.join("/");
}

function hostPathOf(bind: string): string {
  // Bind formats: "/host:/container", "/host:/container:ro", "name:/container".
  const [source = ""] = bind.split(":");
  return source;
}

// Does a normalised bind path reach the target from below OR above? A mount
// on an ancestor (`/var`, `/`) contains the target. "/" is handled on its own
// because `startsWith("//")` never matches.
function reachesTarget(normalized: string, target: string): boolean {
  if (normalized === "/") return true;
  if (normalized === target) return true;
  if (normalized.startsWith(target + "/")) return true;
  return target.startsWith(normalized + "/");
}

// `/var/run` is a symlink to `/run` on most hosts; both spellings occur.
const DOCKER_SOCKET_PATHS = ["/var/run/docker.sock", "/run/docker.sock"];

function isDockerSocket(hostPath: string): boolean {
  // Named volumes (no leading "/") are resolved separately
  // (volumeDeviceBinds) and then arrive here as a real host path.
  if (!hostPath.startsWith("/")) return false;
  const normalized = normalizePath(hostPath);
  return DOCKER_SOCKET_PATHS.some((target) => reachesTarget(normalized, target));
}

function isSensitiveHostPath(hostPath: string): boolean {
  // Named volumes (no leading "/") are harmless.
  if (!hostPath.startsWith("/")) return false;
  const normalized = normalizePath(hostPath);
  return SENSITIVE_HOST_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + "/")
  );
}

// Does this mount reach the management's own directories, from below or from
// above ("/" contains them)? Compared on the normalised source path; target
// and `:ro` do not matter.
function isDashboardSelfMount(hostPath: string, selfPaths?: readonly string[]): boolean {
  if (!hostPath.startsWith("/")) return false;
  const normalized = normalizePath(hostPath);
  // An empty list counts as not given, never as an off switch.
  const targets = selfPaths && selfPaths.length > 0 ? selfPaths : DASHBOARD_SELF_PATHS;
  return targets.some((target) => reachesTarget(normalized, target));
}

// json-file without max-size grows without bound; other drivers rotate or
// hand the log off. An empty driver name is Docker's default, json-file.
function isLoggingUnlimited(driver: string, options: Record<string, string>): boolean {
  const logDriver = (driver || "json-file").toLowerCase();
  if (logDriver !== "json-file") return false;
  const maxSize = options["max-size"] ?? options["max_size"] ?? "";
  return !maxSize.trim();
}

// Normalises "CAP_SYS_ADMIN", "cap_sys_admin" and "SYS_ADMIN" to one form.
function normalizeCapability(capability: string): string {
  return capability.replace(/^CAP_/i, "").toUpperCase();
}

// Allowlist: the source must lie strictly below a project directory, i.e. at
// least two levels below the base path. The base path itself and a project
// directory are excluded: the project directory holds the compose.yaml, and a
// container able to rewrite its own definition could make itself privileged
// on the next recreate. Data directories, a neighbour's included, stay
// mountable.
function isInsideBasePath(hostPath: string, basePath: string): boolean {
  const normalized = normalizePath(hostPath);
  const base = normalizePath(basePath);
  if (normalized === base || !normalized.startsWith(base + "/")) return false;
  // At least "<project>/<something>" must remain.
  return normalized.slice(base.length + 1).includes("/");
}

// A protected container's source must lie strictly below its own project
// directory, which holds the compose.yaml; isInsideBasePath runs as well.
function isInsideUniverse(hostPath: string, universe: string): boolean {
  const normalized = normalizePath(hostPath);
  const base = normalizePath(universe);
  return normalized !== base && normalized.startsWith(base + "/");
}

export function findHardeningViolations(
  container: InspectedContainer,
  options: HardeningOptions = {}
): HardeningViolation[] {
  const violations: HardeningViolation[] = [];

  // An unresolved named volume has an unknown host source: fail closed.
  for (const name of new Set(container.unresolvedVolumes ?? [])) {
    violations.push({
      rule: "volume-unresolved",
      severity: HARDENING_RULE_SEVERITY["volume-unresolved"],
      detail: `volume ${name} could not be checked`
    });
  }

  for (const bind of container.binds) {
    const hostPath = hostPathOf(bind);
    const normalizedHostPath = normalizePath(hostPath);
    if (isDashboardSelfMount(hostPath, options.selfPaths)) {
      // Before the socket and sensitive rules: "/" reaches all of them, and
      // this one explains best what is at stake.
      violations.push({
        rule: "dashboard-self-mount",
        severity: HARDENING_RULE_SEVERITY["dashboard-self-mount"],
        detail: bind,
        hostPath: normalizedHostPath
      });
    } else if (isDockerSocket(hostPath)) {
      violations.push({
        rule: "docker-socket-mount",
        severity: HARDENING_RULE_SEVERITY["docker-socket-mount"],
        detail: bind,
        hostPath: normalizedHostPath
      });
    } else if (isSensitiveHostPath(hostPath)) {
      // The denylist wins over the allowlist, inside the base path too.
      violations.push({ rule: "sensitive-host-path", severity: HARDENING_RULE_SEVERITY["sensitive-host-path"], detail: bind, hostPath: normalizedHostPath });
    } else if (
      options.bindBasePath &&
      hostPath.startsWith("/") &&
      !isInsideBasePath(hostPath, options.bindBasePath)
    ) {
      violations.push({
        rule: "bind-outside-base",
        severity: HARDENING_RULE_SEVERITY["bind-outside-base"],
        detail:
          `${bind} (allowed only below a container directory, ` +
          `i.e. ${options.bindBasePath}/<name>/<...>)`,
        hostPath: normalizedHostPath
      });
    } else if (
      // Protected container: inside the base path, but in a neighbour's
      // directory.
      options.secureUniverse &&
      hostPath.startsWith("/") &&
      !isInsideUniverse(hostPath, options.secureUniverse)
    ) {
      violations.push({
        rule: "bind-outside-universe",
        severity: HARDENING_RULE_SEVERITY["bind-outside-universe"],
        detail:
          `${bind} (protected container: allowed only below its own ` +
          `directory ${options.secureUniverse}/<...>)`,
        hostPath: normalizedHostPath
      });
    }
  }

  if (container.privileged) {
    violations.push({ rule: "privileged", severity: HARDENING_RULE_SEVERITY["privileged"], detail: "privileged=true" });
  }

  // A single capability is a notice; services such as VPN clients need
  // NET_ADMIN. privileged grants the whole set and is a delegation lock.
  for (const capability of container.capAdd) {
    if (FORBIDDEN_CAPABILITIES.has(normalizeCapability(capability))) {
      violations.push({ rule: "dangerous-capability", severity: HARDENING_RULE_SEVERITY["dangerous-capability"], detail: capability });
    }
  }

  for (const [label, mode] of [
    ["pid", container.pidMode],
    ["ipc", container.ipcMode],
    ["network", container.networkMode]
  ] as const) {
    if (mode === "host") {
      violations.push({ rule: "host-namespace", severity: HARDENING_RULE_SEVERITY["host-namespace"], detail: `${label}=host` });
    }
  }

  for (const option of container.securityOpt) {
    const normalized = option.toLowerCase().replace(/\s+/g, "");
    if (normalized === "apparmor=unconfined" || normalized === "apparmor:unconfined") {
      violations.push({ rule: "apparmor-or-seccomp-disabled", severity: HARDENING_RULE_SEVERITY["apparmor-or-seccomp-disabled"], detail: option });
    }
    if (normalized === "seccomp=unconfined" || normalized === "seccomp:unconfined") {
      violations.push({ rule: "apparmor-or-seccomp-disabled", severity: HARDENING_RULE_SEVERITY["apparmor-or-seccomp-disabled"], detail: option });
    }
  }

  if (container.devices.length > 0) {
    // A notice: hardware transcoding needs /dev/dri.
    violations.push({
      rule: "device-passthrough",
      severity: HARDENING_RULE_SEVERITY["device-passthrough"],
      detail: container.devices.join(", ")
    });
  }

  // Operational hygiene from here on: notices that block nothing.

  if (!hasNoNewPrivileges(container.securityOpt)) {
    violations.push({
      rule: "no-new-privileges-missing",
      severity: HARDENING_RULE_SEVERITY["no-new-privileges-missing"],
      detail: "security_opt: no-new-privileges:true missing"
    });
  }

  // Without cap_drop: ALL the container keeps Docker's default set, and
  // cap_add is no longer a deliberate exception.
  if (!container.capDrop.some((capability) => normalizeCapability(capability) === "ALL")) {
    violations.push({
      rule: "capabilities-not-dropped",
      severity: HARDENING_RULE_SEVERITY["capabilities-not-dropped"],
      detail: "cap_drop: ALL missing"
    });
  }

  const missingLimits: string[] = [];
  if (container.memoryLimitBytes <= 0) missingLimits.push("Memory");
  if (!container.cpuLimited) missingLimits.push("CPU");
  if (container.pidsLimit === null || container.pidsLimit <= 0) missingLimits.push("PIDs");
  if (missingLimits.length > 0) {
    violations.push({
      rule: "resource-limit-missing",
      severity: HARDENING_RULE_SEVERITY["resource-limit-missing"],
      detail: `no limit: ${missingLimits.join(", ")}`
    });
  }

  // An availability risk like missing limits: the log can fill the disk.
  if (isLoggingUnlimited(container.logDriver, container.logOptions)) {
    violations.push({
      rule: "logging-unbounded",
      severity: HARDENING_RULE_SEVERITY["logging-unbounded"],
      detail: `${container.logDriver || "json-file"} without max-size`
    });
  }

  return violations;
}

export function hardeningReport(
  container: InspectedContainer,
  options: HardeningOptions = {}
): HardeningReport {
  const violations = findHardeningViolations(container, options);
  return {
    delegationLock: violations.filter((violation) => violation.severity === "delegation-lock"),
    warning: violations.filter((violation) => violation.severity === "warning"),
    hint: violations.filter((violation) => violation.severity === "notice")
  };
}

// Whether the container carries a delegation lock, the condition under which
// the gate (runtime/gate.ts, via hardeningReport) refuses mutating actions
// outside the internal tier.
export function hasDelegationLock(
  container: InspectedContainer,
  options: HardeningOptions = {}
): boolean {
  return findHardeningViolations(container, options).some(
    (violation) => violation.severity === "delegation-lock"
  );
}

// The self-check (spec.ts, compose-apply.ts, raw-apply.ts) asks a different
// question than operation: may this be created or newly introduced? It covers
// the delegation lock, sensitive host paths and both bind allowlist rules,
// which guard where data may live. Hygiene, devices and capabilities stay
// notices and block no creation.
const SELF_CHECK_RULES: readonly HardeningRule[] = [
  ...DELEGATION_LOCK_RULES,
  "sensitive-host-path",
  "bind-outside-base",
  "bind-outside-universe"
];

export function selfCheckViolations(
  container: InspectedContainer,
  options: HardeningOptions = {}
): HardeningViolation[] {
  return findHardeningViolations(container, options).filter((violation) =>
    (SELF_CHECK_RULES as readonly string[]).includes(violation.rule)
  );
}

// Deduplicated rule names without details: details name host paths and stay
// with privileged readers, the names may go to every viewer. Without details
// two findings of one rule would read as the same name twice.
export function hardeningRuleNames(
  container: InspectedContainer,
  options: HardeningOptions = {}
): {
  delegationLock: HardeningRule[];
  warning: HardeningRule[];
  hint: HardeningRule[];
} {
  const report = hardeningReport(container, options);
  const namesOf = (violations: HardeningViolation[]): HardeningRule[] => [
    ...new Set(violations.map((violation) => violation.rule))
  ];
  return {
    delegationLock: namesOf(report.delegationLock),
    warning: namesOf(report.warning),
    hint: namesOf(report.hint)
  };
}

function hasNoNewPrivileges(securityOpt: string[]): boolean {
  return securityOpt.some((option) => {
    const normalized = option.toLowerCase().replace(/\s+/g, "").replace(/=/g, ":");
    return normalized === "no-new-privileges:true";
  });
}
