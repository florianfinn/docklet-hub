import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Guard over the image (#250): no `*test-support*.ts` under `server/src`
// reaches the program of `server/tsconfig.build.json`. Such a file is a test
// harness without the ending `.test.ts`, so the first `exclude` pattern misses
// it, and each one needs its own pattern. Measured 2026-10-01: the pattern for
// `file-routes-test-support.ts` was missing, and `server/dist` carried it plus
// `port-test-support.js`, which it imports.
//
// tsc answers both questions itself, so this file does not rebuild its glob
// logic: `--showConfig` lists the root files left after `exclude`, and
// `--listFilesOnly` lists the whole program, imports included. The second
// catches what the comment in `tsconfig.build.json` warns about: an excluded
// file that built code imports is compiled anyway.
//
// The compiler is the one of this workspace (`web/node_modules`), the same
// version as the server's; the server tree is only read, not imported.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSC = join(ROOT, "web", "node_modules", "typescript", "bin", "tsc");
const BUILD_CONFIG = "tsconfig.build.json";

function runTsc(projectDir, args) {
  const result = spawnSync(process.execPath, [TSC, "-p", join(projectDir, BUILD_CONFIG), ...args], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  assert.ok(result.error === undefined, `tsc lief nicht: ${result.error}`);
  assert.equal(result.status, 0, `tsc ${args.join(" ")} endete mit ${result.status}:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

// Paths relative to the project, with forward slashes, whatever tsc printed.
function normalized(projectDir, path) {
  return relative(projectDir, join(projectDir, path)).replaceAll("\\", "/");
}

// Every `*test-support*.ts` below `src/`, read from the file system and not
// from `git ls-files`, so a file that is not staged yet counts as well.
function testSupportFiles(projectDir) {
  return readdirSync(join(projectDir, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).replaceAll("\\", "/")}`)
    .filter((path) => basename(path).includes("test-support") && path.endsWith(".ts"))
    .sort();
}

// One line per test-support file that reaches the build, with the way it got there.
function leaksIn(projectDir) {
  const roots = new Set(JSON.parse(runTsc(projectDir, ["--showConfig"])).files.map((path) => normalized(projectDir, path)));
  const program = new Set(
    runTsc(projectDir, ["--listFilesOnly"])
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((path) => relative(projectDir, path.trim()).replaceAll("\\", "/"))
  );
  const leaks = [];
  for (const file of testSupportFiles(projectDir)) {
    if (roots.has(file)) leaks.push(`${file}: von keinem exclude-Muster in ${BUILD_CONFIG} getroffen`);
    else if (program.has(file)) leaks.push(`${file}: ausgeschlossen, aber von gebautem Code importiert (tsc --explainFiles nennt den Weg)`);
  }
  return leaks;
}

test("keine Testhilfe unter server/src gelangt in den Bau", () => {
  const server = join(ROOT, "server");
  const files = testSupportFiles(server);
  assert.ok(files.length > 0, "keine *test-support*.ts unter server/src gefunden — der Wächter liefe ins Leere");
  assert.deepEqual(leaksIn(server), [], `Testhilfen im Bau von server/${BUILD_CONFIG}`);
});

test("der Wächter fällt an einer absichtlich falschen Beispieldatei", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-excludes-"));
  try {
    const files = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", rootDir: "./src", outDir: "./dist", strict: true }
      }),
      [BUILD_CONFIG]: JSON.stringify({
        extends: "./tsconfig.json",
        exclude: ["src/**/*.test.ts", "src/**/excluded-test-support.ts", "src/**/imported-test-support.ts"]
      }),
      // built code that imports an excluded harness
      "src/index.ts": 'import { harness } from "./imported-test-support.js";\nexport const start = harness;\n',
      "src/imported-test-support.ts": "export const harness = 1;\n",
      // no pattern, at the top and one level down
      "src/missing-test-support.ts": "export const missing = 1;\n",
      "src/nested/deep-test-support.ts": "export const deep = 1;\n",
      // allowed: its own pattern, the `.test.ts` pattern, a test importing a harness
      "src/excluded-test-support.ts": "export const excluded = 1;\n",
      "src/port-test-support.test.ts": 'import { excluded } from "./excluded-test-support.js";\nexport const port = excluded;\n'
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }

    assert.deepEqual(leaksIn(dir), [
      "src/imported-test-support.ts: ausgeschlossen, aber von gebautem Code importiert (tsc --explainFiles nennt den Weg)",
      `src/missing-test-support.ts: von keinem exclude-Muster in ${BUILD_CONFIG} getroffen`,
      `src/nested/deep-test-support.ts: von keinem exclude-Muster in ${BUILD_CONFIG} getroffen`
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
