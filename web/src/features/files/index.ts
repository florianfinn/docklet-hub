// The door of the feature `files` (#263). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// ⚠️ THE VIEW IS NOT HERE. `FilesView` is loaded lazily through
// `FilesView.lazy.tsx`; a re-export here would pull it, and with it the list,
// the editor and the upload, into every chunk that imports this door, the main
// chunk included (`docs/design/feature-architecture.md`, rule 3).

export { deFiles } from "./messages/de";
export { enFiles } from "./messages/en";
