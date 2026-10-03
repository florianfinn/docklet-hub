// The door of the feature `compose` (#265). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// ⚠️ THE VIEW IS NOT HERE. `ComposeView` is loaded lazily through
// `ComposeView.lazy.tsx`; a re-export here would pull it, and with it the
// editor, the diff, the apply card and prismjs, into every chunk that imports
// this door, the main chunk included (`docs/design/feature-architecture.md`,
// rule 3).

export { deCompose } from "./messages/de";
export { enCompose } from "./messages/en";
