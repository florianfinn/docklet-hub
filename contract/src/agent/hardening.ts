// The vocabulary of the agent's hardening check (agent/src/hardening.ts). The
// agent decides which rule a container violates; the hub only explains the
// rules it names and never derives a rating of its own.

export const HARDENING_RULES = [
  "docker-socket-mount",
  "dashboard-self-mount",
  "volume-unresolved",
  "bind-outside-base",
  "bind-outside-universe",
  "privileged",
  "dangerous-capability",
  "host-namespace",
  "sensitive-host-path",
  "device-passthrough",
  "apparmor-or-seccomp-disabled",
  "no-new-privileges-missing",
  "capabilities-not-dropped",
  "resource-limit-missing",
  "logging-unbounded"
] as const;
export type HardeningRule = (typeof HARDENING_RULES)[number];

// "delegation-lock": the container effectively is the host; the agent reports
// and audits mutating actions on it but does not block them. "warning": a
// host system directory is mounted. "notice": hygiene, blocks nothing.
export const HARDENING_SEVERITIES = ["delegation-lock", "warning", "notice"] as const;
export type HardeningSeverity = (typeof HARDENING_SEVERITIES)[number];

export const HARDENING_RULE_SEVERITY: Readonly<Record<HardeningRule, HardeningSeverity>> = {
  "docker-socket-mount": "delegation-lock",
  "dashboard-self-mount": "delegation-lock",
  "volume-unresolved": "delegation-lock",
  privileged: "delegation-lock",
  "host-namespace": "delegation-lock",
  "sensitive-host-path": "warning",
  "bind-outside-base": "notice",
  "bind-outside-universe": "notice",
  "dangerous-capability": "notice",
  "device-passthrough": "notice",
  "apparmor-or-seccomp-disabled": "notice",
  "no-new-privileges-missing": "notice",
  "capabilities-not-dropped": "notice",
  "resource-limit-missing": "notice",
  "logging-unbounded": "notice"
};

export const DELEGATION_LOCK_RULES: readonly HardeningRule[] = HARDENING_RULES.filter(
  (rule) => HARDENING_RULE_SEVERITY[rule] === "delegation-lock"
);

export function isHardeningRule(value: string): value is HardeningRule {
  return (HARDENING_RULES as readonly string[]).includes(value);
}

// A finding of the compose paths travels as "service:rule<separator>subject";
// the agent formats it (agent/src/hardening.ts, violationValue), and every new
// finding must appear verbatim in the acknowledgement; extra entries do not
// matter. The parser finds the rule by this vocabulary, not the separator.
export type HardeningFinding = {
  key: string;
  service: string;
  // The rule as the agent wrote it; `null` severity when this contract does
  // not know it (a newer agent), so the caller shows it verbatim.
  rule: string;
  severity: HardeningSeverity | null;
  subject: string;
};

const RULE_CHARACTER = /[a-z0-9-]/;
// The separator: whitespace, one run of punctuation, whitespace.
const LEADING_SEPARATOR = /^\s+[^\sA-Za-z0-9]+\s+/;

// Compose service names cannot contain ":", so the first one ends the service.
export function parseHardeningFinding(key: string): HardeningFinding {
  const colon = key.indexOf(":");
  const service = colon < 0 ? "" : key.slice(0, colon);
  const rest = colon < 0 ? key : key.slice(colon + 1);
  const known = HARDENING_RULES.find(
    (rule) => rest.startsWith(rule) && !RULE_CHARACTER.test(rest.charAt(rule.length))
  );
  const rule = known ?? rest.split(/\s/, 1)[0] ?? "";
  return {
    key,
    service,
    rule,
    severity: known === undefined ? null : HARDENING_RULE_SEVERITY[known],
    subject: rest.slice(rule.length).replace(LEADING_SEPARATOR, "")
  };
}
