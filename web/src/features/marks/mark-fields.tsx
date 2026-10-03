import { useTranslations } from "use-intl";

import {
  HUE_TONES,
  MARK_STYLE_STEPS,
  type HueName,
  type MarkStyleName,
  type MarkThemePreset,
  type MarkView
} from "contract";

import { HUE_LABELS, MARK_STYLE_LABELS } from "../../platform/i18n/theme-labels";
import { knownKey } from "../../platform/i18n/wire-labels";
import { MarkChip } from "../../platform/ui/marks";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../../platform/ui/shadcn/select";

// The fields of an own mark in the panel of the marks (#268): what the operator
// has in a row right now (`MarkDraft`) and the two lists that choose the tone
// and the display. Split out of `MarksPanel.tsx`, which stood at 587 lines; the
// row, the form for a new mark and the dialog before removing are files of
// their own next to it, and every reason stays where the code is.

/**
 * Die Verengung auf eine Stufe kommt aus der Stufenliste und nicht aus einer
 * Zusicherung: `onValueChange` von Radix liefert einen `string`, und ein
 * `as HueName` wäre eine Behauptung über einen Wert, der nicht aus diesem
 * Modul stammt. Steht dort etwas, das es nicht gibt, geschieht nichts.
 *
 * Dieselben zwei Wächter stehen in `HostColorPanel.tsx` für `hue` und `ink` —
 * sie sind hier NICHT wiederverwendet, weil `isHueName` dort nicht ausgegeben
 * wird und ein Export quer durch den Ordner die Tafel an eine andere bände,
 * mit der sie nichts teilt als drei Zeilen.
 */
function isHueName(value: string): value is HueName {
  return HUE_TONES.some((tone) => tone.name === value);
}

function isMarkStyleName(value: string): value is MarkStyleName {
  return MARK_STYLE_STEPS.some((step) => step.name === value);
}

/** Was der Betreiber gerade in einer Zeile stehen hat — Name und beide Stufen. */
export type MarkDraft = MarkThemePreset & { name: string };

export function draftOf(mark: MarkView): MarkDraft {
  return { name: mark.name, hue: mark.hue, style: mark.style };
}

export function isSame(a: MarkDraft, b: MarkDraft): boolean {
  return a.name.trim() === b.name.trim() && a.hue === b.hue && a.style === b.style;
}

/**
 * Die zwei Auswahllisten, die überall gleich aussehen.
 *
 * ⚠️ Die AUFGEKLAPPTE LISTE zeigt jeden Eintrag als MARKE, und zwar mit dem
 * Namen, der gerade im Feld steht: so wählt der Betreiber den Ton an SEINEM
 * Wort und nicht an einem Musterwort. Steht noch nichts im Feld, tritt der Name
 * der Stufe ein — ein leerer Fleck beantwortete die Frage „welcher Ton ist das"
 * nicht.
 *
 * ⚠️ DER ZUGEKLAPPTE KNOPF ZEIGT DAS WORT UND NICHT DIE MARKE. Das ist am Bild
 * entschieden und nicht am Schreibtisch: mit `<SelectValue />` rendert Radix
 * den Inhalt des gewählten Eintrags, also noch einmal die Marke — und die Zeile
 * trug DREIMAL dieselbe Pille nebeneinander (Vorschau, Ton, Darstellung),
 * gemessen am gebauten Bildschirm am 2026-09-06. Drei gleich aussehende Pillen
 * beantworten nicht, welche davon was einstellt. Die Vorschau links in der
 * Zeile zeigt die Marke; die zwei Knöpfe sagen, wie der Ton und die Darstellung
 * HEISSEN.
 */
export function ToneSelect({
  draft,
  label,
  onChange
}: {
  draft: MarkDraft;
  label: string;
  onChange: (hue: HueName) => void;
}) {
  const t = useTranslations();
  const hueKey = knownKey(HUE_LABELS, draft.hue);
  return (
    <Select
      value={draft.hue}
      onValueChange={(value) => {
        if (isHueName(value)) onChange(value);
      }}
    >
      <SelectTrigger size="sm" className="w-[8rem]" aria-label={label}>
        {/* ⚠️ Nachgeschlagen und nicht indiziert (`i18n/wire-labels.ts`): der
            Entwurf wird aus einer GESPEICHERTEN Marke gefüllt, und deren Ton
            kam über die Leitung. Die Auswahl darunter läuft dagegen über
            `HUE_TONES` und ist geschlossen — dort wird nicht nachgeschlagen. */}
        <SelectValue>{hueKey === null ? draft.hue : t(hueKey)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {HUE_TONES.map((tone) => (
          <SelectItem key={tone.name} value={tone.name}>
            <MarkChip
              mark={{
                name: draft.name.trim() === "" ? t(HUE_LABELS[tone.name]) : draft.name.trim(),
                hue: tone.name,
                style: draft.style
              }}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StyleSelect({
  draft,
  label,
  onChange
}: {
  draft: MarkDraft;
  label: string;
  onChange: (style: MarkStyleName) => void;
}) {
  const t = useTranslations();
  const styleKey = knownKey(MARK_STYLE_LABELS, draft.style);
  return (
    <Select
      value={draft.style}
      onValueChange={(value) => {
        if (isMarkStyleName(value)) onChange(value);
      }}
    >
      <SelectTrigger size="sm" className="w-[8rem]" aria-label={label}>
        <SelectValue>{styleKey === null ? draft.style : t(styleKey)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {MARK_STYLE_STEPS.map((step) => (
          <SelectItem key={step.name} value={step.name}>
            <MarkChip
              mark={{
                name: draft.name.trim() === "" ? t(MARK_STYLE_LABELS[step.name]) : draft.name.trim(),
                hue: draft.hue,
                style: step.name
              }}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
