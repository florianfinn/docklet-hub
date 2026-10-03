// German texts of the feature `appearance` (#268): the panels "Darstellung",
// "Farbe der Bereiche" and "Farbe je Host" of the settings. German is the
// source of the message type; `en.ts` closes with `satisfies typeof deAppearance`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE NAMES OF THE KNOBS, OF THEIR STEPS AND OF THE TWO AREAS ARE NOT HERE.
// `themeKnob…`, `themeScheme…` and the other `theme…` keys stay in
// `platform/i18n/messages/` with `platform/i18n/theme-labels.ts`: the panel
// "Terminal" of the settings and the panel of the marks read them as well, and
// a feature may not import another.
//
// ⚠️ A FLAT LITERAL, NO GROUP `appearance: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.

export const deAppearance = {
  settingsColorSaveFailed: "Die Farbe konnte nicht gespeichert werden.",

  settingsHostColorTitle: "Farbe je Host",
  settingsHostColorTones: "{count, plural, one {# Ton im Vorrat} other {# Töne im Vorrat}}",
  settingsHostColorHint:
    "Der Vorrat ist fest: jeder Arm bekommt einen der Töne und eine der Stufen des Farbeinsatzes. Ein freier Farbwähler ergäbe Werte, für die es keine Regel gibt und die im hellen Wertesatz beliebig kontrastarm werden.",
  // Die Beschriftungen der beiden Auswahllisten einer Zeile. Sie sind für den
  // Screenreader da: sichtbar steht der Name des Arms daneben, gelesen würde
  // sonst zweimal „Auswahl" ohne Angabe, um welchen Arm es geht.
  settingsHueForHost: "Farbton für {host}",
  settingsInkForHost: "Farbeinsatz für {host}",

  settingsAppearanceTitle: "Darstellung",
  // Die Nebenangabe des Artboards (hub-palette.html Z. 771). Anders als bei der
  // Sprache gilt hier ALLES für alle — deshalb steht das Schreiben hinter der
  // Adminrolle.
  settingsAppearanceScope: "gilt für alle Benutzer",
  settingsAppearanceUnsaved: "Vorschau — noch nicht gespeichert",
  settingsAppearanceUnsavedHint:
    "Was hier steht, ist bisher nur die Vorschau. Wer die Fläche verlässt, ohne zu speichern, sieht wieder den gespeicherten Satz.",
  settingsAppearanceSave: "Speichern",
  settingsAppearanceDiscard: "Verwerfen",
  settingsAppearanceSaving: "Wird gespeichert …",
  settingsAppearanceSaveFailed: "Die Darstellung konnte nicht gespeichert werden.",

  settingsAreaColorTitle: "Farbe der Bereiche",
  settingsAreaColorReserved: "{count, plural, one {# Ton reserviert} other {# Töne reserviert}}",
  // Warum hier nichts zu wählen ist (D0 §1, letzter Absatz): die Schale
  // rechnet gedämpft, und zwei Töne sind ihr fest reserviert, damit sie nie an
  // einen Host fallen.
  settingsAreaColorHint:
    "Diese zwei Töne sind den Bereichen fest reserviert und stehen im Vorrat der Hosts nicht zur Wahl. Sonst könnte die Schale denselben Ton tragen wie eine Karte daneben — und zwei Bedeutungen stünden in derselben Farbe."
};
