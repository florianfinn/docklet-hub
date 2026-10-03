// The lazy entry of the container log view (#258). Loaded with `import()`
// only (`lazy-only-dynamic` in `.dependency-cruiser.mjs`), so the view, its
// line renderer and the stream store land in a chunk of their own.

export { LogView as default } from "./LogView";
