import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// AGENTS.md verlangt: jedes Dokument steht im Index. Ein Dokument, das nirgends
// verlinkt ist, wird nicht gelesen und veraltet unbemerkt — es ist dann
// schlimmer als keins, weil es beim Suchen trotzdem auftaucht.

const FOLDER = new URL("../../docs/design/", import.meta.url);

test("jedes Dokument in docs/design/ steht im Index", async () => {
  const index = await readFile(fileURLToPath(new URL("README.md", FOLDER)), "utf8");
  const files = (await readdir(fileURLToPath(FOLDER)))
    .filter((name) => name.endsWith(".md") && name !== "README.md");

  assert.ok(files.length > 0, "docs/design/ enthält außer dem Index nichts — der Wächter liefe ins Leere");

  const unlinked = files.filter((name) => !index.includes(name)).sort();
  assert.deepEqual(unlinked, [], `Nicht im Index (docs/design/README.md):\n${unlinked.join("\n")}`);
});
