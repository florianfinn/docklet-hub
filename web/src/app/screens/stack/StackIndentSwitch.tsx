import { useState } from "react";
import { useTranslations } from "use-intl";

import { INDENT_STEPS, type IndentName } from "contract";
import type { TranslationKey } from "../../../platform/i18n/theme-labels";
import { cn } from "../../../platform/ui/lib/cn";

// Der Schalter für die Einrückung EINES Stacks (D7b/C2, #62;
// docs/design/hub-color-and-structure.md §4).
//
// ⚠️ ZWEI STUFEN AUS `INDENT_STEPS` UND KEIN FREIER WÄHLER — wie jede
// Stellschraube in D7 und aus demselben Grund (#62, Lehre aus
// dashboard-homelab#335). Diese Datei zählt keine Stufe selbst auf: sie liest
// die Liste aus `contract/src/presets.ts` und holt sich zu jedem Namen
// seinen Sprachschlüssel. Kommt dort eine dritte Stufe dazu, steht sie hier,
// ohne dass jemand etwas nachträgt — und fehlt ihr Sprachschlüssel unten, ist
// das ein Typfehler.
//
// ⚠️ ZWEI KNÖPFE UND KEINE AUSWAHLLISTE. `Select` aus `ui/shadcn` wäre die
// Bauform der Einstellungen, aber sein Inhalt reist bei Radix durch ein Portal
// und öffnet auf `pointerdown` — gemessen am 2026-09-06 unter happy-dom: nach
// `trigger.click()` steht kein Eintrag im Dokument. Bei ZWEI Stufen ist die
// Auswahlliste ohnehin der Umweg: sie verlangt zwei Klicks für eine Frage mit
// zwei Antworten, und beide Antworten passen nebeneinander.
//
// ⚠️ EIN KLICK SCHREIBT SOFORT, ohne „Speichern". Der Unterschied zum
// Marken-Editor steht dort begründet: hier trägt der Klick schon die
// vollständige Absicht, und `PUT …/display` trägt genau sie — es gibt kein
// Textfeld, das halb getippt unterwegs sein könnte.

/**
 * Der Sprachschlüssel je Stufe.
 *
 * ⚠️ Total über `IndentName` und nicht `Partial`: eine dritte Stufe in
 * `presets.ts` erzeugt hier `TS2741` und nennt den fehlenden Eintrag beim
 * Namen. Ohne diese Totalität stünde sie mit ihrem englischen Bezeichner auf
 * dem Schirm, und nichts daran wäre rot. Dieselbe Bauart wie
 * `HUE_LABELS`/`MARK_STYLE_LABELS` in `web/src/platform/i18n/theme-labels.ts`
 * — sie liegt hier und nicht dort, weil die Einrückung an den Stack gehört und
 * nicht in den Editor der Einstellungen.
 */
const INDENT_LABELS: Readonly<Record<IndentName, TranslationKey>> = {
  nested: "themeIndentNested",
  flat: "themeIndentFlat"
};

export type StackIndentSwitchProps = {
  indent: IndentName;
  /** Schreibt und meldet den gespeicherten Stand zurück. */
  onChange: (indent: IndentName) => Promise<void>;
};

export function StackIndentSwitch({ indent, onChange }: StackIndentSwitchProps) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const choose = (next: IndentName) => {
    if (next === indent) return;
    setBusy(true);
    setFailed(false);
    void onChange(next)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted-foreground">{t("stackIndentTitle")}</span>
        <span className="inline-flex overflow-hidden rounded-md border border-border">
          {INDENT_STEPS.map((step) => (
            <button
              key={step.name}
              type="button"
              disabled={busy}
              // ⚠️ `aria-pressed` und nicht `aria-selected`: das sind zwei
              // Schalter und keine Reiter. Ohne die Angabe hörte der
              // Screenreader zwei gleich klingende Knöpfe und nicht, welcher
              // von beiden gerade gilt — die Farbe allein sagt es ihm nicht.
              aria-pressed={step.name === indent}
              data-testid={`stack-indent-${step.name}`}
              onClick={() => choose(step.name)}
              className={cn(
                "px-2 py-0.5 text-[12px]",
                step.name === indent
                  ? "bg-accent text-foreground"
                  : "text-subtle-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {t(INDENT_LABELS[step.name])}
            </button>
          ))}
        </span>
      </div>
      {/* ⚠️ Der Hinweis steht IMMER da und nicht erst nach dem Klick: die
          Wirkung ist auf DIESER Fläche nicht zu sehen — hier steht nur der eine
          Stack —, sie zeigt sich in der Übersicht und im Deepdive. Ohne den
          Satz sähe der Schalter aus, als täte er nichts. */}
      <span className="text-[12px] text-subtle-foreground">{t("stackIndentHint")}</span>
      {failed ? (
        <span role="alert" className="text-[12px] text-destructive" data-testid="stack-indent-error">
          {t("stackIndentFailed")}
        </span>
      ) : null}
    </div>
  );
}
