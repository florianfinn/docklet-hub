import fs from "node:fs";

// The source text of the HTTP surface, for tests that read it as text.
//
// Until #277 all of it stood in `index.ts` (7,352 lines). Since then
// `routes/` holds the handlers and `runtime/` what several handlers share;
// since #272 the dispatcher has its own file, `dispatch.ts`, so that the
// contract test can serve it without `index.ts` binding a port. A guard that
// went on reading one file alone would go blind to everything that moved: so
// every guard reads all four places, in a fixed order, through this one
// function.
//
// `dispatch.ts` comes LAST: `containerActions()` (route-handler-paths.ts)
// reads from the container dispatcher to the end of the text, and with
// `dispatch.ts` last that end is the end of the dispatcher's own file, as it
// was before.
//
// Not a `.test.ts` file because several test files import it; the build
// leaves it out (`tsconfig.build.json`).
export type SourceFile = { file: string; text: string };

const SRC = new URL("./", import.meta.url);

export function handlerSources(): SourceFile[] {
  const files: string[] = [];
  for (const folder of ["routes", "runtime"]) {
    const names = fs.readdirSync(new URL(`${folder}/`, SRC)).filter((name) => name.endsWith(".ts")).sort();
    files.push(...names.map((name) => `${folder}/${name}`));
  }
  files.push("index.ts", "dispatch.ts");
  return files.map((file) => ({ file, text: fs.readFileSync(new URL(file, SRC), "utf8") }));
}

// All of it as one text, in the order above.
export function handlerSource(): string {
  return handlerSources()
    .map(({ text }) => text)
    .join("\n");
}

// `file:line` for a line number of `handlerSource()`, so a guard over the
// joined text still names the place in the tree.
export function handlerLocation(row: number): string {
  let first = 1;
  for (const { file, text } of handlerSources()) {
    const count = text.split("\n").length;
    if (row < first + count) return `${file}:${row - first + 1}`;
    first += count;
  }
  return `?:${row}`;
}
