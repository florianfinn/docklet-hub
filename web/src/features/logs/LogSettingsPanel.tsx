import { useState } from "react";
import { useTranslations } from "use-intl";

import { LOG_TAIL_LINE_OPTIONS, type LogTailLines } from "contract";

import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { Label } from "../../platform/ui/shadcn/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../platform/ui/shadcn/select";
import { setLogTailLines } from "./api";
import { useLogSettings, useLogSettingsUpdate } from "./log-settings-queries";

// Die Tafel „Logansicht" — wie viele Zeilen Vergangenheit eine Logansicht
// beim Öffnen zeigt (#5, Etappe H).
//
// ⚠️ WARUM DIESE ANGABE HUBWEIT UND NICHT JE ARM STEHT. Sie ist eine Vorliebe
// der Bedienoberfläche und keine Eigenschaft eines Arms: derselbe Betreiber
// liest die Logs aller Arme in derselben Ansicht. Als Angabe je Arm geführt,
// müsste sie an jedem Arm einzeln nachgezogen werden, und die Ansicht
// verhielte sich von Arm zu Arm anders, ohne dass irgendetwas darauf hinwiese.
//
// ⚠️ DER VORRAT IST FEST UND HAT EINE OBERGRENZE. Die vier Werte stehen in
// `LOG_TAIL_LINE_OPTIONS` (`contract/src/api/settings.ts`), dieselbe Liste,
// mit der der Server prüft. Ein freies Zahlenfeld böte Werte an, die der Server mit 400
// abwiese — und über 2000 auch solche, die der Agent still auf 2000 kürzte
// (`Math.min(tail, 2000)`). Beides wäre eine Zusage, die niemand hält.

// `role` is spelled out here; the type `Role` stands in
// `platform/session/session-user.ts` since #269.
export function LogSettingsPanel({ role }: { role: "admin" | "user" }) {
  const t = useTranslations();
  const editable = role === "admin";
  const settings = useLogSettings();
  const updateSettings = useLogSettingsUpdate();
  // `null` heißt: noch nicht geladen — oder der Server hat einen Wert
  // geschickt, den diese Fassung nicht kennt. Beides endet in einem leeren
  // Auswahlfeld, und das ist die ehrliche Anzeige: eine still eingesetzte
  // Vorgabe behauptete einen Stand, den der Hub gar nicht trägt.
  //
  // ⚠️ DIE EINE STELLE, an der aus einer beliebigen Zahl einer der vier
  // erlaubten Werte wird — durch Nachschlagen in der Liste und nicht durch
  // eine Behauptung (`as LogTailLines`). Dieselbe Haltung wie im Themeneditor
  // (`AppearancePanel`): steht dort etwas, das es nicht gibt, geschieht nichts.
  const stored = LOG_TAIL_LINE_OPTIONS.find((option) => option === settings.data?.tailLines) ?? null;
  // The choice not yet saved; `undefined` while nothing was picked, so the
  // field shows what the hub stores.
  const [draft, setDraft] = useState<LogTailLines | undefined>(undefined);
  const tailLines = draft ?? stored;
  const [busy, setBusy] = useState(false);
  // `null` until the first save: until then a failed read is what the alert
  // reports, afterwards the last save.
  const [saveFailed, setSaveFailed] = useState<boolean | null>(null);
  const failed = saveFailed ?? settings.isError;
  const [saved, setSaved] = useState(false);

  // ⚠️ HERE THE STRING BECOMES A NUMBER, and only here. Radix, like every
  // `<select>` in the browser, delivers a `string`; the server checks STRICTLY
  // for `typeof value === "number"` and rejects a `"1000"` with
  // `400 { error: "invalid-input" }` instead of converting it
  // (`normalizeLogTailLines`, server/src/features/logs/store.ts). The lookup
  // in `LOG_TAIL_LINE_OPTIONS` converts AND checks in one step: a
  // `Number(picked)` would give a `NaN` for anything else, noticed only by the
  // server.
  const pick = (picked: string) => {
    const option = LOG_TAIL_LINE_OPTIONS.find((entry) => String(entry) === picked);
    if (option === undefined) return;
    setDraft(option);
    setSaved(false);
  };

  const save = () => {
    if (tailLines === null) return;
    setBusy(true);
    setSaveFailed(false);
    setSaved(false);
    setLogTailLines(tailLines)
      // ⚠️ Der Stand kommt AUS DER ANTWORT und nicht aus dem Entwurf: erst der
      // Server sagt, was wirklich abgelegt ist. Der Umschlag ist `{ logs: … }`
      // — das nackte Objekt zu erwarten ergäbe `tailLines: undefined` und ein
      // leeres Auswahlfeld nach einem gelungenen Speichern.
      .then((written) => {
        updateSettings(written.logs);
        setDraft(undefined);
        setSaved(true);
      })
      .catch(() => setSaveFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsLogsTitle")}</span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsLogsHint")}</p>

        <div className="space-y-2">
          <Label htmlFor="log-tail-lines">{t("settingsLogsTailLinesLabel")}</Label>
          {/* ⚠️ Das Feld steht auch OHNE Adminrecht da, nur abgeschaltet: ein
              Benutzer soll sehen, mit welcher Zeilenzahl seine Logansicht
              öffnet. Was ihm fehlt, ist der Knopf darunter — siehe dort. */}
          <Select value={tailLines === null ? undefined : String(tailLines)} disabled={!editable || busy} onValueChange={pick}>
            <SelectTrigger id="log-tail-lines" className="w-[15rem]" aria-describedby="log-tail-lines-hint">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_TAIL_LINE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)} data-testid={`log-tail-lines-option-${option}`}>
                  {t("settingsLogsTailLinesOption", { count: option })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span id="log-tail-lines-hint" className="block text-xs text-muted-foreground">
            {t("settingsLogsTailLinesHint")}
          </span>
        </div>

        {failed ? (
          <p role="alert" className="text-[13px] text-destructive" data-testid="log-tail-lines-failed">
            {t("settingsLogsFailed")}
          </p>
        ) : null}

        {/* ⚠️ KEIN KNOPF OHNE ADMINRECHT. Die Route steht hinter
            `requireAdmin` und antwortet einem Benutzer mit 403; ein Knopf, der
            verlässlich in einen Fehler läuft, ist eine Falle und keine
            Auskunft. Derselbe Schnitt wie in `HubNetworkPanel`. */}
        {editable ? (
          <div className="flex items-center gap-3">
            <Button type="button" disabled={busy || tailLines === null} onClick={save} data-testid="log-tail-lines-save">
              {busy ? t("loading") : t("settingsLogsSave")}
            </Button>
            {saved ? <span className="text-xs text-state-ok">{t("settingsLogsSaved")}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
