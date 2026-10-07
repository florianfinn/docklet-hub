import { useId } from "react";
import { useTranslations } from "use-intl";
import type { OverviewContainer, SelfHealingIncident } from "contract";
import { useLanguage } from "../../platform/i18n";
import { formatDateTime } from "../../platform/i18n/time-format";
import { Button } from "../../platform/ui/shadcn/button";
import { intentTarget, maintenanceTarget, sameTarget, targetContainers, controlsBlocker, type LifecycleTarget } from "./lifecycle-state";
import { BLOCKER_MESSAGES } from "./lifecycle-messages";
import { useLifecycleNow } from "./LifecycleProvider";
import { useLifecycleState } from "./use-lifecycle";
import { useLifecycleWrite } from "./use-lifecycle-write";
import { acknowledgeIncident } from "./api";

const ATTEMPT_MESSAGES = { pending: "lifecycleAttemptPending", ok: "lifecycleAttemptOk", failed: "lifecycleAttemptFailed", interrupted: "lifecycleAttemptInterrupted" } as const;
export function LifecycleStatus({ target, reload }: { target: LifecycleTarget; reload: () => Promise<unknown> }) {
  const t = useTranslations();
  const { language } = useLanguage();
  const { host } = useLifecycleState(target);
  const now = useLifecycleNow();
  const snapshot = host?.lifecycle;
  const maintenance = snapshot?.selfHealing?.maintenance.filter((entry) => (sameTarget(entry.target, maintenanceTarget(target)) ||
    target.kind === "container" && target.container.compose && entry.target.kind === "stack" && entry.target.projectName === target.container.compose.project) &&
    (entry.expiresAt === null || Date.parse(entry.expiresAt) > now)) ?? [];
  const time = (value: string) => formatDateTime(language, new Date(value));
  return <div className="space-y-1 text-xs break-words">
    {!snapshot?.stopIntents?.observing ? <p>{t("lifecycleObservationUnknown")}</p> : null}
    {!snapshot?.selfHealing?.observing ? <p>{t("lifecycleHealingUnknown")}</p> : null}
    {maintenance.map((entry) => <p key={JSON.stringify(entry.target)}>
      {t(entry.expiresAt === null ? "lifecycleMaintenanceUnlimited" : "lifecycleMaintenanceUntil", { time: entry.expiresAt ? time(entry.expiresAt) : "" })}
      {target.kind === "container" && entry.target.kind === "stack" ? <> · {t("lifecycleInheritedMaintenance")}</> : null}
    </p>)}
    {targetContainers(target).map((container) => {
      const intent = snapshot?.stopIntents?.observing ? snapshot.stopIntents.intents.find((entry) => sameTarget(entry.target, intentTarget(container))) : undefined;
      const stopped = container.status === "exited" || container.status === "created";
      const incident = snapshot?.selfHealing?.incidents.find((entry) => entry.closedAt === null && sameTarget(entry.target, intentTarget(container)));
      return <div key={container.name}>
        {container.status === "restarting" ? <p>{container.name} · {t("lifecycleRestarting")}</p> : null}
        {stopped && intent ? <p>{container.name} · {t("lifecycleManualStop", { time: time(intent.stoppedAt), actor: intent.actor ?? t("lifecycleActorUnknown") })}</p>
          : stopped && snapshot?.stopIntents?.observing && container.exitCode !== undefined && container.exitCode !== null && container.exitCode !== 0
            ? <p>{container.name} · {t("lifecycleCrashed", { code: container.exitCode })}</p> : null}
        {incident ? <IncidentView hostId={target.hostId} container={container} incident={incident} reload={reload} /> : null}
      </div>;
    })}
  </div>;
}
function IncidentView({ hostId, container, incident, reload }: { hostId: string; container: OverviewContainer; incident: SelfHealingIncident; reload: () => Promise<unknown> }) {
  const t = useTranslations();
  const { language } = useLanguage();
  const id = useId();
  const target: LifecycleTarget = { kind: "container", hostId, container };
  const { host, role, busy } = useLifecycleState(target);
  const write = useLifecycleWrite(target, reload);
  const reason = controlsBlocker(host, role, busy);
  return <details className="rounded-md border border-border p-2">
    <summary className="min-h-11 cursor-pointer py-3">{container.name} · {t("lifecycleIncident")}</summary>
    <p>{t("lifecycleIncidentCause", { code: incident.cause.exitCode, error: incident.cause.engineError ?? t("lifecycleNoEngineError") })}</p>
    <p>{t("lifecycleIncidentAttempts", { count: incident.attempts.length })}</p>
    <ul>{incident.attempts.map((attempt) => <li key={attempt.attempt}>{t("lifecycleAttempt", { number: attempt.attempt,
      time: formatDateTime(language, new Date(attempt.startedAt)), result: t(ATTEMPT_MESSAGES[attempt.result]) })}
      {attempt.error ? <> · {attempt.error}</> : null}
    </li>)}</ul>
    <p>{t("lifecycleIncidentRecommendation")}</p>
    <p>{t("lifecycleIncidentLogs")}</p>
    {incident.logs.available ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono">{incident.logs.lines.join("\n")}</pre>
      : <p>{t(incident.logs.reason === "redaction-unavailable" ? "lifecycleRedactionUnavailable" : "lifecycleLogsUnavailable")}</p>}
    <p>{t("lifecycleAcknowledgeEffect")}</p>
    <Button className="min-h-11" variant="outline" aria-disabled={reason !== null} aria-describedby={reason ? id : undefined}
      onClick={() => { if (!reason) void write((signal) => acknowledgeIncident(hostId, incident.target, signal)); }}>{t("lifecycleAcknowledge")}</Button>
    {reason ? <p id={id}>{t(BLOCKER_MESSAGES[reason])}</p> : null}
  </details>;
}
