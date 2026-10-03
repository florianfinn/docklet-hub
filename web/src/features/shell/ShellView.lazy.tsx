// The lazy entry of the shell view (#261). Loaded with `import()` only
// (`lazy-only-dynamic` in `.dependency-cruiser.mjs`), so the view, its
// terminal helpers and the code that loads xterm land in a chunk of their own.

export { ShellView as default } from "./ShellView";
