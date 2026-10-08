import { useTranslations } from "use-intl";
import type { BackupOptions, UpdateServicePreview } from "contract";
import { BACKUP_REASON_MESSAGES } from "./backup-messages";

export function BackupSelection({ service, disabled, change }: { service: UpdateServicePreview; disabled: boolean; change: (options: BackupOptions | null) => void }) {
  const t = useTranslations(); const options = service.backup;
  const mode = options?.mode ?? "stop";
  return <fieldset disabled={disabled} className="space-y-2">
    <legend>{t("backupSelection")}</legend>
    <label className="mr-4"><input type="radio" name={`backup-mode-${service.expectedContainer.containerId}`} checked={mode === "stop"}
      onChange={() => { if (options) change({ ...options, mode: "stop" }); }} /> {t("backupModeStop")}</label>
    <label><input type="radio" name={`backup-mode-${service.expectedContainer.containerId}`} checked={mode === "live"} disabled={!options}
      onChange={() => { if (options) change({ ...options, mode: "live" }); }} /> {t("backupModeLive")}</label>
    <p>{t(mode === "live" ? "backupLiveWarning" : "backupConsistencyWarning")}</p>
    {service.mounts.map((mount) => <div key={mount.sourceId}>
      <label className="flex gap-2"><input type="checkbox" checked={options?.mounts.some((item) => item.sourceId === mount.sourceId) ?? false}
        disabled={!mount.backupEligible} onChange={(event) => {
          const selected = options?.mounts ?? [];
          const mounts = event.target.checked ? [...selected, { sourceId: mount.sourceId, estimatedBytes: mount.estimatedBytes }]
            : selected.filter((item) => item.sourceId !== mount.sourceId);
          change(mounts.length ? { mode, mounts } : null);
        }} /> {mount.source ?? t("updateUnknown")} → {mount.target}</label>
      <p>{t("backupBytes", { bytes: mount.estimatedBytes ?? t("updateUnknown") })}</p>
      {mount.shared ? <p>{t("backupSharedWarning")}</p> : null}
      {!mount.backupEligible ? <p>{t(BACKUP_REASON_MESSAGES[mount.writeBlocker ?? "source-protected"] ?? "backupReasonProtected")}</p>
        : mount.estimatedBytes === null ? <p>{t("backupReasonSize")}</p> : null}
    </div>)}
  </fieldset>;
}
