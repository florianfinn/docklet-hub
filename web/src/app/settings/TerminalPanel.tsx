import { useState } from "react";
import { useTranslations } from "use-intl";

import { THEME_KNOBS, type GlobalThemePreset } from "contract";
import { KnobRow, stepsOf, useGlobalTheme } from "../../features/appearance";
import type { Role } from "../../platform/session/session-user";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { GLOBAL_KNOB_LABELS, GLOBAL_STEP_LABELS } from "../../platform/i18n/theme-labels";

// Die Tafel „Terminal" (B6, #5) — die Bedienung der vier Stellschrauben, die
// `THEME_KNOBS` seit der Etappe davor führt: Schema, Fläche, Schriftgröße und
// Verlauf. Was die vier BEDEUTEN, steht in
// `.remember/orchestration-b6/terminal-farben.md` und in den Kommentaren über
// den Stufenlisten in `contract/src/presets.ts`.
//
// ⚠️ EINE EIGENE KARTE UND NICHT VIER WEITERE ZEILEN IN „DARSTELLUNG"
// (Entscheidung des Betreibers). Die sieben dort wirken auf JEDE Fläche des
// Hubs, diese vier auf genau eine — den Reiter, in dem ein Terminal steht.
// Untereinander in derselben Feldliste wäre nicht zu sehen, dass die
// Reichweite eine andere ist, und „Fläche" stünde einmal für den ganzen Hub
// und einmal für einen Kasten darin.
//
// ⚠️ SIE STEHT HINTER „LOGANSICHT" UND NICHT DAVOR (SettingsScreen.tsx). Eine
// Einstellung, die nur für einen Reiter gilt, den es noch nicht gibt, gehört
// nicht vor die, die überall wirken.
//
// ⚠️ WARUM DER GANZE SATZ GESCHICKT WIRD UND NICHT DIE VIER. `PUT
// /api/settings/theme` nimmt den VOLLEN Satz der elf globalen Stellschrauben;
// ein unvollständiger Rumpf endet schon in `server/src/features/appearance/input.ts`
// in einem `400` und erreicht den Speicher nie. Die anderen sieben kommen
// deshalb aus `theme` des Anbieters — siehe den nächsten Absatz, das ist keine
// Bequemlichkeit, sondern die Stelle, an der zwei Tafeln sich sonst
// überschrieben.
//
// ⚠️ WARUM ÜBER `useGlobalTheme()` UND NICHT ÜBER EIN EIGENES
// `fetchSettings()`. Diese Tafel und „Darstellung" schreiben DIESELBE Route
// mit DEMSELBEN vollen Satz. Ein eigener Abruf hier hielte eine zweite Kopie
// des geltenden Standes: speichert der Betreiber oben ein helles Schema und
// danach hier eine Flächentiefe, schriebe diese Tafel das dunkle Schema ihres
// alten Abrufs zurück — der Klick auf „Speichern" nähme eine Einstellung
// zurück, die niemand angefasst hat. Der Anbieter ist die EINE Quelle: sein
// `theme` trägt nach jedem gelungenen Schreiben den Stand, den der SERVER
// zurückgegeben hat, und beide Tafeln lesen ihn.
//
// ⚠️ KEIN `preview(…)` HIER, anders als in „Darstellung". Dort ist die Seite,
// auf der der Betreiber steht, selbst die Vorschau: ein anderes Schema oder
// eine andere Dichte sind sofort um ihn herum zu sehen. Diese vier wirken
// dagegen ausschließlich im Terminal, und auf der Fläche „Einstellungen" steht
// keines. Ein `preview(…)` hätte hier also nichts zu zeigen und dafür etwas zu
// verlieren: es setzte die Attribute des ganzen Hubs auf einen Stand, der
// nirgends gespeichert ist, und bräuchte dieselbe Rücknahme beim Verlassen der
// Fläche wie dort. Der Entwurf bleibt deshalb lokal, bis „Speichern" ihn
// abgibt.
//
// ⚠️ KEIN „NOCH NICHT GELADEN" ALS EIGENER ZUSTAND, anders als in
// `LogSettingsPanel`. Dort ist `null` die ehrliche Anzeige, weil die Tafel
// ihren Wert selbst abruft und vor der Antwort keinen kennt. Hier hält der
// Anbieter den Satz, und er hält ihn NIE als `null`: bis `load()` durch ist,
// steht `DEFAULT_GLOBAL_THEME` — dieselben Werte, die `:root` in `tokens.css`
// ohnehin trägt (Begründung im Kopf von `GlobalThemeProvider.tsx`). Ein
// zweiter Ladezustand hier wäre kein zusätzlicher Befund, sondern genau die
// zweite Quelle, die der Absatz darüber ausschließt.

/** Die vier Stellschrauben dieser Tafel — als Namen, nicht als Aufzählung. */
type TerminalKnob = "terminalScheme" | "terminalSurface" | "terminalSize" | "terminalScrollback";

/**
 * Der Entwurf: die vier Werte, so wie sie auf dem Schirm stehen.
 *
 * ⚠️ `Pick` und nicht vier einzelne Felder: fällt in `presets.ts` eine der
 * vier weg oder bekommt sie eine andere Stufenliste, ist das hier ein
 * Typfehler und keine stille Abweichung.
 */
type TerminalDraft = Pick<GlobalThemePreset, TerminalKnob>;

function terminalOf(theme: GlobalThemePreset): TerminalDraft {
  return {
    terminalScheme: theme.terminalScheme,
    terminalSurface: theme.terminalSurface,
    terminalSize: theme.terminalSize,
    terminalScrollback: theme.terminalScrollback
  };
}

export function TerminalPanel({ role }: { role: Role }) {
  const t = useTranslations();
  const { theme, save } = useGlobalTheme();
  const editable = role === "admin";

  // `null` heißt: nichts angefasst — auf dem Schirm steht der gespeicherte
  // Stand. Erst ein Griff an ein Auswahlfeld macht daraus einen Entwurf, und
  // nur dann gibt es überhaupt etwas zu speichern.
  const [draft, setDraft] = useState<TerminalDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);

  const current = draft ?? terminalOf(theme);

  const pick = <K extends TerminalKnob>(knob: K, step: GlobalThemePreset[K]) => {
    const next: TerminalDraft = { ...current, [knob]: step };
    setDraft(next);
    setFailed(false);
    setSaved(false);
  };

  const commit = () => {
    if (draft === null) return;
    setBusy(true);
    setFailed(false);
    setSaved(false);
    // ⚠️ HIER STEHT DIE ZUSAGE DIESER TAFEL: `...theme` zuerst, `...draft`
    // darüber. Der Rumpf trägt damit alle elf Stellschrauben — die sieben der
    // Darstellung in dem Stand, den der Anbieter GERADE hält, und die vier
    // dieser Tafel als Entwurf. Ein `save(draft)` wäre eine Teilmenge und
    // schon in `features/appearance/input.ts` ein `400`; ein `save({ ...DEFAULT, ...draft })`
    // wäre schlimmer, weil es durchginge und dabei die Darstellung
    // zurückstellte.
    void save({ ...theme, ...draft })
      .then(() => {
        // Der Anbieter trägt jetzt den Satz des Servers. Damit ist der Entwurf
        // erledigt, und `current` liest wieder aus `theme` — ein Entwurf, der
        // stehen bliebe, behauptete einen Unterschied, den es nicht mehr gibt.
        setDraft(null);
        setSaved(true);
      })
      // `save` stellt bei einem Fehlschlag selbst auf den vorigen Satz zurück
      // und gibt den Fehler weiter; die Meldung dazu gehört hierher, denn nur
      // diese Fläche weiß, wo sie hingehört.
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsTerminalTitle")}</span>
        {saved ? (
          <span className="text-xs text-state-ok" data-testid="terminal-saved">
            {t("settingsTerminalSaved")}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-[13px] text-subtle-foreground">{t("settingsTerminalHint")}</p>

        <div className="flex flex-col">
          {!editable ? (
            <p className="py-2 text-[13px] text-muted-foreground">{t("settingsAdminOnly")}</p>
          ) : null}

          {/* Die vier Zeilen stehen einzeln da und nicht als Schleife über
              `THEME_KNOBS` — dieselbe Begründung wie bei den sieben in
              „Darstellung": nur so bleiben Wert, Stufenliste und
              Beschriftungen einer Schraube aneinandergebunden, ohne eine
              Zusicherung. */}
          <KnobRow
            knob="terminalScheme"
            label={GLOBAL_KNOB_LABELS.terminalScheme}
            value={current.terminalScheme}
            steps={stepsOf(THEME_KNOBS.terminalScheme.steps, GLOBAL_STEP_LABELS.terminalScheme)}
            editable={editable}
            onPick={pick}
            testId="terminal-knob-scheme"
          />
          <KnobRow
            knob="terminalSurface"
            label={GLOBAL_KNOB_LABELS.terminalSurface}
            value={current.terminalSurface}
            steps={stepsOf(THEME_KNOBS.terminalSurface.steps, GLOBAL_STEP_LABELS.terminalSurface)}
            editable={editable}
            onPick={pick}
            testId="terminal-knob-surface"
          />
          <KnobRow
            knob="terminalSize"
            label={GLOBAL_KNOB_LABELS.terminalSize}
            value={current.terminalSize}
            steps={stepsOf(THEME_KNOBS.terminalSize.steps, GLOBAL_STEP_LABELS.terminalSize)}
            editable={editable}
            onPick={pick}
            testId="terminal-knob-size"
          />
          <KnobRow
            knob="terminalScrollback"
            label={GLOBAL_KNOB_LABELS.terminalScrollback}
            value={current.terminalScrollback}
            steps={stepsOf(THEME_KNOBS.terminalScrollback.steps, GLOBAL_STEP_LABELS.terminalScrollback)}
            editable={editable}
            onPick={pick}
            testId="terminal-knob-scrollback"
            // ⚠️ DER EINE HINWEIS DIESER TAFEL, und er steht hier und nicht
            // bei den anderen drei. „5.000 Zeilen" liest sich wie eine Zusage
            // über die Vergangenheit — als lieferte der Hub beim Öffnen
            // fünftausend Zeilen nach. Er tut es nicht: die Zahl ist Speicher
            // IM BROWSER, und der Agent kennt gar keinen Verlauf, er schickt,
            // was kommt (`terminal-farben.md`, und dieselbe Warnung im Kopf
            // von `TERMINAL_SCROLLBACK_STEPS`). Ein Feld, dessen Name die
            // falsche Erwartung weckt, bekommt den Satz, der sie geradezieht.
            hint="settingsTerminalScrollbackHint"
          />
        </div>

        {failed ? (
          <p role="alert" className="text-[13px] text-destructive" data-testid="terminal-failed">
            {t("settingsTerminalFailed")}
          </p>
        ) : null}

        {/* ⚠️ KEIN KNOPF OHNE ADMINRECHT. Die Route steht hinter
            `requireAdmin` und antwortet einem Benutzer mit 403; ein Knopf, der
            verlässlich in einen Fehler läuft, ist eine Falle und keine
            Auskunft. Derselbe Schnitt wie in `LogSettingsPanel`. */}
        {editable ? (
          <div className="flex items-center gap-3">
            <Button type="button" disabled={busy || draft === null} onClick={commit} data-testid="terminal-save">
              {busy ? t("settingsTerminalSaving") : t("settingsTerminalSave")}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
