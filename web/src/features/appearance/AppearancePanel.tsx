import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import { THEME_KNOBS, type GlobalThemePreset } from "contract";
import { useGlobalTheme } from "./GlobalThemeProvider";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Button } from "../../platform/ui/shadcn/button";
import { Card } from "../../platform/ui/shadcn/card";
import { KnobRow, stepsOf } from "./KnobRow";
import { GLOBAL_KNOB_LABELS, GLOBAL_STEP_LABELS } from "../../platform/i18n/theme-labels";

// Die Tafel „Darstellung" (D7a, #62; Artboard hub-palette.html Z. 770–780 —
// nachgemessen mit `grep -n 'panelhead">Darstellung' …`, das Panel beginnt bei
// 770 und nicht bei 776).
//
// Sie trägt die sieben Stellschrauben, die `THEME_KNOBS` mit `scope: "global"`
// führt. Die Stufen kommen aus `THEME_KNOBS[…].steps` und nicht aus einer
// zweiten Liste hier: eine Stufe, die es in `presets.ts` nicht gibt, kann
// dieser Bildschirm damit gar nicht erst anbieten, und der Server müsste sie
// nicht ablehnen.
//
// ⚠️ DIE ZEILE EINER STELLSCHRAUBE LIEGT SEIT B6 (#5) IN `./KnobRow` und wird
// mit der Tafel „Terminal" geteilt. Sie stand bis dahin hier.
//
// Dass diese Tafel dabei ihren gerenderten Baum behält, ist keine Behauptung
// dieses Kommentars, sondern die Zusage von
// `web/tests/appearance-panel.test.tsx`. Er zeichnet die Tafel in BEIDEN
// Rollen und fordert an jeder gefundenen Zeile: kein `data-testid`, kein
// `aria-describedby`. Die zwei wahlfreien Requisiten von `KnobRow` (`testId`,
// `hint`) werden hier nicht gesetzt, und React rendert ein Attribut ohne Wert
// nicht — wer in `KnobRow` eines OHNE Bedingung setzt, macht diesen Wächter
// rot. Gemessen: `data-testid={testId ?? "knob"}` am Auslöser → Prüfung 4 rot;
// dasselbe am Text der Nur-Lese-Zeile → Prüfung 5 rot. `terminal-panel.test.tsx`
// bleibt bei beidem grün, dort sind die Attribute erwünscht — dieser Wächter
// ist also der einzige, der es sieht.
//
// ⚠️ VORSCHAU UND SPEICHERN SIND GETRENNT — und zwar so:
//
//   - Jedes Anfassen ruft `preview(…)`. Der Anbieter schreibt den Satz an
//     `<html>`, die Variablen in `tokens.css` lösen von dort neu auf, und die
//     Wirkung steht sofort auf DIESER Seite. Es gibt keine zweite
//     Vorschaufläche, weil es nichts gäbe, was sie zeigen könnte: die Seite,
//     auf der der Betreiber steht, IST die Vorschau (#62, D7).
//   - Erst „Speichern" ruft `save(…)` und damit `PUT /api/settings/theme`.
//
// WARUM NICHT BEI JEDEM KLICK SCHREIBEN. Der Vertrag der Route trägt den
// GANZEN Satz der sieben Stellschrauben und nicht die eine geänderte Stufe
// (`features/appearance/api.ts`). Wer bei jedem Anfassen schriebe, erzeugte für einen
// durchprobierten Satz ein halbes Dutzend Schreibvorgänge — jeder davon für
// ALLE Benutzer des Hubs sofort gültig, auch die drei Zwischenstände, die
// niemand behalten wollte. Die Trennung ist deshalb keine Bequemlichkeit,
// sondern die Reichweite der Einstellung.
//
// ⚠️ WIE EIN UNGESPEICHERTER WERT DIESE FLÄCHE NICHT VERLASSEN KANN. Zwei
// Dinge zusammen, und beide sind nötig:
//
//   1. Solange etwas nur in der Vorschau steht, sagt die Tafel es: eine Marke
//      im Kopf („Vorschau — noch nicht gespeichert"), ein Satz darunter, und
//      die zwei Knöpfe „Speichern" und „Verwerfen". Der Zustand ist damit
//      sichtbar und nicht bloß vorhanden.
//   2. Beim Verlassen der Fläche wird die Vorschau ZURÜCKGENOMMEN. Genau das
//      verlangt der Anbieter von seinem Aufrufer („Wer sie ruft, ist dafür
//      zuständig, den vorigen Satz wiederherzustellen, wenn der Betreiber die
//      Fläche verlässt, ohne zu speichern"). Ohne diesen Schritt trüge der
//      ganze Hub ein Aussehen, das in keiner Ablage steht — bis zum nächsten
//      Neuladen, und dann wäre es weg, ohne dass jemand erführe, warum.
//
// ⚠️ WARUM DIE TAFEL AUCH OHNE ADMINROLLE ERSCHEINT. Die Werte gelten für
// ALLE Benutzer; ihr Anblick ist deshalb keine Auskunft, die man verstecken
// müsste, und `GET /api/settings` steht ohnehin nur hinter `withSession`. Was
// fehlt, sind die Auswahllisten: `PUT /api/settings/theme` ist Admin, und ein
// Bedienelement, das beim Klick in einen 403 liefe, wäre genau die Lüge, die
// dieses Projekt nicht will. Abgelesen an den zwei Flächen daneben:
// `HostsScreen` zeigt den Knopf „Host anlegen" nur der Adminrolle,
// `AccountScreen` lässt die Tafel „Konten" für alle anderen ganz weg. Der
// Unterschied zwischen beiden ist die DATENLAGE, nicht der Geschmack: dort
// steht hinter der Tafel ein `requireAdmin`-Abruf, der für andere in einer 403
// endete, hier nicht. Also wird hier gezeigt und nicht versteckt.

export function AppearancePanel({ role }: { role: "admin" | "user" }) {
  const t = useTranslations();
  const { theme, preview, save } = useGlobalTheme();
  const editable = role === "admin";

  // Der Satz, der auf dem Schirm steht, wenn er NICHT dem gespeicherten
  // entspricht — zusammen mit dem gespeicherten, auf den zurückzustellen ist.
  //
  // ⚠️ Warum beides und nicht ein Vergleich mit `theme`: `preview(…)` setzt
  // `theme` im Anbieter. Nach dem ersten Anfassen IST `theme` der Entwurf, und
  // ein Vergleich „Entwurf gegen `theme`" fiele für immer gleich aus. Der
  // gespeicherte Satz muss deshalb festgehalten werden, BEVOR die erste
  // Vorschau ihn überschreibt.
  const [pending, setPending] = useState<{ saved: GlobalThemePreset; draft: GlobalThemePreset } | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const current = pending === null ? theme : pending.draft;

  // Das Zurücknehmen beim Verlassen der Fläche.
  //
  // ⚠️ Über eine Referenz und NICHT über die Abhängigkeiten des Effekts: ein
  // Effekt mit `[pending]` räumte bei JEDER Änderung auf und stellte damit
  // mitten im Probieren zurück. Gebraucht wird genau ein Aufräumen — das beim
  // Aushängen —, und es muss den zuletzt gültigen Stand sehen. Der erste
  // Effekt hält ihn deshalb nach jedem Rendern nach, der zweite ruft ihn beim
  // Aushängen ab.
  const rollback = useRef<(() => void) | null>(null);
  useEffect(() => {
    rollback.current = pending === null ? null : () => preview(pending.saved);
  });
  useEffect(() => {
    return () => {
      if (rollback.current !== null) rollback.current();
    };
  }, []);

  const pick = <K extends keyof GlobalThemePreset>(knob: K, step: GlobalThemePreset[K]) => {
    const next: GlobalThemePreset = { ...current, [knob]: step };
    setPending({ saved: pending === null ? theme : pending.saved, draft: next });
    setFailed(false);
    // Sofort sichtbar, ausdrücklich NICHT gespeichert.
    preview(next);
  };

  const discard = () => {
    if (pending === null) return;
    preview(pending.saved);
    setPending(null);
    setFailed(false);
  };

  const commit = () => {
    if (pending === null) return;
    setSaving(true);
    setFailed(false);
    void save(pending.draft)
      .then(() => {
        // Der Anbieter hat den Satz übernommen, den der SERVER zurückgegeben
        // hat. Damit ist `theme` wieder der gespeicherte Stand, und es gibt
        // nichts Offenes mehr zurückzunehmen.
        setPending(null);
      })
      .catch(() => {
        // `save` stellt bei einem Fehlschlag auf den Stand vor dem Schreiben
        // zurück — das ist hier der Entwurf, denn der stand schon als Vorschau
        // am Wurzelelement. Der Entwurf bleibt also stehen, die Marke „noch
        // nicht gespeichert" auch, und daneben steht ab jetzt die Meldung. Der
        // Anbieter trägt sie bewusst nicht selbst: er weiß nicht, wo sie
        // hingehört.
        setFailed(true);
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("settingsAppearanceTitle")}</span>
        {pending === null ? null : (
          <Badge variant="outline" className="font-normal">
            {t("settingsAppearanceUnsaved")}
          </Badge>
        )}
        {/* Die Nebenangabe des Artboards (Z. 771): für WEN die Einstellung
            gilt. Anders als bei der Sprache ist die Antwort hier „für alle" —
            und genau deshalb steht das Schreiben hinter der Adminrolle. */}
        <span className="ml-auto text-xs text-muted-foreground">{t("settingsAppearanceScope")}</span>
      </div>

      <div className="flex flex-col px-4 py-2">
        {!editable ? (
          <p className="py-2 text-[13px] text-muted-foreground">{t("settingsAdminOnly")}</p>
        ) : null}

        {/* Die sieben Zeilen stehen einzeln da und nicht als Schleife über
            `THEME_KNOBS`: nur so bleiben Wert, Stufenliste und Beschriftungen
            einer Schraube für den Übersetzer aneinandergebunden, ohne eine
            Zusicherung. Eine achte Stellschraube fällt trotzdem auf — sie
            erzeugt in `GLOBAL_KNOB_LABELS` einen Typfehler, der sie beim Namen
            nennt. */}
        <KnobRow
          knob="scheme"
          label={GLOBAL_KNOB_LABELS.scheme}
          value={current.scheme}
          steps={stepsOf(THEME_KNOBS.scheme.steps, GLOBAL_STEP_LABELS.scheme)}
          editable={editable}
          onPick={pick}
        />
        <KnobRow
          knob="chroma"
          label={GLOBAL_KNOB_LABELS.chroma}
          value={current.chroma}
          steps={stepsOf(THEME_KNOBS.chroma.steps, GLOBAL_STEP_LABELS.chroma)}
          editable={editable}
          onPick={pick}
        />
        <KnobRow
          knob="radius"
          label={GLOBAL_KNOB_LABELS.radius}
          value={current.radius}
          steps={stepsOf(THEME_KNOBS.radius.steps, GLOBAL_STEP_LABELS.radius)}
          editable={editable}
          onPick={pick}
        />
        <KnobRow
          knob="density"
          label={GLOBAL_KNOB_LABELS.density}
          value={current.density}
          steps={stepsOf(THEME_KNOBS.density.steps, GLOBAL_STEP_LABELS.density)}
          editable={editable}
          onPick={pick}
        />
        <KnobRow
          knob="font"
          label={GLOBAL_KNOB_LABELS.font}
          value={current.font}
          steps={stepsOf(THEME_KNOBS.font.steps, GLOBAL_STEP_LABELS.font)}
          editable={editable}
          onPick={pick}
        />
        <KnobRow
          knob="charts"
          label={GLOBAL_KNOB_LABELS.charts}
          value={current.charts}
          steps={stepsOf(THEME_KNOBS.charts.steps, GLOBAL_STEP_LABELS.charts)}
          editable={editable}
          onPick={pick}
        />
        <KnobRow
          knob="focus"
          label={GLOBAL_KNOB_LABELS.focus}
          value={current.focus}
          steps={stepsOf(THEME_KNOBS.focus.steps, GLOBAL_STEP_LABELS.focus)}
          editable={editable}
          onPick={pick}
        />
      </div>

      {pending === null ? null : (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <p className="text-[13px] text-subtle-foreground">{t("settingsAppearanceUnsavedHint")}</p>
          {failed ? (
            <p className="w-full text-[13px] text-destructive">{t("settingsAppearanceSaveFailed")}</p>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
              {t("settingsAppearanceDiscard")}
            </Button>
            <Button size="sm" onClick={commit} disabled={saving}>
              {saving ? t("settingsAppearanceSaving") : t("settingsAppearanceSave")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
