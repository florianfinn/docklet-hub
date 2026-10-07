import { useId, useState } from "react";
import { useTranslations } from "use-intl";
import { Button } from "../../platform/ui/shadcn/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../../platform/ui/shadcn/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../platform/ui/shadcn/dropdown-menu";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../platform/ui/shadcn/select";
import { Label } from "../../platform/ui/shadcn/label";
import { controlsBlocker, maintenanceTarget, sameTarget, targetName, type LifecycleTarget } from "./lifecycle-state";
import { BLOCKER_MESSAGES } from "./lifecycle-messages";
import { useLifecycleState } from "./use-lifecycle";
import { useLifecycleNow } from "./LifecycleProvider";
import { useLifecycleWrite } from "./use-lifecycle-write";
import { setMaintenance, clearMaintenance } from "./api";

export function MaintenanceControls({ target, detail, reload }: { target: LifecycleTarget; detail: boolean; reload: () => Promise<unknown> }) {
  const t = useTranslations();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState("default");
  const { host, role, busy } = useLifecycleState(target);
  const now = useLifecycleNow();
  const write = useLifecycleWrite(target, reload);
  const reason = controlsBlocker(host, role, busy);
  const own = host?.lifecycle?.selfHealing?.maintenance.find((entry) => sameTarget(entry.target, maintenanceTarget(target)) &&
    (entry.expiresAt === null || Date.parse(entry.expiresAt) > now));
  const seconds = duration === "default" ? host?.lifecycle?.maintenanceDurationSeconds ??
    (host?.lifecycle?.maintenanceDurationSeconds === null ? null : 3600) : duration === "unlimited" ? null : Number(duration);
  const defaultSeconds = host?.lifecycle?.maintenanceDurationSeconds;
  const defaultText = defaultSeconds === null ? t("lifecycleDurationUnlimited") : t("lifecycleDurationMinutes", { count: (defaultSeconds ?? 3600) / 60 });
  const on = () => { setDuration("default"); setOpen(true); };
  const off = () => { if (!reason) void write((signal) => clearMaintenance(target.hostId, maintenanceTarget(target), signal)); };
  const trigger = <Button type="button" className="min-h-11 min-w-11 text-xs" variant="outline" aria-disabled={reason !== null}
    aria-describedby={reason ? `${id}-reason` : undefined} aria-label={t("lifecycleMaintenanceFor", { target: targetName(target) })}>
    {t("lifecycleMaintenance")}
  </Button>;
  return <div className="max-w-full">
    {detail ? <Button type="button" className="min-h-11" variant="outline" aria-disabled={reason !== null}
      aria-describedby={reason ? `${id}-reason` : undefined} onClick={() => { if (!reason) { if (own) off(); else on(); } }}>
      {t(own ? "lifecycleMaintenanceOff" : "lifecycleMaintenanceOn")}
    </Button> : <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(event) => { if (reason) event.preventDefault(); }}>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={reason !== null} onSelect={own ? off : on}>{t(own ? "lifecycleMaintenanceOff" : "lifecycleMaintenanceOn")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>}
    {reason ? <span id={`${id}-reason`} className="block max-w-56 text-xs text-muted-foreground">{t(BLOCKER_MESSAGES[reason])}</span> : null}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>{t("lifecycleMaintenanceFor", { target: targetName(target) })}</DialogTitle>
        <DialogDescription>{t(target.kind === "stack" ? "lifecycleStackMaintenance" : "lifecycleMaintenanceOn")}</DialogDescription>
        <Label htmlFor={`${id}-duration`}>{t("lifecycleDuration")}</Label>
        <Select value={duration} onValueChange={setDuration}>
          <SelectTrigger id={`${id}-duration`} className="min-h-11"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t("lifecycleDurationDefault", { duration: defaultText })}</SelectItem>
            <SelectItem value="900">{t("lifecycleDurationMinutes", { count: 15 })}</SelectItem>
            <SelectItem value="3600">{t("lifecycleDurationHour")}</SelectItem>
            <SelectItem value="86400">{t("lifecycleDurationDay")}</SelectItem>
            <SelectItem value="unlimited">{t("lifecycleDurationUnlimited")}</SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button className="min-h-11" variant="outline" onClick={() => setOpen(false)}>{t("lifecycleCancel")}</Button>
          <Button className="min-h-11" aria-disabled={reason !== null} onClick={() => {
            if (reason) return;
            setOpen(false); void write((signal) => setMaintenance(target.hostId, maintenanceTarget(target), seconds, signal));
          }}>{t("lifecycleMaintenanceOn")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
