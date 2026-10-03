// The lazy entry of the compose tab (#265). Loaded with `import()` only
// (`lazy-only-dynamic` in `.dependency-cruiser.mjs`), so the editor, the diff,
// the apply card, the `.env` view and the YAML highlighter (prismjs) land in a
// chunk of their own.

export { ComposeView as default } from "./ComposeView";
