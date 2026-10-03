// The door of the feature `appearance` (#268). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// The provider of the global theme stands above every surface
// (`web/src/main.tsx`) and a screen reads it (`useGlobalTheme`), so it leaves
// through this door with the panels of the settings. `KnobRow` and `stepsOf`
// leave as well: the panel "Terminal" is still a part of the settings
// (`app/settings/TerminalPanel.tsx`) and builds on the same row; it moves
// with the settings (#269).

export { GlobalThemeProvider, useGlobalTheme } from "./GlobalThemeProvider";
export type { GlobalThemeContextValue } from "./GlobalThemeProvider";
export { AppearancePanel } from "./AppearancePanel";
export { AreaColorPanel } from "./AreaColorPanel";
export { HostColorPanel } from "./HostColorPanel";
export { KnobRow, stepsOf } from "./KnobRow";
export { deAppearance } from "./messages/de";
export { enAppearance } from "./messages/en";
