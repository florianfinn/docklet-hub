// The door of the feature `resources` (#10). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`). The view itself loads
// lazily through `ResourcesView.lazy.tsx`.

export { deResources } from "./messages/de";
export { enResources } from "./messages/en";
