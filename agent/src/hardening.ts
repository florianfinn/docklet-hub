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
  // Log driver and its options (S9/K4b, §21.6). Docker's default for
  // `json-file` is NO rotation — without max-size a container log grows
  // without bound. The engine resolves the daemon default into this field at
  // creation, so it describes the actual state and not the compose file.
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
  // Allowlist for bind mounts (stage plan 3.8). If the value is missing, the
  // rule does NOT run — without configuration the check should not suddenly
  // reject everything it allowed before.
  bindBasePath?: string;
  // The own universe of a "protected" container (stage 5e, section 6.2): its
  // project directory, e.g. /home/docker/homepage. If it is set, ALL bind
  // sources must lie below exactly this path — a mount into a neighbour's
  // directory is then rejected structurally instead of merely being
  // undesirable.
  //
  // The rule is deliberately a REAL TIGHTENING of bindBasePath, not a
  // replacement: it only applies after bind-outside-base has passed, and its
  // allowed range is always a subset of the global one (the own directory is
  // one of many under the base path). A protected container can therefore
  // never mount anything a normal one would not be allowed to.
  //
  // If the value is missing, the container is "normal" — then only the global
  // base path applies, and per 6.2 a neighbour mount is explicitly a trust
  // decision of the operator, not a failure of the dashboard.
  secureUniverse?: string;
  // The host directories that carry the operation of the management on THIS
  // host (S23). If a bind reaches one of them — from below or from above —
  // the container effectively is the management and carries a delegation
  // lock.
  //
  // ⚠️ Must come from the caller, because only the caller knows the host:
  // locally these are dashboard-state/dashboard-repo, on a remote host the
  // agent's bootstrap directory (its secret and the WireGuard key live
  // there). If the value is missing, the local fallback DASHBOARD_SELF_PATHS
  // applies — never an empty list, because "nothing to protect" is always the
  // wrong assumption here.
  selfPaths?: readonly string[];
};

export function isDelegationLockRule(rule: string): boolean {
  return (DELEGATION_LOCK_RULES as readonly string[]).includes(rule);
}

export type HardeningViolation = {
  rule: HardeningRule;
  severity: HardeningSeverity;
  detail: string;
  // Only set for the bind-derived rules: the NORMALISED host path of the
  // mount, without target and mode (:ro/:rw). That is where the danger lies —
  // and the stable key for the raw editor's before/after comparison
  // (compose-raw.ts). The full `detail` remains for display; comparing it
  // would mean counting the same docker.sock as "new" as soon as only its
  // spelling changes (target path, :ro, a different Compose/Docker version on
  // recreate).
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
  // The only list that still STOPS anything — and even that only for handing
  // on (external/grant), not for the operator internally.
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

// Host paths whose mounting (even read-only) opens an operational or system
// directory. Level "warning" (S9): visible and asking for confirmation, but no
// delegation ban.
//
// The two dashboard directories are NO LONGER here but in
// isDashboardSelfMount() — they are the fourth core rule of the delegation
// lock, and that one is checked BEFORE this list.
//
// This is a denylist and therefore incomplete in principle. The reliable form
// is the allowlist from stage plan 3.8 (bind mounts only below a configured
// base path); it has been running alongside since stage 5. Until then this
// list catches the cases that actually mean host compromise.
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

// The directories that carry the operation of the dashboard itself:
// `dashboard-state` holds the secrets (among others AUTH_PROXY_*),
// `dashboard-repo` the deployed code. Whoever has one of them in a container
// can rewrite the management through which all other rights run — the same
// statement as docker.sock, just by a different route.
//
// ⚠️ ONLY A FALLBACK NOW (S23). These constants describe the LOCAL host. On a
// remote host they do not exist — there the rule therefore
// meant "never matches", and `dashboard-self-mount`, one of the five
// delegation locks, was effectively switched off: a container that mounts the
// agent's directory there would have been shareable via grant and externally
// controllable, although it can take over the agent.
//
// Since S23 the caller therefore passes in `selfPaths` (config.ts assembles
// them from its own base path AND the actual mounts of the agent container).
// The fallback remains, so that a forgetful caller behaves as before S23 —
// i.e. keeps protecting the local host — instead of checking nothing at all.
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

// Does a (normalised) bind path reach a given target — in BOTH directions?
//
// ⚠️ The second direction is the reason this function exists: a mount that
// lies ABOVE the target contains it. `/var` is not one bit more harmless than
// `/var/run/docker.sock`; it is the same plus everything else. A plain prefix
// check ("lies below") is blind to ancestors — the same lesson S9 drew for
// dashboard-self-mount and R3 later added for the socket rule.
//
// "/" is named separately: normalizePath("/") is "/", and a startsWith("//")
// would never match.
function reachesTarget(normalized: string, target: string): boolean {
  if (normalized === "/") return true;
  if (normalized === target) return true;
  if (normalized.startsWith(target + "/")) return true;
  return target.startsWith(normalized + "/");
}

// The two places where the Docker socket lives in the existing setup.
// `/var/run` is a symlink to `/run` on most hosts; both spellings occur in
// compose files.
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

// Fourth core rule of the delegation lock: does this mount reach the
// dashboard's own operational directories?
//
// ⚠️ Both directions count, and the second is the actual reason for this
// function:
//
//   1. The path IS one of the directories or lies below it
//      (/home/docker/dashboard-state/secrets).
//   2. The path lies ABOVE and therefore contains them — "/", "/home",
//      "/home/docker". A mount on "/" is not one bit more harmless than a
//      mount directly on dashboard-state; it is the same plus everything else.
//      Without this branch "/" would only have been a warning and the
//      container therefore delegable — exactly the gap a prefix list tends to
//      have.
//
// The comparison uses the NORMALISED path (PR #176): ".." and "//" are
// resolved, `:ro` and the mount target do not matter. The danger lies in the
// source, not in the spelling.
function isDashboardSelfMount(hostPath: string, selfPaths?: readonly string[]): boolean {
  if (!hostPath.startsWith("/")) return false;
  const normalized = normalizePath(hostPath);
  // An empty list counts as "not given": otherwise it would be a silent
  // off switch for the rule.
  const targets = selfPaths && selfPaths.length > 0 ? selfPaths : DASHBOARD_SELF_PATHS;
  // The same both-directions question as for the socket, hence the same
  // function (R3): two copies of this logic would be two chances to forget one
  // of them — that was exactly the finding.
  return targets.some((target) => reachesTarget(normalized, target));
}

// json-file without max-size grows without bound (§21.6). Other drivers either
// rotate on their own (`local`: 20m x 5) or hand the log off entirely (syslog,
// journald, fluentd, none) — neither is a finding.
//
// An empty driver name is treated like json-file: that is Docker's default,
// and the safe direction here is "rather report once too often".
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

// Allowlist (stage plan 3.8): the host path must lie STRICTLY below a
// PROJECT DIRECTORY — i.e. at least two levels below the base path.
//
// Two exclusions, both from the same idea:
//
//   /home/docker            — the base path itself. Such a mount exists on the
//                             live server, and it is exactly the case this
//                             rule is meant to catch.
//   /home/docker/<name>     — a project directory. Since stage 5c it holds
//                             the compose.yaml, i.e. the DEFINITION of the
//                             container.
//
// ⚠️ The second exclusion is the lesson from the security review of 5c
// (2026-07-21). Without it a container could mount its own project directory
// writable, rewrite its compose.yaml from inside (privileged, "/" as a volume)
// and start as a privileged container on the next recreate — host root,
// bypassing a model that explicitly has no field for privileged. The
// definition must lie outside the reach of what it defines.
//
// Data directories stay mountable (/home/docker/<name>/data), including a
// neighbour's — per 6.2 that is explicitly a trust decision of the operator.
// Survey across all 37 containers on 2026-07-21: NONE of the 48 bind sources
// under /home/docker is a project directory, so the tightening costs not a
// single existing mount.
function isInsideBasePath(hostPath: string, basePath: string): boolean {
  const normalized = normalizePath(hostPath);
  const base = normalizePath(basePath);
  if (normalized === base || !normalized.startsWith(base + "/")) return false;
  // At least "<project>/<something>" must remain.
  return normalized.slice(base.length + 1).includes("/");
}

// The own universe of a protected container (stage 5e): the path must lie
// STRICTLY below the container directory — /home/docker/homepage itself is
// excluded (the compose.yaml lives there). One level is enough:
// /home/docker/homepage/data. The second level is already enforced by
// isInsideBasePath against the global base path, which runs here in addition;
// this check only adds the binding to the container's OWN name.
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

  // A named volume that cannot be resolved must be interpreted neither as
  // "no device" nor as a harmless Docker data volume. Its actual host source
  // is unknown; externally the container therefore stays invisible and not
  // delegable until Docker delivers the inspect again.
  for (const name of new Set(container.unresolvedVolumes ?? [])) {
    violations.push({
      rule: "volume-unresolved",
      severity: HARDENING_RULE_SEVERITY["volume-unresolved"],
      detail: `volume ${name} could not be checked`
    });
  }

  for (const bind of container.binds) {
    const hostPath = hostPathOf(bind);
    // The normalised host path is the stable comparison key (see
    // HardeningViolation.hostPath). normalizePath resolves "." and "..", so
    // that "/var/run/../run/docker.sock" does not pass as a different path.
    const normalizedHostPath = normalizePath(hostPath);
    if (isDashboardSelfMount(hostPath, options.selfPaths)) {
      // Checked BEFORE the sensitive list: /home/docker/dashboard-state lies
      // below the base path and "/" would otherwise only show up as a warning.
      //
      // ⚠️ And BEFORE the socket rule, since that one also covers ancestors
      // (R3): a mount on "/" reaches both targets. Which of the two rules then
      // applies is not a security question — both are a delegation lock — but
      // one of explanation. For "/", "your own operational directories are
      // mounted in" is the sentence that tells the operator what is at stake.
      violations.push({
        rule: "dashboard-self-mount",
        severity: HARDENING_RULE_SEVERITY["dashboard-self-mount"],
        detail: bind,
        hostPath: normalizedHostPath
      });
    } else if (isDockerSocket(hostPath)) {
      // A container with the socket is host root. It is therefore never
      // delegable — it stays operable for the operator internally (§4.2).
      violations.push({
        rule: "docker-socket-mount",
        severity: HARDENING_RULE_SEVERITY["docker-socket-mount"],
        detail: bind,
        hostPath: normalizedHostPath
      });
    } else if (isSensitiveHostPath(hostPath)) {
      // The denylist beats the allowlist: /etc lies outside the base path,
      // /var/lib/docker partly inside it — both remain a finding.
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
      // Protected container (stage 5e): the bind lies within the global base
      // path (bind-outside-base has passed above), but not in its OWN
      // universe — i.e. in a neighbour's directory. For the "protected" class
      // that is exactly the escape it is meant to prevent structurally.
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

  // ⚠️ Level lowered in S9 (§4.2): tailscale carries NET_ADMIN, SYS_PTRACE and
  // SYS_ADMIN are present in the existing setup on services that are supposed
  // to run. A capability is a hint — unlike privileged, which grants the whole
  // set at once.
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
    // /dev/dri (hardware transcoding) is the reason for the lowering: a
    // passed-through device is a risk, but not one that should keep the
    // operator from their own container.
    violations.push({
      rule: "device-passthrough",
      severity: HARDENING_RULE_SEVERITY["device-passthrough"],
      detail: container.devices.join(", ")
    });
  }

  // --- From here on: operational hygiene (stage 4, level "notice" since S9) --
  // These three were already in 3.8 but missing from the implementation. They
  // report, they do not block — reasoning at HardeningSeverity.

  if (!hasNoNewPrivileges(container.securityOpt)) {
    violations.push({
      rule: "no-new-privileges-missing",
      severity: HARDENING_RULE_SEVERITY["no-new-privileges-missing"],
      detail: "security_opt: no-new-privileges:true missing"
    });
  }

  // cap_drop: ALL is the basis on which a cap_add is a deliberate exception at
  // all. Without it the container keeps the complete Docker default set, and
  // the FORBIDDEN_CAPABILITIES list above then checks a set that is not the
  // actual one.
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

  // K4b (§21.6): the same nature as resource-limit-missing — an availability
  // risk, not an escape risk. A chatty game server fills up the disk, and
  // otherwise that only shows up as "server full".
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

// Does this container carry a delegation lock? The only question that still
// decides between executing and rejecting in the agent — and even that only for
// the EXTERNAL path (§4.2). Internally it no longer stops anything.
export function hasDelegationLock(
  container: InspectedContainer,
  options: HardeningOptions = {}
): boolean {
  return findHardeningViolations(container, options).some(
    (violation) => violation.severity === "delegation-lock"
  );
}

// The rules of the SELF-CHECK (spec.ts, compose-apply.ts, raw-apply.ts).
//
// ⚠️ This is deliberately NOT the same question as the operational rule above,
// and the distinction is the core of S9:
//
//   Operation — "may I touch this existing container?" There only the
//               delegation lock still stops anything, and only externally
//               (§4.2).
//   Self      — "may THIS come into being like this, or be newly added?" The
//               relaxation from §4 applies to the EXISTING SETUP ("what is in
//               the compose as it is, no blocker") — not to creating a
//               container through a form that has no field for any of these
//               properties, and not to an edit that newly introduces them.
//
// Included are therefore all rules about the IDENTITY of the container
// (delegation lock), about SENSITIVE host paths — and the two rules of the
// bind allowlist. In operation the latter are only a hint now, but they carry
// the guarantee of the "protected" class (5e) and the convention that a
// container may not mount its own project directory (review 5c). Both are
// statements about WHERE data may live, and the dashboard should not break
// them itself when creating.
//
// NOT included: operational hygiene (limits, cap_drop, no-new-privileges,
// logging) as well as devices and capabilities. Exactly those should no
// longer stop anyone per §4 — `/dev/dri` and `NET_ADMIN` are the cases named
// explicitly.
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

// Only the rule names, without details. Details name host paths and
// capabilities and therefore only go to docker.registry.manage (intern-only);
// the names may go along with every docker.view, so that the UI can show at
// all THAT something is wrong.
// The names are deliberately DEDUPLICATED here, the detail list in
// hardeningReport() is not: two forbidden capabilities are two findings (and
// each names a different capability), but without the details the same rule
// name remains twice. Unfiltered, the response would then contain
// "dangerous-capability, dangerous-capability" and the UI would show the same
// entry twice.
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
