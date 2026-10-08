import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import { type RuntimeSettings, type SelfHealingConfig } from "contract";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Label } from "../../platform/ui/shadcn/label";
import { Switch } from "../../platform/ui/shadcn/switch";
import type { Role } from "../../platform/session/session-user";
import { fetchRuntimeSettings, setRuntimeSettings, setSelfHealingSettings } from "./api";
import { SelfHealingFields } from "./SelfHealingFields";

const QUERY_KEY = ["runtime-settings"] as const;

export function RuntimeSettingsPanel({ role }: { role: Role }) {
  const t = useTranslations();
  const editable = role === "admin";
  const client = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: fetchRuntimeSettings, refetchInterval: (state) => editable && state.state.data?.selfHealing.hosts.some((host) => host.status !== "synced") ? 5000 : false });
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeSettings>();
  const [healingDraft, setHealingDraft] = useState<SelfHealingConfig>();
  const runtime = runtimeDraft ?? query.data?.runtime;
  const healing = healingDraft ?? query.data?.selfHealing.config;
  const runtimeSave = useMutation({ mutationFn: setRuntimeSettings, onSuccess: async (written) => {
    client.setQueryData<Awaited<ReturnType<typeof fetchRuntimeSettings>>>(QUERY_KEY,
      (previous) => previous ? { ...previous, runtime: written.runtime } : previous);
    setRuntimeDraft(undefined);
    await client.invalidateQueries({ queryKey: QUERY_KEY });
  } });
  const healingSave = useMutation({ mutationFn: setSelfHealingSettings, onSuccess: async (written) => {
    client.setQueryData<Awaited<ReturnType<typeof fetchRuntimeSettings>>>(QUERY_KEY,
      (previous) => previous ? { ...previous, selfHealing: written.selfHealing } : previous);
    setHealingDraft(undefined);
    await client.invalidateQueries({ queryKey: QUERY_KEY });
  } });

  return (
    <>
      <Card className="gap-3 border-accent-line bg-body-face px-4">
        <h2 className="text-sm font-medium">{t("settingsRuntimeTitle")}</h2>
        {runtime ? (
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); runtimeSave.mutate(runtime); }}>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="apply-compose-definition">{t("settingsComposeDefinitionLabel")}</Label>
              <Switch id="apply-compose-definition" aria-describedby="apply-compose-definition-hint"
                checked={runtime.applyComposeDefinition} disabled={!editable || runtimeSave.isPending}
                onCheckedChange={(applyComposeDefinition) => { setRuntimeDraft({ applyComposeDefinition }); runtimeSave.reset(); }} />
            </div>
            <p id="apply-compose-definition-hint" className="text-xs text-muted-foreground">{t("settingsComposeDefinitionHint")}</p>
            {editable ? <Button type="submit" disabled={runtimeSave.isPending}>{t("settingsRuntimeSave")}</Button> : null}
            {runtimeSave.isSuccess ? <p role="status">{t("settingsRuntimeSaved")}</p> : null}
          </form>
        ) : <p>{t("loading")}</p>}
        {query.isError || runtimeSave.isError ? <p role="alert">{t("settingsRuntimeFailed")}</p> : null}
      </Card>
      <Card className="gap-3 border-accent-line bg-body-face px-4">
        <h2 className="text-sm font-medium">{t("settingsSelfHealingTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("settingsSelfHealingHint")}</p>
        {healing ? <SelfHealingFields value={healing} onChange={(value) => { setHealingDraft(value); healingSave.reset(); }}
          editable={editable} busy={healingSave.isPending} onSave={() => healingSave.mutate(healing)} /> : <p>{t("loading")}</p>}
        {healingSave.isError ? <p role="alert">{t("settingsRuntimeFailed")}</p> : null}
        {healingSave.isSuccess ? <p role="status">{t("settingsRuntimeSaved")}</p> : null}
        <p className="text-xs text-muted-foreground">{t("settingsSelfHealingDeliveryHint")}</p>
        <ul aria-label={t("settingsSelfHealingDeliveryLabel")} className="space-y-1 text-sm">
          {query.data?.selfHealing.hosts.map((host) => (
            <li key={host.hostId}>{host.hostName}: {t(host.status === "synced" ? "settingsDeliverySynced"
              : host.status === "failed" ? "settingsDeliveryFailed" : "settingsDeliveryPending")}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
