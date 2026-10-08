// The door of the feature `settings` (#269). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// What leaves the feature: the frame of the page with its tab bar
// (`SettingsView`), the two panels the feature owns (the language of the
// account and the address of the hub from outside) and the shape of a tab.
// `app/settings/settings-tabs.tsx` builds the list of tabs from these and from
// the panels of the other features, so `settings` imports no feature.

export { SettingsView } from "./SettingsView";
export { LanguagePanel } from "./LanguagePanel";
export { HubNetworkPanel } from "./HubNetworkPanel";
export type { SettingsTab, SettingsTabContext } from "./settings-tabs";
export { deSettingsPage } from "./messages/de";
export { enSettingsPage } from "./messages/en";

export { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";
