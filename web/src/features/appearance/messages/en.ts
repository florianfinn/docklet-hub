// English texts of the feature `appearance` (#268). The reasons stand next to
// the German texts (`de.ts`); here is only the translation.
//
// ⚠️ `satisfies typeof deAppearance` is on the literal because only an object
// literal is checked by TypeScript for EXCESS properties: without it this part
// could silently carry a key that does not exist in German.

import type { deAppearance } from "./de";

export const enAppearance = {
  settingsColorSaveFailed: "The color could not be saved.",

  settingsHostColorTitle: "Color per host",
  settingsHostColorTones: "{count, plural, one {# tone available} other {# tones available}}",
  settingsHostColorHint:
    "The set is fixed: every host gets one of the tones and one of the tinting steps. A free color picker would produce values that have no rule behind them and that turn arbitrarily low in contrast in the light value set.",
  // Für den Screenreader: sichtbar steht der Name des Arms daneben, gelesen
  // würde sonst zweimal „Auswahl" ohne Angabe, um welchen Arm es geht.
  settingsHueForHost: "Tone for {host}",
  settingsInkForHost: "Tinting for {host}",

  settingsAppearanceTitle: "Appearance",
  // Die Nebenangabe des Artboards (hub-palette.html Z. 771).
  settingsAppearanceScope: "applies to all users",
  settingsAppearanceUnsaved: "Preview — not saved yet",
  settingsAppearanceUnsavedHint:
    "What you see here is only the preview so far. Leaving this screen without saving brings back the saved set.",
  settingsAppearanceSave: "Save",
  settingsAppearanceDiscard: "Discard",
  settingsAppearanceSaving: "Saving …",
  settingsAppearanceSaveFailed: "The appearance could not be saved.",

  settingsAreaColorTitle: "Color of the areas",
  settingsAreaColorReserved: "{count, plural, one {# tone reserved} other {# tones reserved}}",
  // Warum hier nichts zu wählen ist (D0 §1, letzter Absatz).
  settingsAreaColorHint:
    "These two tones are reserved for the areas and are not offered in the host palette. Otherwise the shell could carry the same tone as a card next to it — and two meanings would stand in the same color."
} satisfies typeof deAppearance;
