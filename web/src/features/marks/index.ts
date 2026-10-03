// The door of the feature `marks` (#268). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// The own marks show on three surfaces that belong to no feature: the overview,
// the container list and the page of a stack. Each puts the list of marks
// (`MarkList`) next to a row and offers the pick list (`MarkAssign`) to an
// administrator, so both leave through this door, with the pure functions that
// carry a stored answer into the overview the page already holds
// (`overview-marks.ts`) and the writes the pick list and the stack switches
// call. The panel of the settings is the fourth surface.

export { MarksPanel } from "./MarksPanel";
export { MarkList, ROW_MARK_LIMIT } from "./MarkList";
export type { MarkListProps } from "./MarkList";
export { MarkAssign } from "./MarkAssign";
export type { MarkAssignProps } from "./MarkAssign";
export type { MarkAssignment } from "./assignment";
export { withContainerMarks, withStackIndent, withStackMarks } from "./overview-marks";
export { setContainerMarks, setStackHidden, setStackIndent, setStackMarks } from "./api";
export { useMarks } from "./mark-queries";
export { deMarks } from "./messages/de";
export { enMarks } from "./messages/en";
