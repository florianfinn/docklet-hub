import { useState } from "react";
import { useTranslations } from "use-intl";

import type { Role } from "../../platform/session/session-user";
import { setHubExternalEndpoint, useHubNetwork } from "../../domain/hosts";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { CommandLine } from "../../platform/ui/CommandLine";

// Die Tafel „Netz" — die Adresse, unter der dieser Hub VON AUSSEN erreichbar
// ist (#4).
//
// ⚠️ WARUM DIESE ANGABE HIER STEHT UND NICHT NUR IM ANLEGE-DIALOG. Sie ist
// eine Eigenschaft DES HUBS und nicht des einzelnen Arms: ein Arm wählt den
// Hub an, nie umgekehrt (`bootstrap/wireguard-config.ts` schreibt die
// Peer-Einträge der Hub-Seite OHNE `Endpoint`). Als Angabe je Arm geführt,
// müsste dieselbe Adresse bei jedem externen Arm neu abgetippt werden — und
// ein Tippfehler darin fällt erst auf dem fremden Rechner auf, weil dort
// nichts passiert außer einem Handshake, der nie kommt.
//
// ⚠️ Der `endpointOverride` je Arm bleibt daneben bestehen und ist etwas
// anderes: die Ausnahme für EINEN Arm. Wer hier schreibt, ändert die Adresse
// für alle externen Arme auf einmal — genau das ist der Sinn.
//
// ⚠️ Sie gilt NICHT für interne Arme. Deren Adresse steht in der Umgebung des
// Hubs (`HUB_WIREGUARD_ENDPOINT`) und ist seine Adresse im eigenen Netz; sie
// hier zu überschreiben hieße, den Tunnel eines Arms im selben Netz über das
// Internet und die eigene Portfreigabe zu führen.

export function HubNetworkPanel({ role }: { role: Role }) {
  const t = useTranslations();
  const editable = role === "admin";
  const query = useHubNetwork();
  const network = query.data ?? null;
  // The text in the field; `undefined` until somebody types or saves.
  //
  // Der ROHE Wert ins Feld und nicht das aufgelöste Ziel: bearbeitet wird, was
  // abgelegt ist. Stünde hier „hub.dyndns.invalid:51821", während abgelegt
  // „hub.dyndns.invalid" ist, schriebe das erste Speichern den Port mit fest —
  // ohne dass jemand ihn eingetippt hätte.
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const draft = typed ?? network?.externalEndpoint ?? "";
  const [busy, setBusy] = useState(false);
  // `null` until the first save: until then a failed read is what the alert
  // reports, afterwards the last save.
  const [saveFailed, setSaveFailed] = useState<boolean | null>(null);
  const failed = saveFailed ?? query.isError;
  const [saved, setSaved] = useState(false);

  const save = () => {
    setBusy(true);
    setSaveFailed(false);
    setSaved(false);
    setHubExternalEndpoint(draft.trim() || null)
      .then(async (written) => {
        // ⚠️ Neu geladen und nicht aus dem Entwurf zusammengesetzt: erst der
        // Server sagt, welches ZIEL sich daraus ergibt (mit Port) und ob es
        // von außen erreichbar ist. Ein selbst gerechneter Stand behauptete
        // eine Wirkung, die er nicht kennt.
        setTyped(written.network.externalEndpoint ?? "");
        setSaved(true);
        await query.refetch({ throwOnError: true });
      })
      .catch(() => setSaveFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsNetworkTitle")}</span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsNetworkHint")}</p>

        <div className="space-y-2">
          <Label htmlFor="hub-external-endpoint">{t("settingsNetworkExternalLabel")}</Label>
          <Input
            id="hub-external-endpoint"
            value={draft}
            disabled={!editable || busy}
            placeholder={t("settingsNetworkExternalPlaceholder")}
            aria-describedby="hub-external-endpoint-hint"
            data-testid="hub-external-endpoint"
            onChange={(event) => {
              setTyped(event.target.value);
              setSaved(false);
            }}
          />
          <span id="hub-external-endpoint-hint" className="block text-xs text-muted-foreground">
            {t("settingsNetworkExternalHint")}
          </span>
        </div>

        {/* Die zwei Adressen, die aus alldem wirklich in eine wg0.conf gehen.
            Sie stehen nebeneinander, weil ihr Unterschied die ganze Auskunft
            ist: interne Arme wählen die eine, externe die andere. */}
        {network ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-muted-foreground">{t("settingsNetworkInternalTarget")}</dt>
            <dd>
              {network.internalTarget ? (
                <CommandLine>{network.internalTarget}</CommandLine>
              ) : (
                <span className="text-muted-foreground">{t("settingsNetworkNoTarget")}</span>
              )}
            </dd>
            <dt className="text-muted-foreground">{t("settingsNetworkExternalTarget")}</dt>
            <dd>
              {network.externalTarget ? (
                <CommandLine>{network.externalTarget}</CommandLine>
              ) : (
                <span className="text-muted-foreground">{t("settingsNetworkNoTarget")}</span>
              )}
            </dd>
          </dl>
        ) : null}

        {/* ⚠️ Die Warnung hängt an der GERECHNETEN Auskunft des Servers und
            nicht an einer zweiten Liste privater Netze in diesem Paket. */}
        {network?.externalTargetUnreachable ? (
          <p role="alert" className="text-[13px] text-state-down" data-testid="hub-external-unreachable">
            {t("settingsNetworkUnreachable")}
          </p>
        ) : null}

        {failed ? (
          <p role="alert" className="text-[13px] text-destructive">
            {t("settingsNetworkFailed")}
          </p>
        ) : null}

        {editable ? (
          <div className="flex items-center gap-3">
            <Button type="button" disabled={busy} onClick={save} data-testid="hub-external-save">
              {busy ? t("loading") : t("settingsNetworkSave")}
            </Button>
            {saved ? <span className="text-xs text-state-ok">{t("settingsNetworkSaved")}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
