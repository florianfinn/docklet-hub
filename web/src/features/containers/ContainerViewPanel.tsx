import { useState } from "react";
import { useTranslations } from "use-intl";

import type { Role } from "../../platform/session/session-user";
import { Card } from "../../platform/ui/shadcn/card";
import { Label } from "../../platform/ui/shadcn/label";
import { Switch } from "../../platform/ui/shadcn/switch";
import { setShowSystemContainers } from "./api";
import { useContainerViewSettings, useContainerViewUpdate } from "./overview-queries";

// Die Tafel „Hub und Agenten" im Reiter „Container": ob Übersicht und
// Container-Fläche die Container des Leitstands selbst zeigen.
//
// ⚠️ HUBWEIT und nicht je Benutzer, aus demselben Grund wie die Logansicht
// (`LogSettingsPanel`): eine Vorliebe der Bedienoberfläche, die ein
// Administrator setzt und alle lesen (#17). Die Vorgabe ist AUS.
//
// ⚠️ EIN SCHALTER OHNE SPEICHERN-KNOPF. Anders als bei der Zeilenzahl gibt es
// nichts vorzubereiten: eine Wahl zwischen zwei Zuständen ist mit dem Klick
// getroffen. Scheitert das Schreiben, springt der Schalter zurück — er zeigt
// nie einen Stand, den der Hub nicht trägt.

export function ContainerViewPanel({ role }: { role: Role }) {
  const t = useTranslations();
  const editable = role === "admin";
  const stored = useContainerViewSettings();
  const storeView = useContainerViewUpdate();
  // Der Stand, den der Schalter gerade zeigt und der Hub noch nicht bestätigt
  // hat. `null` heißt: es gibt keinen, der Schalter zeigt den gespeicherten
  // Stand — und der ist `null`, solange er nicht geladen ist. Der Schalter
  // steht dann abgeschaltet.
  const [pending, setPending] = useState<boolean | null>(null);
  const showSystem = pending ?? stored.data?.showSystem ?? null;
  const [busy, setBusy] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const failed = writeFailed || stored.isError;

  const toggle = (next: boolean) => {
    setPending(next);
    setBusy(true);
    setWriteFailed(false);
    setSaved(false);
    setShowSystemContainers(next)
      // Der Stand kommt AUS DER ANTWORT: erst der Server sagt, was abgelegt ist.
      .then((written) => {
        storeView(written.containers);
        setSaved(true);
      })
      .catch(() => setWriteFailed(true))
      // Der erbetene Stand fällt in beiden Fällen weg: bei Erfolg zeigt der
      // Schalter den geschriebenen aus dem Zwischenspeicher, bei einem Fehler
      // springt er auf den gespeicherten zurück.
      .finally(() => {
        setPending(null);
        setBusy(false);
      });
  };

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsContainerViewTitle")}</span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsContainerViewHint")}</p>

        <div className="flex items-center gap-3">
          {/* ⚠️ Auch ohne Adminrecht sichtbar, nur abgeschaltet: ein Benutzer
              soll sehen, warum ihm Hub und Agenten in der Übersicht fehlen. */}
          <Switch
            id="show-system-containers"
            checked={showSystem === true}
            disabled={!editable || busy || showSystem === null}
            onCheckedChange={toggle}
            data-testid="show-system-containers"
          />
          <Label htmlFor="show-system-containers" className="text-[13px] font-normal">
            {t("settingsContainerViewShow")}
          </Label>
          {saved ? <span className="text-xs text-state-ok">{t("settingsContainerViewSaved")}</span> : null}
        </div>

        {!editable ? <p className="text-xs text-muted-foreground">{t("settingsAdminOnly")}</p> : null}

        {failed ? (
          <p role="alert" className="text-[13px] text-destructive">
            {t("settingsContainerViewFailed")}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
