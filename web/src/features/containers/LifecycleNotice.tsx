import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { Button } from "../../platform/ui/shadcn/button";
import { RESULT_MESSAGES, SERVICE_MESSAGES, BLOCKER_MESSAGES } from "./lifecycle-messages";
import type { LifecycleOperation } from "./lifecycle-operations";

const ERROR_MESSAGES = {
  "agent-read-only": BLOCKER_MESSAGES["read-only"], "observe-only": BLOCKER_MESSAGES["observe-only"],
  "not-allowlisted": BLOCKER_MESSAGES["not-allowlisted"], "self-management-locked": BLOCKER_MESSAGES["self-management-locked"],
  "runtime-host-offline": BLOCKER_MESSAGES.offline, "agent-outdated": BLOCKER_MESSAGES.capability,
  "action-queue-timeout": "lifecycleQueueTimeout"
} as const;
export function LifecycleNotice({ operation, dismiss, reload }: {
  operation: LifecycleOperation | undefined; dismiss: () => void; reload: () => void;
}) {
  const t = useTranslations();
  const transient = operation?.message === "ok" || operation?.message === "write-ok";
  useEffect(() => {
    if (!transient || operation?.busy) return;
    const timer = setTimeout(dismiss, 4_500);
    return () => clearTimeout(timer);
  }, [transient, operation?.busy, dismiss]);
  if (!operation) return null;
  const errorKey = operation.error && operation.error in ERROR_MESSAGES ? ERROR_MESSAGES[operation.error as keyof typeof ERROR_MESSAGES] : null;
  const services = operation.progress;
  return <div role={operation.message && !transient ? "alert" : "status"} aria-live="polite" className="space-y-1 text-xs break-words">
    {operation.busy ? <p>{t(operation.phase === "preparing" ? "lifecyclePreparing" : operation.phase === "waiting" ? "lifecycleWaiting" : "lifecycleRunning")}</p> : null}
    {operation.message ? <p>{t(RESULT_MESSAGES[operation.message])}</p> : null}
    {errorKey ? (<p>{t(errorKey)}</p>) : operation.error ? (<p>{t("lifecycleErrorGeneric")} {t("lifecycleErrorCode", { code: operation.error })}</p>) : null}
    {services.length > 0 ? <ul className="space-y-1">
      {services.map((service) => <li key={service.serviceName}>
        <span>{t("lifecycleServiceState", { service: service.serviceName, status: service.status })}</span>
        {" · "}{t(SERVICE_MESSAGES[service.outcome])}
        {service.outcome === "not-created-externally-managed" ? <p>{t("lifecycleNotCreatedReason")}</p> : null}
      </li>)}
    </ul> : null}
    {operation.result && "state" in operation.result ? <p>{t("lifecycleServiceState", { service: operation.target.kind === "container" ? operation.target.container.name : "", status: operation.result.state.status })}</p> : null}
    {operation.message && !operation.busy && !transient ? <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" onClick={reload}>{t("lifecycleReload")}</Button>
      <Button className="min-h-11" variant="ghost" onClick={dismiss}>{t("lifecycleDismiss")}</Button>
    </div> : null}
  </div>;
}
