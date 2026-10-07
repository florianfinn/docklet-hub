import { useId, useCallback } from "react";
import { useTranslations } from "use-intl";
import { Button } from "../../platform/ui/shadcn/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../../platform/ui/shadcn/dialog";
import { ACTIONS, runtimeBlocker, actionBlocker, effectiveDefinition, targetName, targetKey, type LifecycleTarget } from "./lifecycle-state";
import { ACTION_MESSAGES, BLOCKER_MESSAGES } from "./lifecycle-messages";
import { useLifecycleAction, useLifecycleState } from "./use-lifecycle";
import { LifecycleNotice } from "./LifecycleNotice";
import { LifecycleStatus } from "./LifecycleStatus";
import { MaintenanceControls } from "./MaintenanceControls";

export function LifecycleControls({ target, detail = false }: { target: LifecycleTarget; detail?: boolean }) {
  const t = useTranslations();
  const descriptionId = useId();
  const { host, role, operation, busy, operations } = useLifecycleState(target);
  const action = useLifecycleAction(target);
  const blocker = runtimeBlocker(target, host, role, busy);
  const definition = effectiveDefinition(target, host);
  const name = targetName(target);
  const key = targetKey(target);
  const dismiss = useCallback(() => operations.clear(key), [operations, key]);
  const question = action.question;
  const questionDefinition = question?.target.kind === "stack" && question.context?.hubOwned && question.context.applyDefinition;
  const label = (kind: typeof ACTIONS[number], apply = definition) => t(kind === "start" && apply ? "lifecycleStartDefinition" :
    kind === "restart" && apply ? "lifecycleRestartDefinition" : ACTION_MESSAGES[kind]);
  return <div className="w-full space-y-2 px-2.5 py-1.5" data-lifecycle={name}>
    <div role="group" aria-label={t("lifecycleActions", { target: name })} className="flex flex-wrap items-start gap-2">
      {ACTIONS.map((kind) => {
        const reason = blocker ?? actionBlocker(target, kind);
        return <div key={kind} className="max-w-full">
          <Button type="button" variant="outline" className="min-h-11 min-w-11 text-xs"
            aria-label={t("lifecycleActionFor", { action: label(kind), target: name })}
            aria-disabled={reason !== null} aria-describedby={reason ? `${descriptionId}-${kind}` : undefined}
            data-action={kind} onClick={() => { if (!reason) void action.prepare(kind); }}>
            {label(kind)}
          </Button>
          {reason ? <span id={`${descriptionId}-${kind}`} className="block max-w-56 text-xs text-muted-foreground">
            {t(BLOCKER_MESSAGES[reason])}
          </span> : null}
        </div>;
      })}
      <MaintenanceControls target={target} detail={detail} reload={action.reload} />
    </div>
    <LifecycleStatus target={target} reload={action.reload} />
    <LifecycleNotice operation={operation} dismiss={dismiss} reload={() => { void action.reload().catch(() => undefined); }} />
    <Dialog open={question !== null} onOpenChange={(open) => { if (!open) action.cancel(); }}>
      {question ? <DialogContent>
        <DialogTitle>{t("lifecycleConfirmTitle", { action: label(question.action, Boolean(questionDefinition)), target: targetName(question.target) })}</DialogTitle>
        <DialogDescription>{t(question.changed ? "lifecycleConfirmChanged" : questionDefinition && question.action === "restart" ? "lifecycleConfirmRecreate" : "lifecycleConfirmRuntime")}</DialogDescription>
        {question.changed && questionDefinition && question.action === "restart" ? <p>{t("lifecycleConfirmRecreate")}</p> : null}
        <p>{t("lifecycleConfirmServices")}</p>
        <ul className="max-h-64 overflow-y-auto">
          {question.context ? question.context.services.map((service) => <li key={service.serviceName}>
            {t("lifecycleServiceState", { service: service.serviceName, status: service.status })}
          </li>) : <li>{t("lifecycleServiceState", { service: targetName(question.target), status: question.target.kind === "container" ? question.target.container.status : "" })}</li>}
        </ul>
        <DialogFooter>
          <Button className="min-h-11" variant="outline" onClick={action.cancel}>{t("lifecycleCancel")}</Button>
          <Button className="min-h-11" onClick={() => { void action.confirm(); }}>{t("lifecycleConfirm")}</Button>
        </DialogFooter>
      </DialogContent> : null}
    </Dialog>
  </div>;
}
