// The door of the feature `logs` (#258). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// ⚠️ THE TWO VIEWS ARE NOT HERE. `LogView` and `StackLogView` are loaded
// lazily through `LogView.lazy.tsx` and `StackLogView.lazy.tsx`; a re-export
// here would pull them into every chunk that imports this door, the main
// chunk included (`docs/design/feature-architecture.md`, rule 3).

export { LogSettingsPanel } from "./LogSettingsPanel";
export { deLogs } from "./messages/de";
export { enLogs } from "./messages/en";
