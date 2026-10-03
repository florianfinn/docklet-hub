// The lazy entry of "new project" (#3). Loaded with `import()` only
// (`lazy-only-dynamic` in `.dependency-cruiser.mjs`), so the editor does not
// land in the chunk of the hosts screen.

export { NewProjectDialog as default } from "./NewProjectDialog";
