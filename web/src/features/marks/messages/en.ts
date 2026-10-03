// English texts of the feature `marks` (#268). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// ⚠️ `satisfies typeof deMarks` is on the literal because only an object
// literal is checked by TypeScript for EXCESS properties: without it this part
// could silently carry a key that does not exist in German.

import type { deMarks } from "./de";

export const enMarks = {
  markMoreCount: "+{count}",
  markMoreNames: "{count, plural, one {# more mark} other {# more marks}}: {names}",

  // Die Tafel „Eigene Marken" (D7b, #62) — sie führt NUR die Liste;
  // zugeordnet wird am Stack und an der Container-Zeile.
  settingsMarksTitle: "Your own marks",
  settingsMarksCount: "{count, plural, one {# mark} other {# marks}}",
  settingsMarksHint:
    "A mark of your own only sorts — it is tinted and runs at half saturation. The marks the hub sets itself (“update”, “new”, “too old”) are filled because they suggest an action; they are not listed here and cannot be changed. A mark is attached to a stack or a container row, not on this panel.",
  settingsMarksEmpty: "No mark has been created yet. The first one starts in the field above.",
  settingsMarksEmptyReadOnly: "No mark has been created yet.",
  settingsMarksFailed: "The marks could not be loaded.",

  settingsMarkNew: "New mark",
  settingsMarkName: "Name",
  settingsMarkNamePlaceholder: "e.g. Backup",
  settingsMarkHue: "Tone",
  settingsMarkStyle: "Display",
  settingsMarkAdd: "Create mark",
  settingsMarkSave: "Save",
  settingsMarkRemove: "Remove",

  // Für den Screenreader: sichtbar steht der Name der Marke daneben.
  settingsMarkNameFor: "Name of {mark}",
  settingsMarkHueFor: "Tone for {mark}",
  settingsMarkStyleFor: "Display for {mark}",

  settingsMarkRemoveTitle: "Remove mark",
  // Der Satz sagt, was mit den Zuordnungen geschieht — `ON DELETE CASCADE`
  // in server/src/platform/db/migrations/007-marks.sql.
  settingsMarkRemoveConfirm:
    "“{mark}” will be removed and will disappear from every stack and every container it is attached to. This cannot be undone.",

  settingsMarkCreateFailed: "The mark could not be created.",
  settingsMarkSaveFailed: "The mark could not be saved.",
  settingsMarkDeleteFailed: "The mark could not be removed.",
  settingsMarkNameTaken: "Another mark already has this name.",
  settingsMarkNameEmpty: "A mark without a name sorts nothing.",

  // Assigning a mark (D7b/C2, #62) — in place, on a stack page and in the
  // container row of the deepdive.
  markAssignTitle: "Marks",
  markAssignAction: "Assign marks",
  markAssignForStack: "Assign marks to the stack {project}",
  markAssignForContainer: "Assign marks to {container}",
  markAssignEmpty: "No mark has been created yet.",
  markAssignEmptyAction: "Create the first one in the settings",
  markAssignFull: "A target carries no more than {max} marks. Remove one and the choice is back.",
  markAssignFailed: "The assignment could not be saved.",
  markRemove: "Remove mark {name}"
} satisfies typeof deMarks;
