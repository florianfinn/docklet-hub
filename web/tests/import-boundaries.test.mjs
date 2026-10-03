import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";

// Guard over the import graph (docs/design/feature-architecture.md, section 3):
// `web` and `server` do not import each other, `contract` imports neither, and
// there are no cycles. The rules live in `.dependency-cruiser.mjs`;
// dependency-cruiser runs offline over the source and needs no build.
//
// The run is the script `check:boundaries` of the root `package.json`, so the
// test and a manual `pnpm run check:boundaries` cannot disagree about scope.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG = join(ROOT, ".dependency-cruiser.mjs");
const KNOWN_FILE = ".dependency-cruiser-known-violations.json";
const BIN = join(ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");

// Length of the known-violations file. It drops only when the counting changes
// or a violation is fixed, and the new number goes in here with the reason;
// it never rises. Target of the rebuild: 0 (design document, section 8).
//
// 9 on 2026-10-01 (#246), measured with `pnpm run check:boundaries --no-ignore-known`:
// 8 imports from `web/tests/*.test.mjs` into `server/src` (agent contract and
// stream reasons) and one cycle, `web/src/api/client.ts` → `web/src/i18n/index.ts`
// → `web/src/i18n/LanguageProvider.tsx` → `web/src/api/client.ts`. Since #255
// the cycle runs through `web/src/platform/i18n/`; same cycle, same count.
//
// 5 since #272: the agent's values moved to `contract/src/agent/`, and the
// four imports of them from the former contract guard and
// `web/tests/hub-stream-reasons.test.mjs` into `server/src/agent/` read the
// contract instead.
//
// 4 since #274: the former contract guard is gone with the comparison against
// the separate agent repo, and its import into `server/src/agent/` with it.
//
// 0 since #271, the target of the rebuild: the cycle went with
// `web/src/api/client.ts` (`setLanguage` lives next to `LanguageProvider` in
// `platform/i18n/api.ts`), the hub's stream reasons moved to
// `contract/src/stream/`, and `api-read-only.test.mjs` reads
// `GET_ROUTES_WITH_EFFECT` from the server's source text instead of importing
// it. The file stays, empty, so a new violation has no quiet place to go: the
// case below compares it with what dependency-cruiser reports.
const KNOWN_VIOLATIONS_MARK = 0;

function runDepcruise(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.ok(result.error === undefined, `dependency-cruiser lief nicht: ${result.error}`);
  return result;
}

// `rule: from → to` for every violation in a JSON report.
function violationsOf(report) {
  return JSON.parse(report).summary.violations.map((violation) => `${violation.rule.name}: ${violation.from} → ${violation.to}`).sort();
}

// The arguments of the script `check:boundaries`, without the program name.
function boundaryScriptArgs() {
  const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["check:boundaries"];
  assert.ok(script, "package.json hat kein Skript `check:boundaries`");
  const [program, ...args] = script.split(" ");
  assert.equal(program, "depcruise");
  return args;
}

test("der echte Baum hält die Importgrenzen, Exit-Code 0", () => {
  const result = runDepcruise(boundaryScriptArgs(), ROOT);
  assert.equal(result.status, 0, `dependency-cruiser meldet einen Verstoß:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /no dependency violations found/);
});

test("die Ausnahmeliste hat die Marke und enthält nur noch bestehende Verstöße", () => {
  const known = JSON.parse(readFileSync(join(ROOT, KNOWN_FILE), "utf8"));
  assert.equal(
    known.length,
    KNOWN_VIOLATIONS_MARK,
    `${KNOWN_FILE} hat ${known.length} Einträge, die Marke steht auf ${KNOWN_VIOLATIONS_MARK}. ` +
      "Die Liste darf nur schrumpfen; schrumpft sie, sinkt die Marke mit Begründung."
  );

  // Without `--ignore-known` the run reports every known violation. An entry
  // the code no longer produces would sit in the list and cover a future one.
  const args = boundaryScriptArgs().filter((arg, index, all) => arg !== "--ignore-known" && all[index - 1] !== "--ignore-known");
  const result = runDepcruise([...args, "--output-type", "json"], ROOT);
  const current = new Set(violationsOf(result.stdout));
  const listed = known.map((entry) => `${entry.rule.name}: ${entry.from} → ${entry.to}`).sort();
  assert.deepEqual(listed, [...current].sort(), "Ausnahmeliste und tatsächliche Verstöße stimmen nicht überein");
});

test("jede Regel fällt an einer absichtlich falschen Beispieldatei", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-boundaries-"));
  try {
    const files = {
      "server/src/x.ts": "export const x = 1;\nexport type T = number;\n",
      "web/src/z.ts": "export const z = 1;\n",
      // web → server: static import, type-only import, dynamic import()
      "web/src/static.ts": 'import { x } from "../../server/src/x.ts";\nexport const a = x;\n',
      "web/src/type-only.ts": 'import type { T } from "../../server/src/x.ts";\nexport type U = T;\n',
      "web/src/dynamic.ts": 'export const load = () => import("../../server/src/x.ts");\n',
      // server → web
      "server/src/to-web.ts": 'import { z } from "../../web/src/z.ts";\nexport const b = z;\n',
      // contract → both
      "contract/src/to-server.ts": 'import { x } from "../../server/src/x.ts";\nexport const c = x;\n',
      "contract/src/to-web.ts": 'import { z } from "../../web/src/z.ts";\nexport const d = z;\n',
      // agent → server, web, an npm package; server, web, contract → agent (#276)
      "agent/src/a.ts": "export const a = 1;\n",
      "agent/src/to-server.ts": 'import { x } from "../../server/src/x.ts";\nexport const ax = x;\n',
      "agent/src/to-web.ts": 'import { z } from "../../web/src/z.ts";\nexport const az = z;\n',
      "agent/src/to-package.ts": 'import pad from "left-pad";\nexport const ap = pad;\n',
      "server/src/to-agent.ts": 'import { a } from "../../agent/src/a.ts";\nexport const sa = a;\n',
      "web/src/to-agent.ts": 'import { a } from "../../agent/src/a.ts";\nexport const wa = a;\n',
      "contract/src/to-agent.ts": 'import { a } from "../../agent/src/a.ts";\nexport const ca = a;\n',
      // allowed: agent → agent, agent → contract, agent → node: built-in
      "agent/src/fine.ts":
        'import fs from "node:fs";\nimport { g } from "../../contract/src/fine.ts";\nimport { a } from "./a.ts";\nexport const af = [fs, g, a];\n',
      // cycle inside one tree
      "server/src/cycle-a.ts": 'import { q } from "./cycle-b.ts";\nexport const p = () => q;\n',
      "server/src/cycle-b.ts": 'import { p } from "./cycle-a.ts";\nexport const q = () => p;\n',
      // allowed: web → web, contract → contract, server → contract
      "web/src/fine.ts": 'import { z } from "./z.ts";\nexport const e = z;\n',
      "contract/src/fine.ts": 'import { f } from "./base.ts";\nexport const g = f;\n',
      "contract/src/base.ts": "export const f = 1;\n",
      "server/src/fine.ts": 'import { g } from "../../contract/src/fine.ts";\nexport const h = g;\n',

      // Layer rules (#249). Feature `alpha` with its door, an inner file and
      // a lazy entry; everything else reaches in from somewhere.
      "server/src/features/alpha/index.ts": 'export { service } from "./service.ts";\n',
      "server/src/features/alpha/service.ts": 'import { http } from "../../platform/http/http.ts";\nexport const service = http;\n',
      "server/src/features/alpha/View.lazy.tsx": "export default function View() { return null; }\n",
      // feature → other feature, through its door and past it
      "server/src/features/beta/index.ts": 'import { service } from "../alpha/index.ts";\nexport const beta = service;\n',
      "server/src/features/beta/deep.ts": 'import { service } from "../alpha/service.ts";\nexport const deep = service;\n',
      // the same rule in the web tree
      "web/src/features/gamma/index.ts": 'import { delta } from "../delta/index.ts";\nexport const gamma = delta;\n',
      "web/src/features/delta/index.ts": "export const delta = 1;\n",
      // feature → a file of its tree outside domain/platform, server/src/agent/
      // included: since #272 the protocol is `contract`
      "server/src/features/alpha/to-app.ts": 'import { x } from "../../x.ts";\nexport const r = x;\n',
      "server/src/agent/logs.ts": "export const logs = 1;\n",
      "server/src/features/alpha/to-agent.ts": 'import { logs } from "../../agent/logs.ts";\nexport const t = logs;\n',
      // domain → feature
      "server/src/domain/hosts/to-feature.ts": 'import { service } from "../../features/alpha/index.ts";\nexport const i = service;\n',
      // platform → domain, platform → feature
      "server/src/platform/http/http.ts": "export const http = 1;\n",
      "server/src/platform/http/to-domain.ts": 'import { host } from "../../domain/hosts/index.ts";\nexport const j = host;\n',
      "server/src/platform/http/to-feature.ts": 'import { service } from "../../features/alpha/index.ts";\nexport const k = service;\n',
      // outside → past the door of a domain module (#251)
      "server/src/domain-past-door.ts": 'import { host } from "./domain/hosts/host.ts";\nexport const q = host;\n',
      // outside → past the door
      "server/src/past-door.ts": 'import { service } from "./features/alpha/service.ts";\nexport const l = service;\n',
      // a static import of a lazy entry, from outside and from its own door
      "server/src/static-lazy.ts": 'import View from "./features/alpha/View.lazy.tsx";\nexport const m = View;\n',
      "server/src/features/alpha/eager.ts": 'import View from "./View.lazy.tsx";\nexport const n = View;\n',
      // allowed: door, lazy entry by import(), feature → domain/platform
      // through the domain door, domain → platform, inside one feature, inside
      // one domain module
      "server/src/domain/hosts/host.ts": 'import { http } from "../../platform/http/http.ts";\nexport const host = http;\n',
      "server/src/domain/hosts/index.ts": 'export { host } from "./host.ts";\n',
      "server/src/features/alpha/uses-domain.ts": 'import { host } from "../../domain/hosts/index.ts";\nexport const o = host;\n',
      "server/src/through-door.ts": 'import { service } from "./features/alpha/index.ts";\nexport const p2 = service;\n',
      "server/src/lazy-load.ts": 'export const loadView = () => import("./features/alpha/View.lazy.tsx");\n',

      // The same layer rules in the web tree (#255): feature `delta` with its
      // door, an inner file and a lazy entry, `app/` above it, `domain/` and
      // `platform/` below.
      "web/src/features/delta/view.ts": 'import { http } from "../../platform/http/http.ts";\nexport const view = http;\n',
      "web/src/features/delta/View.lazy.tsx": "export default function View() { return null; }\n",
      "web/src/app/app.ts": "export const app = 1;\n",
      // feature → app (a layer above it)
      "web/src/features/delta/to-app.ts": 'import { app } from "../../app/app.ts";\nexport const r = app;\n',
      // domain → feature
      "web/src/domain/hosts/to-feature.ts": 'import { delta } from "../../features/delta/index.ts";\nexport const i = delta;\n',
      // platform → domain, platform → feature
      "web/src/platform/http/http.ts": "export const http = 1;\n",
      "web/src/platform/http/to-domain.ts": 'import { host } from "../../domain/hosts/index.ts";\nexport const j = host;\n',
      "web/src/platform/http/to-feature.ts": 'import { delta } from "../../features/delta/index.ts";\nexport const k = delta;\n',
      // outside → past the door of a domain module, and of a feature
      "web/src/app/domain-past-door.ts": 'import { host } from "../domain/hosts/host.ts";\nexport const q = host;\n',
      "web/src/app/past-door.ts": 'import { view } from "../features/delta/view.ts";\nexport const l = view;\n',
      // a static import of a lazy entry, from app/ and from inside the feature
      "web/src/app/static-lazy.ts": 'import View from "../features/delta/View.lazy.tsx";\nexport const m = View;\n',
      "web/src/features/delta/eager.ts": 'import View from "./View.lazy.tsx";\nexport const n = View;\n',
      // allowed: app → door, app → lazy entry by import(), feature → domain
      // door, domain → platform, inside one feature
      "web/src/domain/hosts/host.ts": 'import { http } from "../../platform/http/http.ts";\nexport const host = http;\n',
      "web/src/domain/hosts/index.ts": 'export { host } from "./host.ts";\n',
      "web/src/features/delta/uses-domain.ts": 'import { host } from "../../domain/hosts/index.ts";\nimport { view } from "./view.ts";\nexport const o = host + view;\n',
      "web/src/app/through-door.ts": 'import { delta } from "../features/delta/index.ts";\nexport const p2 = delta;\n',
      "web/src/app/lazy-load.ts": 'export const loadView = () => import("../features/delta/View.lazy.tsx");\n',

      // xterm and the surface file that holds it are `import()` only (#261):
      // the surface itself imports xterm statically and is allowed to; a
      // static import of xterm or of the surface from anywhere else is not.
      "web/src/features/shell/terminal-surface.ts": 'import { Terminal } from "@xterm/xterm";\nexport const surface = Terminal;\n',
      "web/src/features/shell/eager-xterm.ts": 'import { Terminal } from "@xterm/xterm";\nexport const x = Terminal;\n',
      "web/src/features/shell/eager-surface.ts": 'import { surface } from "./terminal-surface.ts";\nexport const y = surface;\n',
      "web/src/features/shell/load-surface.ts": 'export const loadSurface = () => import("./terminal-surface.ts");\n',

      // prismjs and the diff of `compose` are `import()` only from outside
      // the feature (#271): inside it the view imports them statically; a
      // static import from another feature is not allowed, `import()` is.
      // A stand-in package, so the import resolves the way the real one does
      // (an unresolved `import()` has the type `unknown`, not `dynamic-import`).
      "node_modules/prismjs/package.json": '{ "name": "prismjs", "version": "0.0.0" }\n',
      "node_modules/prismjs/components/prism-core.js": "export default {};\n",
      "web/src/features/compose/DiffView.tsx": 'import Prism from "prismjs/components/prism-core.js";\nexport const DiffView = Prism;\n',
      "web/src/features/compose/ComposeView.tsx": 'import { DiffView } from "./DiffView.tsx";\nexport const view = DiffView;\n',
      "web/src/features/files/eager-prism.ts": 'import Prism from "prismjs/components/prism-core.js";\nexport const p3 = Prism;\n',
      "web/src/features/files/load-prism.ts": 'export const loadPrism = () => import("prismjs/components/prism-core.js");\n'
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }

    // The default report fails with a non-zero exit code; the JSON report,
    // which names each violation, exits 0 whatever it holds.
    const scope = ["contract/src", "server/src", "web/src", "agent/src", "--config", CONFIG];
    const failing = runDepcruise(scope, dir);
    assert.notEqual(failing.status, 0, "dependency-cruiser fand an der falschen Beispieldatei nichts");

    assert.deepEqual(violationsOf(runDepcruise([...scope, "--output-type", "json"], dir).stdout), [
      "agent-only-contract: agent/src/to-package.ts → left-pad",
      "agent-only-contract: agent/src/to-server.ts → server/src/x.ts",
      "agent-only-contract: agent/src/to-web.ts → web/src/z.ts",
      "contract-not-server-or-web: contract/src/to-server.ts → server/src/x.ts",
      "contract-not-server-or-web: contract/src/to-web.ts → web/src/z.ts",
      "diff-editor-only-dynamic: web/src/features/files/eager-prism.ts → node_modules/prismjs/components/prism-core.js",
      "domain-not-features: server/src/domain/hosts/to-feature.ts → server/src/features/alpha/index.ts",
      "domain-not-features: web/src/domain/hosts/to-feature.ts → web/src/features/delta/index.ts",
      "domain-only-through-door: server/src/domain-past-door.ts → server/src/domain/hosts/host.ts",
      "domain-only-through-door: web/src/app/domain-past-door.ts → web/src/domain/hosts/host.ts",
      "feature-not-other-feature: server/src/features/beta/deep.ts → server/src/features/alpha/service.ts",
      "feature-not-other-feature: server/src/features/beta/index.ts → server/src/features/alpha/index.ts",
      "feature-not-other-feature: web/src/features/gamma/index.ts → web/src/features/delta/index.ts",
      "feature-only-lower-layers: server/src/features/alpha/to-agent.ts → server/src/agent/logs.ts",
      "feature-only-lower-layers: server/src/features/alpha/to-app.ts → server/src/x.ts",
      "feature-only-lower-layers: web/src/features/delta/to-app.ts → web/src/app/app.ts",
      "feature-only-through-door: server/src/past-door.ts → server/src/features/alpha/service.ts",
      "feature-only-through-door: web/src/app/past-door.ts → web/src/features/delta/view.ts",
      "lazy-only-dynamic: server/src/features/alpha/eager.ts → server/src/features/alpha/View.lazy.tsx",
      "lazy-only-dynamic: server/src/static-lazy.ts → server/src/features/alpha/View.lazy.tsx",
      "lazy-only-dynamic: web/src/app/static-lazy.ts → web/src/features/delta/View.lazy.tsx",
      "lazy-only-dynamic: web/src/features/delta/eager.ts → web/src/features/delta/View.lazy.tsx",
      "no-circular: server/src/cycle-a.ts → server/src/cycle-b.ts",
      "not-into-agent: contract/src/to-agent.ts → agent/src/a.ts",
      "not-into-agent: server/src/to-agent.ts → agent/src/a.ts",
      "not-into-agent: web/src/to-agent.ts → agent/src/a.ts",
      "platform-not-domain-or-features: server/src/platform/http/to-domain.ts → server/src/domain/hosts/index.ts",
      "platform-not-domain-or-features: server/src/platform/http/to-feature.ts → server/src/features/alpha/index.ts",
      "platform-not-domain-or-features: web/src/platform/http/to-domain.ts → web/src/domain/hosts/index.ts",
      "platform-not-domain-or-features: web/src/platform/http/to-feature.ts → web/src/features/delta/index.ts",
      "server-not-web: server/src/to-web.ts → web/src/z.ts",
      "web-not-server: web/src/dynamic.ts → server/src/x.ts",
      "web-not-server: web/src/static.ts → server/src/x.ts",
      "web-not-server: web/src/type-only.ts → server/src/x.ts",
      "xterm-only-dynamic: web/src/features/shell/eager-surface.ts → web/src/features/shell/terminal-surface.ts",
      "xterm-only-dynamic: web/src/features/shell/eager-xterm.ts → @xterm/xterm"
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Doors carry named re-exports only (rule 3, #255) ────────────────────────
//
// dependency-cruiser sees where an import goes, not what a door hands out.
// `export *` would let every new export of an inner file leave the feature by
// itself; an own declaration in the door would make the door a second home
// for code. So a door, `features/<name>/index.ts(x)` or
// `domain/<name>/index.ts(x)` in the server and the web, holds nothing but
// `export { … } from "…"` and `export type { … } from "…"`.
//
// Read from the file system and not through `git ls-files`, so a door that is
// not yet staged is checked too.

const DOOR_LAYERS = ["server/src/features", "server/src/domain", "web/src/features", "web/src/domain"];
const NAMED_RE_EXPORT = /export\s+(?:type\s+)?\{[^{}]*\}\s*from\s*(["'])[^"']+\1\s*;?/g;

// What is left of a door once comments and named re-exports are gone: one
// entry per statement that does not belong there, with its line.
function doorFindings(source) {
  const body = stripComments(source);
  const blanked = body.replace(NAMED_RE_EXPORT, (match) => match.replace(/[^\n]/g, " "));
  const findings = [];
  const lines = blanked.split("\n");
  lines.forEach((line, index) => {
    if (line.trim() !== "") findings.push(`${index + 1}: ${line.trim()}`);
  });
  return findings;
}

// Every door below `root`, as paths relative to it.
function doorFiles(root) {
  const doors = [];
  for (const layer of DOOR_LAYERS) {
    const layerPath = join(root, layer);
    if (!existsSync(layerPath)) continue;
    for (const entry of readdirSync(layerPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of ["index.ts", "index.tsx"]) {
        if (existsSync(join(layerPath, entry.name, name))) doors.push(`${layer}/${entry.name}/${name}`);
      }
    }
  }
  return doors.sort();
}

function doorReport(root) {
  return doorFiles(root).flatMap((door) =>
    doorFindings(readFileSync(join(root, door), "utf8")).map((finding) => `${door}:${finding}`)
  );
}

test("jede Tür des echten Baums trägt nur benannte Re-Exporte", () => {
  const doors = doorFiles(ROOT);
  // Marke: 2 am 2026-10-01 (#255) — `server/src/features/logs/index.ts` und
  // `server/src/domain/hosts/index.ts`. Sie wächst mit jedem Feature und wird
  // dann nachgezogen; sie sinkt nur, wenn ein Feature aufgelöst wird.
  assert.ok(doors.length >= 2, `nur ${doors.length} Türen gefunden (${doors.join(", ")}) — der Wächter liefe ins Leere`);
  const findings = doorReport(ROOT);
  assert.deepEqual(findings, [], `Eine Tür trägt mehr als benannte Re-Exporte:\n${findings.join("\n")}`);
});

test("die Türregel fällt an absichtlich falschen Türen in Server und Web", () => {
  const dir = mkdtempSync(join(tmpdir(), "door-exports-"));
  try {
    const files = {
      "server/src/features/star/index.ts": 'export * from "./service.ts";\n',
      "server/src/domain/namespace/index.ts": 'export * as hosts from "./host.ts";\n',
      "web/src/features/own/index.ts": "export const own = 1;\n",
      "web/src/features/relay/index.tsx": 'import { view } from "./view.ts";\nexport { view };\n',
      "web/src/domain/fallback/index.ts": 'export { a } from "./a.ts";\nexport default 1;\n',
      // allowed: named and type re-exports over several lines, with comments
      "web/src/features/fine/index.ts":
        '// The door.\nexport {\n  view, // the view\n  type View\n} from "./view.ts";\nexport type { Props } from "./props.ts";\n/* end */\n'
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }

    assert.deepEqual(doorReport(dir), [
      "server/src/domain/namespace/index.ts:1: export * as hosts from \"./host.ts\";",
      "server/src/features/star/index.ts:1: export * from \"./service.ts\";",
      "web/src/domain/fallback/index.ts:2: export default 1;",
      "web/src/features/own/index.ts:1: export const own = 1;",
      "web/src/features/relay/index.tsx:1: import { view } from \"./view.ts\";",
      "web/src/features/relay/index.tsx:2: export { view };"
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The lazy views stay out of the main chunk (#258, #261, #263) ────────────
//
// `lazy-only-dynamic` keeps a `.lazy.tsx` entry from being imported
// statically. It does not see the view BEHIND the entry: a door that
// re-exported `LogView`, or a neighbour that imported a helper from
// `LogView.tsx`, would pull the view into the main chunk while every rule
// stays green, and `React.lazy` would load an empty chunk. This case walks the
// import graph from `web/src/main.tsx` along static imports only.
//
// The shell view (#261) is the same case with a second step: its terminal
// file `terminal-surface.ts` and xterm behind it are loaded with `import()`
// from inside the view, so they are not reachable statically even from the
// view's own chunk (`xterm-only-dynamic`).

/** Every module reachable from `entry` along imports that are not `import()`. */
function staticallyReachable(modules, entry) {
  const bySource = new Map(modules.map((module) => [module.source, module]));
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const module = bySource.get(queue.shift());
    for (const dependency of module?.dependencies ?? []) {
      if (dependency.dynamic || seen.has(dependency.resolved)) continue;
      seen.add(dependency.resolved);
      queue.push(dependency.resolved);
    }
  }
  return seen;
}

const LAZY_VIEWS = [
  "web/src/features/logs/LogView.tsx",
  "web/src/features/logs/StackLogView.tsx",
  "web/src/features/shell/ShellView.tsx",
  "web/src/features/files/FilesView.tsx",
  "web/src/features/compose/ComposeView.tsx"
];
const TERMINAL_SURFACE = "web/src/features/shell/terminal-surface.ts";
const isXterm = (source) => /(^|node_modules\/)@xterm\//.test(source);
// The editor and diff of `compose` and prismjs behind them (#271).
const DIFF_EDITOR = [
  "web/src/features/compose/DiffView.tsx",
  "web/src/features/compose/ComposeEditor.tsx",
  "web/src/features/compose/YamlCode.tsx",
  "web/src/features/compose/text-diff.ts",
  "web/src/features/compose/yaml-highlight.ts"
];
const isPrism = (source) => /(^|node_modules\/)prismjs\//.test(source);

test("die lazy Ansichten sind von main.tsx aus nur über import() erreichbar", () => {
  const result = runDepcruise(["web/src", "--config", CONFIG, "--output-type", "json"], ROOT);
  assert.equal(result.status, 0, `dependency-cruiser lief nicht sauber:\n${result.stderr}`);
  const { modules } = JSON.parse(result.stdout);
  const sources = new Set(modules.map((module) => module.source));
  for (const view of LAZY_VIEWS) assert.ok(sources.has(view), `${view} fehlt im Graphen — der Fall liefe ins Leere`);

  const reachable = staticallyReachable(modules, "web/src/main.tsx");
  // The graph must be read at all: the app shell is reached statically.
  assert.ok(reachable.has("web/src/App.tsx"), "von main.tsx aus ist nichts statisch erreichbar — der Graph ist leer");
  const leaked = LAZY_VIEWS.filter((view) => reachable.has(view));
  assert.deepEqual(leaked, [], `Statisch erreichbar und damit im Haupt-Chunk: ${leaked.join(", ")}`);
});

test("xterm ist nur über import() erreichbar, auch aus der lazy Shell-Ansicht", () => {
  const result = runDepcruise(["web/src", "--config", CONFIG, "--output-type", "json"], ROOT);
  assert.equal(result.status, 0, `dependency-cruiser lief nicht sauber:\n${result.stderr}`);
  const { modules } = JSON.parse(result.stdout);
  // Present in the graph at all, or the case would run into the void.
  assert.ok(modules.some((module) => module.source === TERMINAL_SURFACE), `${TERMINAL_SURFACE} fehlt im Graphen`);
  assert.ok(modules.some((module) => isXterm(module.source)), "xterm fehlt im Graphen — der Fall liefe ins Leere");

  for (const entry of ["web/src/main.tsx", "web/src/features/shell/ShellView.lazy.tsx"]) {
    const leaked = [...staticallyReachable(modules, entry)].filter((source) => source === TERMINAL_SURFACE || isXterm(source));
    assert.deepEqual(leaked, [], `Von ${entry} aus statisch erreichbar: ${leaked.join(", ")}`);
  }
});

test("Diff und Editor von compose sind von main.tsx aus nur über import() erreichbar", () => {
  const result = runDepcruise(["web/src", "--config", CONFIG, "--output-type", "json"], ROOT);
  assert.equal(result.status, 0, `dependency-cruiser lief nicht sauber:\n${result.stderr}`);
  const { modules } = JSON.parse(result.stdout);
  // Present in the graph at all, or the case would run into the void.
  const sources = new Set(modules.map((module) => module.source));
  for (const file of DIFF_EDITOR) assert.ok(sources.has(file), `${file} fehlt im Graphen — der Fall liefe ins Leere`);
  assert.ok(modules.some((module) => isPrism(module.source)), "prismjs fehlt im Graphen — der Fall liefe ins Leere");

  const leaked = [...staticallyReachable(modules, "web/src/main.tsx")].filter(
    (source) => DIFF_EDITOR.includes(source) || isPrism(source)
  );
  assert.deepEqual(leaked, [], `Von main.tsx aus statisch erreichbar: ${leaked.join(", ")}`);
});

test("der Gang über den Graphen folgt statischen Importen und lässt import() liegen", () => {
  const modules = [
    { source: "main.tsx", dependencies: [{ resolved: "screen.tsx", dynamic: false }] },
    {
      source: "screen.tsx",
      dependencies: [
        { resolved: "View.lazy.tsx", dynamic: true },
        { resolved: "helpers.ts", dynamic: false }
      ]
    },
    { source: "View.lazy.tsx", dependencies: [{ resolved: "View.tsx", dynamic: false }] },
    { source: "helpers.ts", dependencies: [] },
    { source: "View.tsx", dependencies: [] }
  ];
  assert.deepEqual([...staticallyReachable(modules, "main.tsx")].sort(), ["helpers.ts", "main.tsx", "screen.tsx"]);
  // A helper that imports the view statically pulls it in.
  modules[3].dependencies.push({ resolved: "View.tsx", dynamic: false });
  assert.ok(staticallyReachable(modules, "main.tsx").has("View.tsx"));
});
