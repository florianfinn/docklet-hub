import { useTranslations } from "use-intl";

import type { GlobalThemePreset } from "contract";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../platform/ui/shadcn/select";
import type { TranslationKey } from "../../platform/i18n/theme-labels";

// Eine Zeile der Feldliste einer globalen Stellschraube — links ihr Name,
// rechts ihre Stufe.
//
// ⚠️ WARUM DIESE ZEILE EIN EIGENES MODUL IST (B6, #5). Sie stand bis hierher
// in `AppearancePanel.tsx` und war dort privat. Mit der Tafel „Terminal"
// braucht sie eine ZWEITE Tafel: die vier Stellschrauben des Terminals sind
// dieselbe Art Wahl — ein Name, eine Stufenliste aus `presets.ts`, ein
// Auswahlfeld —, und ein zweites, danebengebautes Exemplar wäre die Sorte
// Doppelung, die beim ersten Nachziehen an einer Stelle auseinanderläuft
// (dieselbe Begründung wie bei `scope` als Liste in `presets.ts`).
//
// ⚠️ ZWEI VERWENDER, ZWEI WÄCHTER. Dieses Bauteil wird von „Darstellung" und
// von „Terminal" gezeichnet, und die zwei erwarten Gegenteiliges: „Terminal"
// setzt `testId` und (an einer Zeile) `hint`, „Darstellung" setzt beides
// nicht. Wer hier ein Attribut OHNE Bedingung setzt, bricht deshalb nur die
// eine Seite — und `web/tests/terminal-panel.test.tsx` bliebe grün.
//
// Gehalten wird die andere Seite von `web/tests/appearance-panel.test.tsx`: er
// zeichnet „Darstellung" in beiden Rollen und fordert an jeder gefundenen
// Zeile kein `data-testid` und kein `aria-describedby`. Gemessen:
// `data-testid={testId ?? "knob"}` am Auslöser → dort Prüfung 4 rot, am Text
// der Nur-Lese-Zeile → Prüfung 5 rot, `terminal-panel.test.tsx` beide Male
// grün. Eine neue wahlfreie Requisite gehört also mit ihrer Bedingung
// gebaut — `undefined` heißt „kein Attribut" —, und wer das umgeht, erfährt es
// dort.

/**
 * Eine Stufe, wie die Zeile sie braucht: der Bezeichner aus `presets.ts` und
 * der Sprachschlüssel dazu.
 *
 * ⚠️ Die Zuordnung geschieht HIER und nicht in der Zeile selbst. Ein
 * `labels[step.name]` innerhalb einer generischen Komponente ergibt einen
 * aufgeschobenen indizierten Typ, und `t(…)` verlangt daraufhin Argumente für
 * eine Meldung, die keine hat (gemessen: TS2345, „Argument of type '[]' is not
 * assignable"). Aufgelöst wird der Schlüssel deshalb an der Aufrufstelle, wo
 * die Stellschraube konkret ist.
 */
export type LabelledStep<S extends string> = { readonly name: S; readonly label: TranslationKey };

export function stepsOf<S extends string>(
  steps: readonly { readonly name: S }[],
  labels: Readonly<Record<S, TranslationKey>>
): LabelledStep<S>[] {
  return steps.map((step) => ({ name: step.name, label: labels[step.name] }));
}

type KnobRowProps<K extends keyof GlobalThemePreset> = {
  knob: K;
  label: TranslationKey;
  value: GlobalThemePreset[K];
  steps: readonly LabelledStep<GlobalThemePreset[K]>[];
  editable: boolean;
  onPick: (knob: K, step: GlobalThemePreset[K]) => void;
  /**
   * Griff für die Wächter, wahlfrei.
   *
   * ⚠️ Er sitzt auf dem Element, das den WERT trägt — auf dem Auslöser des
   * Auswahlfelds, solange geschrieben werden darf, und sonst auf dem Text
   * daneben. Ein Test kann damit dieselbe Zeile in beiden Fällen finden und
   * prüfen, was der Unterschied ist: ein Nicht-Admin sieht den Wert, aber
   * keine `role="combobox"`. Zwei getrennte Griffe hätten dieselbe Frage in
   * zwei Abfragen zerlegt, und der Fall „gar nichts gerendert" wäre durch
   * beide gefallen.
   */
  testId?: string;
  /**
   * Ein Satz unter der Zeile, wahlfrei — für eine Stufe, deren Name allein
   * eine falsche Erwartung weckt.
   *
   * ⚠️ Er hängt über `aria-describedby` AM AUSWAHLFELD und steht nicht bloß
   * daneben: wer die Zeile vorgelesen bekommt, hört sonst „Verlauf, 5.000
   * Zeilen" und nie den Satz, der sagt, was diese Zeilen sind. Die Kennung
   * kommt aus dem Namen der Stellschraube und nicht aus `testId` — der Hinweis
   * gehört zur Bedienung und nicht zum Wächter.
   */
  hint?: TranslationKey;
};

export function KnobRow<K extends keyof GlobalThemePreset>({
  knob,
  label,
  value,
  steps,
  editable,
  onPick,
  testId,
  hint
}: KnobRowProps<K>) {
  const t = useTranslations();
  const chosen = steps.find((step) => step.name === value);
  const hintId = hint === undefined ? undefined : `knob-${String(knob)}-hint`;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-2 last:border-b-0">
      <span className="min-w-[9rem] text-[13px] text-muted-foreground">{t(label)}</span>
      {editable ? (
        <Select
          value={value}
          onValueChange={(picked) => {
            // Die Verengung kommt aus der Stufenliste selbst: Radix liefert
            // einen `string`, und ein `as` wäre eine Behauptung über einen
            // Wert, der nicht aus diesem Modul stammt. Steht dort etwas, das
            // es nicht gibt, geschieht nichts.
            const step = steps.find((entry) => entry.name === picked);
            if (step !== undefined) onPick(knob, step.name);
          }}
        >
          {/* 15rem und nicht 13: gemessen im Bild vom 2026-09-06 war „im
              Farbton der Umgebung" — die längste Stufe des ganzen Satzes — am
              Pfeil abgeschnitten. */}
          <SelectTrigger
            size="sm"
            className="ml-auto w-[15rem]"
            data-testid={testId}
            aria-describedby={hintId}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {steps.map((step) => (
              <SelectItem
                key={step.name}
                value={step.name}
                data-testid={testId === undefined ? undefined : `${testId}-${step.name}`}
              >
                {t(step.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="ml-auto text-[13px]" data-testid={testId}>
          {chosen === undefined ? null : t(chosen.label)}
        </span>
      )}
      {/* `w-full` und damit eine eigene Zeile im umbrechenden Kasten: neben
          dem Auswahlfeld stünde der Satz je nach Breite mal daneben und mal
          darunter, und die Feldliste verlöre ihre Kante. */}
      {hint === undefined ? null : (
        <span id={hintId} className="w-full text-xs text-muted-foreground">
          {t(hint)}
        </span>
      )}
    </div>
  );
}
