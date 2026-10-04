import { useTranslations } from "use-intl";

import type { HardeningFinding } from "contract";

import { findingsOf, ruleKeysOf } from "./hardening-findings";

// Hardening findings with the explanation of their rule (#8). Without
// `checked` the list only informs; with it, every finding is confirmed on its
// own, so the operator sees service, rule and subject of what they accept.

export function HardeningFindings({
  findings,
  checked,
  onToggle,
  testId
}: {
  findings: readonly string[];
  checked?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  testId: string;
}) {
  const t = useTranslations();
  const entries = findingsOf(findings);
  if (entries.length === 0) return null;
  const locked = entries.some((entry) => entry.severity === "delegation-lock");

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li key={entry.key} className="flex gap-2" data-testid={`${testId}-item`}>
            {checked !== undefined && onToggle !== undefined ? (
              <input
                type="checkbox"
                className="mt-1"
                aria-label={t("hardeningConfirmFinding", { service: entry.service || "—" })}
                data-testid={`${testId}-check-${entry.key}`}
                checked={checked.has(entry.key)}
                onChange={() => onToggle(entry.key)}
              />
            ) : null}
            <FindingText finding={entry} />
          </li>
        ))}
      </ul>
      {locked ? (
        <p className="text-[12px] text-state-warn" data-testid={`${testId}-delegation-lock`}>
          {t("hardeningDelegationLockNote")}
        </p>
      ) : null}
    </div>
  );
}

function FindingText({ finding }: { finding: HardeningFinding }) {
  const t = useTranslations();
  const keys = ruleKeysOf(finding);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className={severityClass(finding)}>{severityText(t, finding)}</span>
        <span className="font-medium">{keys === null ? finding.rule : t(keys.title)}</span>
        {finding.service ? (
          <span className="text-muted-foreground">{t("hardeningService", { service: finding.service })}</span>
        ) : null}
      </p>
      {finding.subject ? <p className="break-all font-mono text-[12px]">{finding.subject}</p> : null}
      <p className="text-[12px] text-muted-foreground">
        {keys === null ? t("hardeningRuleUnknownText") : t(keys.explanation)}
      </p>
    </div>
  );
}

function severityClass(finding: HardeningFinding): string {
  const base = "text-[12px] font-medium";
  if (finding.severity === "delegation-lock") return `${base} text-destructive`;
  if (finding.severity === "warning") return `${base} text-state-warn`;
  return `${base} text-muted-foreground`;
}

function severityText(t: ReturnType<typeof useTranslations>, finding: HardeningFinding): string {
  switch (finding.severity) {
    case "delegation-lock":
      return t("hardeningSeverityDelegationLock");
    case "warning":
      return t("hardeningSeverityWarning");
    case "notice":
      return t("hardeningSeverityNotice");
    default:
      return t("hardeningSeverityUnknown");
  }
}
