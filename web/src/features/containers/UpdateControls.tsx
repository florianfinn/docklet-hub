import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { UPDATE_START_DEADLINE_SECONDS, type UpdatePreviewResponse, type UpdateProgress } from "contract";
import { Button } from "../../platform/ui/shadcn/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../../platform/ui/shadcn/dialog";
import { errorCode } from "../../platform/http/transport";
import { useLifecycleState } from "./use-lifecycle";
import { runtimeBlocker, maintenanceTarget, intentTarget, sameTarget, targetContainers, targetName, type LifecycleTarget } from "./lifecycle-state";
import { fetchUpdateJobs, previewUpdate, startUpdate, cancelUpdate, fetchUpdateSetting, saveUpdateSetting } from "./api";
import { UPDATE_REASON_MESSAGES, UPDATE_PHASE_MESSAGES, UPDATE_OUTCOME_MESSAGES } from "./update-messages";

export function UpdateControls({ target, detail = false }: { target: LifecycleTarget; detail?: boolean }) {
  const t = useTranslations(); const client = useQueryClient();
  const { host, role, busy, operations } = useLifecycleState(target);
  const scope = maintenanceTarget(target); const name = targetName(target);
  const [preview, setPreview] = useState<UpdatePreviewResponse | null>(null);
  const [deadline, setDeadline] = useState<string>("");
  const [error, setError] = useState<{ code: string | null } | null>(null);
  const reserved = useRef(false);
  const jobsKey = ["update-jobs", target.hostId];
  const jobs = useQuery({ queryKey: jobsKey, queryFn: ({ signal }) => fetchUpdateJobs(target.hostId, signal),
    enabled: runtimeBlocker(target, host, role, false) === null, refetchInterval: 2000 });
  const all = [...jobs.data?.active ?? [], ...jobs.data?.recent ?? []].filter((job): job is UpdateProgress => job.kind === "update");
  const active = all.find((job) => job.phase !== "completed" && (sameTarget(job.target, scope)
    || job.target.kind === "stack" && targetContainers(target).some((c) => c.compose?.project === (job.target.kind === "stack" ? job.target.projectName : null))));
  const recent = all.find((job) => job.phase === "completed" && sameTarget(job.target, scope));
  useEffect(() => () => {
    if (reserved.current) { operations.update(target, { busy: false }); operations.clear(target); reserved.current = false; }
  }, [operations, target]);
  const ownedActive = useRef(false);
  const submittedAt = useRef(Infinity);
  useEffect(() => {
    if (active) {
      if (!ownedActive.current && operations.reserve(target)) { ownedActive.current = true; submittedAt.current = 0; }
    } else if (ownedActive.current && jobs.dataUpdatedAt >= submittedAt.current) {
      operations.update(target, { busy: false, phase: "done" }); operations.clear(target); ownedActive.current = false; submittedAt.current = Infinity;
      void client.invalidateQueries({ queryKey: ["containers"] });
    }
  }, [active, operations, target, client, jobs.dataUpdatedAt]);
  const first = targetContainers(target)[0];
  const settingKey = ["update-setting", target.hostId, first?.name];
  const setting = useQuery({ queryKey: settingKey,
    queryFn: ({ signal }) => fetchUpdateSetting(target.hostId, first.id, intentTarget(first), signal),
    enabled: detail && target.kind === "container" && runtimeBlocker(target, host, role, false) === null });
  const foreign = targetContainers(target).some((container) => container.externalManagement !== null && container.externalManagement !== undefined);
  const blocker = runtimeBlocker(target, host, role, busy);
  const reason = (code: string | null) => {
    const message = code === null ? undefined : UPDATE_REASON_MESSAGES[code];
    return t(message === undefined ? "updateErrorGeneric" : message);
  };
  const release = () => { if (reserved.current) { operations.update(target, { busy: false }); operations.clear(target); reserved.current = false; } };
  const prepare = useMutation({ mutationFn: async () => {
    if (!operations.reserve(target)) throw new Error("busy"); reserved.current = true; setError(null);
    return previewUpdate(target.hostId, { target: scope, services: targetContainers(target).map((container) => ({
      target: intentTarget(container), expectedContainer: { containerId: container.id, status: container.status, startedAt: container.startedAt },
      startDeadlineSeconds: UPDATE_START_DEADLINE_SECONDS.default, backup: null
    })) });
  }, onSuccess: setPreview, onError: (caught) => { setError({ code: errorCode(caught) }); release(); } });
  const start = useMutation({ mutationFn: async () => {
    if (!preview || preview.services.some((service) => service.blocker || !service.offeredDigest)) throw new Error("blocked");
    return startUpdate(target.hostId, { target: preview.target, previewId: preview.previewId, confirmed: true,
      services: preview.services.map((service) => ({ target: service.target, expectedContainer: service.expectedContainer,
        startDeadlineSeconds: service.startDeadlineSeconds, backup: null, offeredDigest: service.offeredDigest!, definitionHash: service.definitionHash })) });
  }, onSuccess: () => { setPreview(null); reserved.current = false; ownedActive.current = true; submittedAt.current = Date.now(); operations.update(target, { busy: true, phase: "running" }); void client.invalidateQueries({ queryKey: jobsKey }); },
  onError: (caught) => { setError({ code: errorCode(caught) }); setPreview(null); release(); void client.invalidateQueries({ queryKey: jobsKey }); } });
  const cancel = useMutation({ mutationFn: () => cancelUpdate(target.hostId, active!.jobId),
    onSuccess: () => { void client.invalidateQueries({ queryKey: jobsKey }); }, onError: (caught) => setError({ code: errorCode(caught) }) });
  const save = useMutation({ mutationFn: () => saveUpdateSetting(target.hostId, first.id, intentTarget(first), { startDeadlineSeconds: Number(deadline) }),
    onSuccess: () => { setDeadline(""); void client.invalidateQueries({ queryKey: settingKey }); }, onError: (caught) => setError({ code: errorCode(caught) }) });

  const disabled = Boolean(blocker || foreign || active || prepare.isPending || start.isPending);
  const blockedPreview = preview?.services.some((service) => service.blocker !== null || service.offeredDigest === null);
  return <div className="space-y-2" data-update={name}>
    <Button variant="outline" className="min-h-11" aria-disabled={disabled}
      aria-label={t("updateActionFor", { target: name })} onClick={() => { if (!disabled) prepare.mutate(); }}>{t("updateAction")}</Button>
    {foreign ? <p className="text-xs">{t("updateForeign")}</p> : null}
    {error ? <p role="alert">{reason(error.code)}</p> : null}
    {detail && target.kind === "container" && setting.data ? <form className="flex flex-wrap gap-2 items-center"
      onSubmit={(event) => { event.preventDefault(); if (!disabled && deadline) save.mutate(); }}>
      <label>{t("updateStartDeadline")} <input type="number" min={UPDATE_START_DEADLINE_SECONDS.min} max={UPDATE_START_DEADLINE_SECONDS.max}
        value={deadline || setting.data.startDeadlineSeconds} onChange={(event) => setDeadline(event.target.value)} disabled={disabled}
        className="w-24 border rounded p-2" /></label>
      <Button type="submit" variant="outline" disabled={disabled || !deadline || save.isPending}>{t("updateSave")}</Button>
    </form> : null}
    {active ? <div role="status" aria-live="polite">
      <p>{t("updateProgress", { service: active.service?.kind === "compose" ? active.service.serviceName : name,
        phase: t(UPDATE_PHASE_MESSAGES[active.phase]) })}</p>
      <Button variant="outline" disabled={!active.cancelAllowed || cancel.isPending} onClick={() => cancel.mutate()}>{t("updateAbort")}</Button>
      {!active.cancelAllowed ? <p className="text-xs">{t("updateCancelBoundary")}</p> : null}
    </div> : null}
    {!active && recent?.result ? <div role={recent.result.updateError ? "alert" : "status"}>
      <p>{t(UPDATE_OUTCOME_MESSAGES[recent.result.outcome])}</p>
      {recent.result.services.map((service) => <div key={JSON.stringify(service.target)}>
        <p>{service.target.kind === "compose" ? service.target.serviceName : service.target.containerName}: {t(UPDATE_OUTCOME_MESSAGES[service.outcome])}</p>
        {service.updateError ? <p>{t("updateFailure", { reason: reason(service.updateError) })}</p> : null}
        {service.rollbackError ? <p>{t("updateRollbackFailure", { reason: reason(service.rollbackError) })}</p> : null}
      </div>)}
      {recent.result.updateError ? <p>{t("updateFailure", { reason: reason(recent.result.updateError) })}</p> : null}
    </div> : null}
    <Dialog open={preview !== null} onOpenChange={(open) => { if (!open && !start.isPending) { setPreview(null); release(); } }}>
      {preview ? <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>{t("updateConfirmTitle", { target: name })}</DialogTitle>
        <DialogDescription>{t("updateConfirmDescription")}</DialogDescription>
        <p>{t("updateBackupUnavailable")}</p>
        {preview.services.map((service) => <div key={JSON.stringify(service.target)} className="space-y-1 border-b py-2">
          <p>{service.target.kind === "compose" ? service.target.serviceName : service.target.containerName}</p>
          <p className="break-all">{t("updateCurrentDigest", { digest: service.currentDigest ?? t("updateUnknown") })}</p>
          <p className="break-all">{t("updateOfferedDigest", { digest: service.offeredDigest ?? t("updateUnknown") })}</p>
          <p>{t("updateDeadlineSeconds", { seconds: service.startDeadlineSeconds })}</p>
          <p className="break-all">{t("updateRollbackImage", { image: service.rollbackImageId ?? t("updateUnknown") })}</p>
          {service.warnings.map((warning) => <p key={warning}>{t(UPDATE_REASON_MESSAGES[warning] ?? "updateDataWarning")}</p>)}
          {service.blocker ? <p role="alert">{reason(service.blocker)}</p> : null}
        </div>)}
        <DialogFooter>
          <Button variant="outline" disabled={start.isPending} onClick={() => { setPreview(null); release(); }}>{t("lifecycleCancel")}</Button>
          <Button disabled={blockedPreview || start.isPending} onClick={() => start.mutate()}>{t("updateConfirm")}</Button>
        </DialogFooter>
      </DialogContent> : null}
    </Dialog>
  </div>;
}
