// German texts of the feature `marks` (#268): the panel "Eigene Marken" of the
// settings, the pick list that assigns marks to a stack or a container, and the
// counter on a row that shows the marks beyond the limit. German is the source
// of the message type; `en.ts` closes with `satisfies typeof deMarks`.
//
// Put together with the texts of every other surface in
// `web/src/app/i18n/messages.ts`; `platform/` may not import a feature.
//
// ⚠️ THE NAMES OF THE TONES AND OF THE TWO DISPLAYS ARE NOT HERE. `themeHue…`,
// `themeMarkStyle…` and `themeIndent…` stay in `platform/i18n/messages/` with
// `platform/i18n/theme-labels.ts`: the colour panel of the arms (the feature
// `appearance`) and the stack page show them too, and a feature may not import
// another.
//
// ⚠️ A FLAT LITERAL, NO GROUP `marks: { … }`. `web/tests/languages.test.mjs`
// reads the top level of a flat literal; a second level would be invisible to
// it, and its assertions would fall away without a test going red.

export const deMarks = {
  // Der Deckel auf den eigenen Marken einer ZEILE (D7b/C1, #62). In einer
  // Zeile — am Stack wie am Container — stehen höchstens zwei Marken, danach
  // dieser Zähler; auf der Seite eines Stacks stehen alle, dort ist Platz.
  //
  // ⚠️ Der NAME einer Marke steht NICHT hier: er kommt aus den Daten und ist
  // so wenig übersetzbar wie der Name eines Arms. Übersetzt wird nur, was um
  // ihn herum steht — deshalb reicht `markMoreNames` die Namen als `{names}`
  // durch, statt sie selbst zu bilden.
  //
  // ⚠️ „+2" ist für einen Screenreader „plus zwei" und sagt nichts. Sichtbar
  // steht deshalb `markMoreCount`, vorgelesen wird `markMoreNames` — derselbe
  // Aufbau wie bei „6/8" und `stackRunningOf` eine Zeile höher.
  markMoreCount: "+{count}",
  markMoreNames: "{count, plural, one {# weitere Marke} other {# weitere Marken}}: {names}",

  // Die Tafel „Eigene Marken" (D7b, #62). Sie führt NUR DIE LISTE: anlegen,
  // umbenennen, Ton, Darstellung, entfernen. ZUGEORDNET wird an Ort und Stelle
  // — auf der Stack-Seite und in der Container-Zeile (Entscheidung des
  // Betreibers vom 2026-09-06). Der Name einer Marke steht deshalb nirgends
  // hier: er ist ein Text des Betreibers und kommt aus der Ablage.
  settingsMarksTitle: "Eigene Marken",
  settingsMarksCount: "{count, plural, one {# Marke} other {# Marken}}",
  settingsMarksHint:
    "Eine eigene Marke ordnet nur — sie ist getönt und läuft auf halber Sättigung. Die Marken des Hubs selbst („Update“, „neu“, „zu alt“) sind gefüllt, weil sie eine Handlung nahelegen; sie stehen nicht hier und lassen sich nicht ändern. Zugeordnet wird eine Marke am Stack und an der Container-Zeile, nicht auf dieser Fläche.",
  settingsMarksEmpty: "Es ist noch keine Marke angelegt. Die erste entsteht im Feld darüber.",
  settingsMarksEmptyReadOnly: "Es ist noch keine Marke angelegt.",
  settingsMarksFailed: "Die Marken konnten nicht geladen werden.",

  settingsMarkNew: "Neue Marke",
  settingsMarkName: "Name",
  // Ein Beispiel und keine Anweisung: der Platzhalter zeigt, wie ein Name
  // aussieht, und verschwindet beim ersten Zeichen.
  settingsMarkNamePlaceholder: "z. B. Sicherung",
  settingsMarkHue: "Farbton",
  settingsMarkStyle: "Darstellung",
  settingsMarkAdd: "Marke anlegen",
  settingsMarkSave: "Speichern",
  settingsMarkRemove: "Entfernen",

  // Für den Screenreader: sichtbar steht der Name der Marke daneben, gelesen
  // würde sonst dreimal „Auswahl“ ohne Angabe, um welche Marke es geht.
  settingsMarkNameFor: "Name von {mark}",
  settingsMarkHueFor: "Farbton für {mark}",
  settingsMarkStyleFor: "Darstellung für {mark}",

  settingsMarkRemoveTitle: "Marke entfernen",
  // ⚠️ Der Satz sagt, was mit den ZUORDNUNGEN geschieht. Das ist keine
  // Höflichkeit: `mark_assignment.mark_id` trägt `ON DELETE CASCADE`
  // (server/src/platform/db/migrations/007-marks.sql), die Marke geht also in einem
  // Schritt von jedem Stack und jedem Container ab, dem sie zugeordnet war.
  // Wer das erst hinterher merkt, hat keinen Weg zurück.
  settingsMarkRemoveConfirm:
    "„{mark}“ wird entfernt und geht damit von jedem Stack und jedem Container ab, dem sie zugeordnet ist. Das lässt sich nicht zurücknehmen.",

  settingsMarkCreateFailed: "Die Marke konnte nicht angelegt werden.",
  settingsMarkSaveFailed: "Die Marke konnte nicht gespeichert werden.",
  settingsMarkDeleteFailed: "Die Marke konnte nicht entfernt werden.",
  // Der Fall, den der Betreiber tatsächlich auslöst — 409 vom Server, weil der
  // Name in `hub_mark` eindeutig ist.
  settingsMarkNameTaken: "Diesen Namen trägt schon eine Marke.",
  settingsMarkNameEmpty: "Eine Marke ohne Namen ordnet nichts.",

  // Das ZUORDNEN einer Marke (D7b/C2, #62). Es geschieht an Ort und Stelle:
  // auf der Seite eines Stacks und in der Container-Zeile des Deepdives
  // (Entscheidung des Betreibers vom 2026-09-06).
  //
  // ⚠️ Der NAME einer Marke steht auch hier nirgends — er ist ein Text des
  // Betreibers und kommt aus der Ablage.
  markAssignTitle: "Marken",
  markAssignAction: "Marken vergeben",
  // Für den Screenreader am Auslöser. „Marken vergeben" allein sagte in einer
  // Liste von dreißig Zeilen nicht, für welche der dreißig.
  markAssignForStack: "Marken für den Stack {project} vergeben",
  markAssignForContainer: "Marken für {container} vergeben",
  markAssignEmpty: "Es ist noch keine Marke angelegt.",
  markAssignEmptyAction: "Die erste in den Einstellungen anlegen",
  // ⚠️ The limit lives in `contract` (MARK_IDS_MAX) and is passed in as a
  // number — never copied, or it would stand in two places and drift apart.
  markAssignFull:
    "Mehr als {max} Marken trägt ein Ziel nicht. Ziehen Sie erst eine ab, dann steht die Auswahl wieder da.",
  markAssignFailed: "Die Zuordnung konnte nicht gespeichert werden.",
  markRemove: "Marke {name} abziehen"
};
