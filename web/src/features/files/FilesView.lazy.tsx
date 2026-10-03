// The lazy entry of the file view (#263). Loaded with `import()` only
// (`lazy-only-dynamic` in `.dependency-cruiser.mjs`), so the share chooser, the
// list, the editor and the upload land in a chunk of their own.

export { FilesView as default } from "./FilesView";
