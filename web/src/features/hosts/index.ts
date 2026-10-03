// The door of the feature `hosts` (#267). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// The hosts screen is eager: it is a page of the navigation, small next to
// the views behind a tab, and the first thing after the overview an operator
// opens. The card shows the load of an arm through a slot (`renderLoad`),
// which `app/screens/HostsScreen.tsx` fills until the feature `metrics` (#283)
// takes the load view over.

export { HostsView } from "./HostsView";
export type { HostRole, RenderHostActions, RenderHostLoad } from "./HostCard";
export { deHosts } from "./messages/de";
export { enHosts } from "./messages/en";
