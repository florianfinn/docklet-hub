import { useTranslations } from "use-intl";
import { DEFAULT_SELF_HEALING_CONFIG, SELF_HEALING_LIMITS, selfHealingConfigSchema, type SelfHealingConfig } from "contract";
import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { Switch } from "../../platform/ui/shadcn/switch";

const displayNumber = (value: number | null) => value !== null && Number.isFinite(value) ? value : "";

export function SelfHealingFields({ value, onChange, editable, busy, onSave }: {
  value: SelfHealingConfig; onChange: (value: SelfHealingConfig) => void;
  editable: boolean; busy: boolean; onSave: () => void;
}) {
  const t = useTranslations();
  const disabled = !editable || busy;
  const valid = selfHealingConfigSchema.safeParse(value).success;
  const numberFields = [
    { key: "stabilityWindowSeconds", label: "settingsHealingStability", limits: SELF_HEALING_LIMITS.stabilityWindowSeconds },
    { key: "maintenanceDurationSeconds", label: "settingsHealingMaintenance", limits: SELF_HEALING_LIMITS.maintenanceDurationSeconds }
  ] as const;
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(); }}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="self-healing-enabled">{t("settingsHealingEnabled")}</Label>
        <Switch id="self-healing-enabled" checked={value.enabled} disabled={disabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })} />
      </div>
      <p id="self-healing-limits" className="text-xs text-muted-foreground">{t("settingsHealingLimits")}</p>
      <div className="space-y-2">
        <Label htmlFor="self-healing-attempts">{t("settingsHealingAttempts")}</Label>
        <Input id="self-healing-attempts" type="number" step={1} min={SELF_HEALING_LIMITS.attempts.min}
          max={SELF_HEALING_LIMITS.attempts.max} value={displayNumber(value.attempts)} disabled={disabled}
          aria-describedby="self-healing-limits" required onChange={(event) => {
            const attempts = event.target.valueAsNumber;
            const retryDelaysSeconds = Number.isInteger(attempts) && attempts >= 1 && attempts <= 10
              ? Array.from({ length: attempts }, (_, index) => value.retryDelaysSeconds[index]
                ?? DEFAULT_SELF_HEALING_CONFIG.retryDelaysSeconds[index] ?? value.retryDelaysSeconds.at(-1) ?? 300)
              : value.retryDelaysSeconds;
            onChange({ ...value, attempts, retryDelaysSeconds });
          }} />
      </div>
      {value.retryDelaysSeconds.map((delay, index) => (
        <div className="space-y-2" key={index}>
          <Label htmlFor={`self-healing-delay-${index}`}>{t("settingsHealingDelay", { attempt: index + 1 })}</Label>
          <Input id={`self-healing-delay-${index}`} type="number" step={1} min={SELF_HEALING_LIMITS.retryDelaySeconds.min}
            max={SELF_HEALING_LIMITS.retryDelaySeconds.max} value={displayNumber(delay)} disabled={disabled}
            aria-describedby="self-healing-limits" required onChange={(event) => onChange({ ...value,
              retryDelaysSeconds: value.retryDelaysSeconds.map((entry, at) => at === index ? event.target.valueAsNumber : entry) })} />
        </div>
      ))}
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="self-healing-maintenance-unlimited">{t("settingsHealingMaintenanceUnlimited")}</Label>
        <Switch id="self-healing-maintenance-unlimited" checked={value.maintenanceDurationSeconds === null} disabled={disabled}
          onCheckedChange={(unlimited) => onChange({ ...value,
            maintenanceDurationSeconds: unlimited ? null : DEFAULT_SELF_HEALING_CONFIG.maintenanceDurationSeconds })} />
      </div>
      {numberFields.map(({ key, label, limits }) => (
        <div className="space-y-2" key={key}>
          <Label htmlFor={`self-healing-${key}`}>{t(label)}</Label>
          <Input id={`self-healing-${key}`} type="number" step={1} min={limits.min} max={limits.max}
            value={displayNumber(value[key])} disabled={disabled || (key === "maintenanceDurationSeconds" && value[key] === null)}
            aria-describedby="self-healing-limits" required={key !== "maintenanceDurationSeconds" || value[key] !== null}
            onChange={(event) => onChange({ ...value, [key]: event.target.valueAsNumber })} />
        </div>
      ))}
      {!valid ? <p role="alert">{t("settingsHealingInvalid")}</p> : null}
      {editable ? <Button type="submit" disabled={busy || !valid}>{t("settingsRuntimeSave")}</Button> : null}
    </form>
  );
}
