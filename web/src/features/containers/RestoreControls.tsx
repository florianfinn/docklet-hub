import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { UPDATE_START_DEADLINE_SECONDS, type BackupEntry, type FileSource, type RestorePreviewResponse, type RestoreProgress } from "contract";
import { Button } from "../../platform/ui/shadcn/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../../platform/ui/shadcn/dialog";
import { errorCode } from "../../platform/http/transport";
import { useLifecycleState } from "./use-lifecycle";
import { runtimeBlocker, intentTarget, sameTarget, targetName, type LifecycleTarget } from "./lifecycle-state";
import { fetchBackups, fetchRestoreSources, previewRestore, startRestore, fetchRestoreJobs } from "./api";
import { cancelUpdate, fetchUpdateSetting } from "./api";
import { BACKUP_REASON_MESSAGES, RESTORE_PHASE_MESSAGES } from "./backup-messages";

export function RestoreControls({ target }: { target: Extract<LifecycleTarget, { kind: "container" }> }) {
  const t = useTranslations(); const client = useQueryClient(); const { host, role, busy, operations } = useLifecycleState(target);
  const scope = intentTarget(target.container); const name = targetName(target);
  const [selection, setSelection] = useState<{ backups: BackupEntry[]; sources: FileSource[] } | null>(null);
  const [backupId, setBackupId] = useState(""); const [mounts, setMounts] = useState<string[]>([]);
  const [preview, setPreview] = useState<RestorePreviewResponse | null>(null); const [error, setError] = useState<{ code: string | null } | null>(null);
  const [deadline, setDeadline] = useState<number>(UPDATE_START_DEADLINE_SECONDS.default);
  const owned = useRef(false); const submittedAt = useRef(Infinity);
  const key = ["restore-jobs", target.hostId];
  const jobs = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchRestoreJobs(target.hostId, signal),
    enabled: runtimeBlocker(target, host, role, false) === null, refetchInterval: 2000 });
  const all = [...jobs.data?.active ?? [], ...jobs.data?.recent ?? []].filter((job): job is RestoreProgress => job.kind === "restore" && sameTarget(job.target, scope));
  const active = all.find((job) => job.phase !== "completed"); const recent = all.find((job) => job.phase === "completed");
  const release = () => { if (owned.current) { operations.update(target, { busy: false }); operations.clear(target); owned.current = false; } };
  useEffect(() => () => { if (owned.current) { operations.update(target, { busy: false }); operations.clear(target); owned.current = false; } }, [target, operations]);
  useEffect(() => {
    if (active && !owned.current && operations.reserve(target)) { owned.current = true; submittedAt.current = 0; }
    else if (!active && owned.current && jobs.dataUpdatedAt >= submittedAt.current) {
      operations.update(target, { busy: false }); operations.clear(target); owned.current = false;
      void client.invalidateQueries({ queryKey: ["containers"] });
    }
  }, [active, target, operations, jobs.dataUpdatedAt, client]);
  const failed = (caught: unknown) => setError({ code: errorCode(caught) });
  const reason = (code: string | null) => {
    const message = code === null ? undefined : BACKUP_REASON_MESSAGES[code];
    return t(message === undefined ? "updateErrorGeneric" : message);
  };
  const load = useMutation({ mutationFn: async () => {
    if (!operations.reserve(target)) throw new Error("busy"); owned.current = true; submittedAt.current = Infinity; setError(null);
    const [backups, sources, setting] = await Promise.all([fetchBackups(target.hostId, target.container.id),
      fetchRestoreSources(target.hostId, target.container.id), fetchUpdateSetting(target.hostId, target.container.id, scope)]);
    setDeadline(setting.startDeadlineSeconds);
    return { backups: backups.backups, sources: sources.sources };
  }, onSuccess: (value) => { setSelection(value); setBackupId(value.backups[0]?.backupId ?? ""); setMounts([]); },
  onError: (caught) => { failed(caught); release(); } });
  const prepare = useMutation({ mutationFn: () => previewRestore(target.hostId, { target: scope, backupId, mounts: mounts.map((sourceId) => ({ sourceId })) }),
    onSuccess: setPreview, onError: failed });
  const start = useMutation({ mutationFn: () => startRestore(target.hostId, { target: scope, backupId: preview!.backupId,
    mounts: preview!.mounts, expectedContainer: preview!.expectedContainer, previewId: preview!.previewId, confirmed: true, startDeadlineSeconds: deadline }),
    onSuccess: () => { setPreview(null); setSelection(null); submittedAt.current = Date.now(); operations.update(target, { busy: true, phase: "running" }); void client.invalidateQueries({ queryKey: key }); },
    onError: (caught) => { failed(caught); setPreview(null); setSelection(null); release(); } });
  const cancel = useMutation({ mutationFn: () => cancelUpdate(target.hostId, active!.jobId), onSuccess: () => { void client.invalidateQueries({ queryKey: key }); }, onError: failed });
  const disabled = Boolean(runtimeBlocker(target, host, role, busy) || active || load.isPending || target.container.externalManagement);
  const backup = selection?.backups.find((entry) => entry.backupId === backupId);
  return <div className="space-y-2">
    <Button variant="outline" disabled={disabled} onClick={() => load.mutate()}>{t("restoreAction")}</Button>
    {error && !selection ? <p role="alert">{reason(error.code)}</p> : null}
    {active ? <div role="status"><p>{t("restoreProgress", { phase: t(RESTORE_PHASE_MESSAGES[active.phase]) })}</p>
      <Button variant="outline" disabled={!active.cancelAllowed || cancel.isPending} onClick={() => cancel.mutate()}>{t("updateAbort")}</Button>
      {!active.cancelAllowed ? <p>{t("restoreCancelBoundary")}</p> : null}</div> : null}
    {!active && recent?.result ? <div role={recent.result.outcome === "failed" ? "alert" : "status"}>
      <p>{t(recent.result.outcome === "restored" ? "restoreCompleted" : recent.result.outcome === "cancelled" ? "updateOutcomeCancelled" : "restoreFailed")}</p>
      {recent.result.restoreError ? <p>{t("restoreFailure", { reason: reason(recent.result.restoreError) })}</p> : null}
      {recent.result.resumeError ? <p>{t("restoreResumeFailure", { reason: reason(recent.result.resumeError) })}</p> : null}
      <p>{t("restoreState", { state: recent.result.state.status })}</p>
    </div> : null}
    <Dialog open={selection !== null} onOpenChange={(open) => { if (!open && !start.isPending) { setSelection(null); setPreview(null); release(); } }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogTitle>{t("restoreTitle", { target: name })}</DialogTitle>
        <DialogDescription>{t("restoreDescription")}</DialogDescription>
        {error ? <p role="alert">{reason(error.code)}</p> : null}
        {preview ? <>
          <p>{preview.backup.completedAt} · {t(preview.backup.mode === "stop" ? "backupModeStop" : "backupModeLive")}</p>
          {preview.targets.map((source) => <p key={source.sourceId}>{source.source} → {source.target} · {t("backupBytes", {
            bytes: preview.backup.archives.find((archive) => archive.sourceId === source.sourceId)!.bytes })}</p>)}
          <p>{t("backupConsistencyWarning")}</p>
        </> : <>
          {!selection?.backups.length ? <p>{t("restoreEmpty")}</p> : <label>{t("restoreBackup")} <select value={backupId} onChange={(event) => { setBackupId(event.target.value); setMounts([]); }}>
            {selection.backups.map((entry) => <option key={entry.backupId} value={entry.backupId}>{entry.completedAt} · {t(entry.mode === "stop" ? "backupModeStop" : "backupModeLive")}</option>)}
          </select></label>}
          {backup?.archives.map((archive) => {
            const source = selection?.sources.find((item) => item.sourceId === archive.sourceId);
            return <div key={archive.sourceId}><label><input type="checkbox" disabled={!source?.restoreEligible}
              checked={mounts.includes(archive.sourceId)} onChange={(event) => setMounts((items) => event.target.checked ? [...items, archive.sourceId] : items.filter((id) => id !== archive.sourceId))} />
              {source?.source ?? t("updateUnknown")} → {archive.mountTarget} · {t("backupBytes", { bytes: archive.bytes })}</label>
              {!source?.restoreEligible ? <p>{reason(source?.writeBlocker ?? null)}</p> : null}</div>;
          })}
        </>}
        <DialogFooter><Button variant="outline" disabled={start.isPending} onClick={() => { setSelection(null); setPreview(null); release(); }}>{t("lifecycleCancel")}</Button>
          {preview ? <Button disabled={start.isPending} onClick={() => start.mutate()}>{t("restoreConfirm")}</Button>
            : <Button disabled={!mounts.length || prepare.isPending} onClick={() => prepare.mutate()}>{t("restorePreview")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
