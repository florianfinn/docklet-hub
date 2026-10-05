import { parseHardeningFinding, type HardeningFinding, type HardeningRule } from "contract";
import type { Messages } from "use-intl";

// Hardening findings of the compose paths as text for people (#8). The agent
// names rule and subject; this module only assigns the explanation of that
// rule. A rule the contract does not know stays verbatim, without a rating.

type RuleKey = keyof Messages & `hardeningRule${string}`;

export const HARDENING_RULE_KEYS: Readonly<Record<HardeningRule, { title: RuleKey; explanation: RuleKey }>> = {
  "docker-socket-mount": { title: "hardeningRuleDockerSocket", explanation: "hardeningRuleDockerSocketText" },
  "dashboard-self-mount": { title: "hardeningRuleSelfMount", explanation: "hardeningRuleSelfMountText" },
  "volume-unresolved": { title: "hardeningRuleVolumeUnresolved", explanation: "hardeningRuleVolumeUnresolvedText" },
  privileged: { title: "hardeningRulePrivileged", explanation: "hardeningRulePrivilegedText" },
  "host-namespace": { title: "hardeningRuleHostNamespace", explanation: "hardeningRuleHostNamespaceText" },
  "sensitive-host-path": { title: "hardeningRuleSensitivePath", explanation: "hardeningRuleSensitivePathText" },
  "bind-outside-base": { title: "hardeningRuleOutsideBase", explanation: "hardeningRuleOutsideBaseText" },
  "bind-outside-universe": { title: "hardeningRuleOutsideUniverse", explanation: "hardeningRuleOutsideUniverseText" },
  "dangerous-capability": { title: "hardeningRuleCapability", explanation: "hardeningRuleCapabilityText" },
  "device-passthrough": { title: "hardeningRuleDevice", explanation: "hardeningRuleDeviceText" },
  "apparmor-or-seccomp-disabled": { title: "hardeningRuleUnconfined", explanation: "hardeningRuleUnconfinedText" },
  "no-new-privileges-missing": { title: "hardeningRuleNoNewPrivileges", explanation: "hardeningRuleNoNewPrivilegesText" },
  "capabilities-not-dropped": { title: "hardeningRuleCapDrop", explanation: "hardeningRuleCapDropText" },
  "resource-limit-missing": { title: "hardeningRuleLimits", explanation: "hardeningRuleLimitsText" },
  "logging-unbounded": { title: "hardeningRuleLogging", explanation: "hardeningRuleLoggingText" }
};

const SEVERITY_RANK = { "delegation-lock": 0, warning: 1, notice: 2 } as const;

function rankOf(finding: HardeningFinding): number {
  return finding.severity === null ? 3 : SEVERITY_RANK[finding.severity];
}

/** The agent's keys, parsed and ordered: the gravest first, then by service. */
export function findingsOf(keys: readonly string[]): HardeningFinding[] {
  return [...new Set(keys)]
    .map(parseHardeningFinding)
    .sort((a, b) => rankOf(a) - rankOf(b) || a.service.localeCompare(b.service) || a.key.localeCompare(b.key));
}

/** The text keys for a finding's rule, or `null` for a rule this hub does not know. */
export function ruleKeysOf(finding: HardeningFinding): { title: RuleKey; explanation: RuleKey } | null {
  return finding.severity === null ? null : HARDENING_RULE_KEYS[finding.rule as HardeningRule];
}

/** How many of the agent's findings are not yet confirmed one by one. */
export function unconfirmedCount(keys: readonly string[], checked: ReadonlySet<string>): number {
  return new Set(keys.filter((key) => !checked.has(key))).size;
}
