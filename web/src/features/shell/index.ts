// The door of the feature `shell` (#261). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// ⚠️ THE VIEW IS NOT HERE. `ShellView` is loaded lazily through
// `ShellView.lazy.tsx`; a re-export here would pull it, and with it the
// terminal helpers, into every chunk that imports this door, the main chunk
// included (`docs/design/feature-architecture.md`, rule 3). xterm itself sits
// behind a second `import()` inside the view (`xterm-only-dynamic`).

export { deShell } from "./messages/de";
export { enShell } from "./messages/en";
