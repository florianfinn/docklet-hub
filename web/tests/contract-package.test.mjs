import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { MARK_IDS_MAX } from "contract";

// Guard over the shared package `contract/` (docs/design/feature-architecture.md,
// sections 2 and 5): it imports neither from `server/` nor from `web/` nor
// from `agent/`, and server, web and image each read the form meant for them —
// tsx and Vite the TypeScript source via the `source` export condition, the
// image the built `dist`.
//
// ⚠️ Sees tracked files only (`git ls-files`). A new file under `contract/`
// counts once it is staged.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const FOREIGN_PACKAGES = new Set(["server", "web", "agent"]);

const read = (path) => readFileSync(new URL(path, `file://${ROOT}`), "utf8");
const readJson = (path) => JSON.parse(read(path));

// Every module specifier in a source text: static imports and re-exports,
// side-effect imports, dynamic `import()` and `require()`.
export function moduleSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

// What a specifier in `file` (repo-relative, POSIX) breaks, or null. Allowed
// are relative paths that stay inside `contract/` and declared dependencies.
export function boundaryViolation(file, specifier, dependencies) {
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    return target.startsWith("contract/") ? null : `verlässt contract/ nach ${target}`;
  }
  if (specifier.startsWith("node:")) {
    return "ist ein Node-Modul — contract läuft auch im Browser";
  }
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (FOREIGN_PACKAGES.has(name)) {
    return `greift in das Paket ${name}`;
  }
  return dependencies.has(name) ? null : `ist keine Abhängigkeit von contract (${name})`;
}

test("die Grenzprüfung erkennt jeden Weg hinaus", () => {
  const dependencies = new Set(["zod"]);
  const file = "contract/src/api/hosts.ts";
  assert.deepEqual(
    moduleSpecifiers(`import { a } from "../marks.js";\nexport { b } from "./c.js";\nimport "zod";\nconst d = await import("server");\nrequire("web/x");`),
    ["../marks.js", "./c.js", "zod", "server", "web/x"]
  );
  assert.equal(boundaryViolation(file, "../marks.js", dependencies), null);
  assert.equal(boundaryViolation(file, "zod", dependencies), null);
  assert.ok(boundaryViolation(file, "../../../server/src/theme/presets.js", dependencies));
  assert.ok(boundaryViolation(file, "../../../web/src/api/client.js", dependencies));
  assert.ok(boundaryViolation(file, "server", dependencies));
  assert.ok(boundaryViolation(file, "agent/src/main.js", dependencies));
  assert.ok(boundaryViolation(file, "node:fs", dependencies));
  assert.ok(boundaryViolation(file, "react", dependencies));
});

test("contract importiert weder aus server/ noch aus web/", () => {
  const manifest = readJson("contract/package.json");
  const dependencies = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  for (const name of FOREIGN_PACKAGES) {
    assert.ok(!dependencies.has(name), `contract/package.json nennt ${name} als Abhängigkeit`);
  }

  const files = execFileSync("git", ["ls-files", "contract/"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => SOURCE_EXTENSIONS.test(file));
  assert.ok(files.length > 0, "git ls-files lieferte unter contract/ nichts — der Wächter liefe ins Leere");

  const findings = files.flatMap((file) =>
    moduleSpecifiers(read(file))
      .map((specifier) => ({ specifier, problem: boundaryViolation(file, specifier, dependencies) }))
      .filter((finding) => finding.problem !== null)
      .map((finding) => `${file}: „${finding.specifier}" ${finding.problem}`)
  );
  assert.deepEqual(findings, []);
});

test("jeder Export von contract hat Quelle, Typen und gebautes JS", () => {
  const { exports } = readJson("contract/package.json");
  const entries = Object.entries(exports);
  assert.ok(entries.length > 0, "contract/package.json hat kein `exports`");

  for (const [subpath, conditions] of entries) {
    // `source` must come first: conditions match in object order, and the
    // build relies on `types` and `default` once `source` is switched off.
    assert.deepEqual(Object.keys(conditions), ["source", "types", "default"], `Bedingungen von ${subpath}`);
    const stem = conditions.source.match(/^\.\/src\/(.+)\.ts$/)?.[1];
    assert.ok(stem, `${subpath}: „source" zeigt nicht auf ./src/*.ts`);
    assert.equal(conditions.types, `./dist/${stem}.d.ts`, `${subpath}: „types"`);
    assert.equal(conditions.default, `./dist/${stem}.js`, `${subpath}: „default"`);
  }
});

test("Server und Web lesen contract in Entwicklung und Tests aus der Quelle", () => {
  // A test that resolves `contract` through `default` would run against
  // whatever `contract/dist` happens to hold — possibly a stale build.
  assert.match(import.meta.resolve("contract"), /\/contract\/src\/index\.ts$/);
  assert.equal(MARK_IDS_MAX, 8);

  const serverScripts = readJson("server/package.json").scripts;
  const webScripts = readJson("web/package.json").scripts;
  for (const [name, script] of [
    ["server dev", serverScripts.dev],
    ["server test", serverScripts.test],
    ["web test", webScripts.test]
  ]) {
    assert.match(script, /--conditions=source\b/, `${name} läuft ohne die Bedingung „source"`);
  }

  for (const tsconfig of ["server/tsconfig.json", "web/tsconfig.json"]) {
    assert.match(read(tsconfig), /"customConditions":\s*\["source"\]/, `${tsconfig} prüft nicht gegen die Quelle`);
  }
  assert.match(read("server/tsconfig.build.json"), /"customConditions":\s*\[\]/, "der Serverbau liest contract nicht aus dist");
  assert.match(read("web/vite.config.ts"), /conditions:\s*\["source"/, "Vite liest contract nicht aus der Quelle");
});

test("Prüfkette und Image schließen contract ein", () => {
  const scripts = readJson("package.json").scripts;
  assert.match(scripts.lint, /^pnpm --filter contract run lint && /, "`pnpm run lint` prüft contract nicht zuerst");
  assert.match(scripts.build, /^pnpm --filter contract run build && /, "`pnpm run build` baut contract nicht vor dem Server");
  assert.ok(parse(read("pnpm-workspace.yaml")).packages.includes("contract"), "pnpm-workspace.yaml führt contract nicht");
  assert.match(read("contract/tsconfig.json"), /"erasableSyntaxOnly":\s*true/, "contract erlaubt nicht strippbare Syntax wie `enum`");

  const dockerfile = read("server/Dockerfile");
  const [buildStage, runtimeStage] = dockerfile.split(/^FROM .* AS runtime$/m);
  assert.ok(runtimeStage, "server/Dockerfile hat keine Stufe „runtime“");
  assert.match(buildStage, /^COPY contract\/package\.json contract\/$/m, "das Manifest von contract fehlt vor dem Install");
  assert.match(runtimeStage, /^COPY --from=build \/app\/contract\/dist \.\/contract\/dist$/m, "das Image trägt contract/dist nicht");
  assert.match(runtimeStage, /^COPY --from=build \/app\/contract\/package\.json /m, "das Image trägt das Manifest von contract nicht");
  assert.doesNotMatch(runtimeStage, /contract\/src/, "das Image trägt die TypeScript-Quelle von contract");
});

test("zod hat in contract dieselbe Fassung wie im Server", () => {
  const contractSpec = readJson("contract/package.json").dependencies?.zod;
  assert.ok(contractSpec, "zod ist keine Abhängigkeit von contract");
  assert.equal(contractSpec, readJson("server/package.json").dependencies.zod);

  const { importers } = parse(read("pnpm-lock.yaml"));
  assert.equal(importers.contract.dependencies.zod.version, importers.server.dependencies.zod.version);
});
