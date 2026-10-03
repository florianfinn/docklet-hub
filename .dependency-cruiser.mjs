// Import boundaries, checked by dependency-cruiser as part of `pnpm run test`
// (web/tests/import-boundaries.test.mjs). Rules and reasons:
// docs/design/feature-architecture.md, section 3.
//
// #246 switched on only what already held then; #249 added the layer rules,
// which no file broke because the new folders were still empty. #254 added
// `feature-only-lower-layers` with the first feature, `logs`; #261 added
// `xterm-only-dynamic` with the second, `shell`; #271 added
// `diff-editor-only-dynamic` for the editor and diff of `compose`. #255 gave the
// web its folders (`app`, `features`, `domain`, `platform`) under the same
// rules; what a door may hand out (named re-exports only) is not an import,
// so `web/tests/import-boundaries.test.mjs` checks that next to this file.
// Violations that existed during the rebuild were named in
// `.dependency-cruiser-known-violations.json`; the list could only shrink, and
// the test holds its length against a mark. Since #271 it is empty and the
// mark is 0. Run from the repo root: all paths below are relative to it.

export default {
  forbidden: [
    {
      name: "web-not-server",
      comment: "The web bundle must not reach into server/. Shared knowledge lives in contract/.",
      severity: "error",
      from: { path: "^web/" },
      to: { path: "^server/" }
    },
    {
      name: "server-not-web",
      comment: "The server must not reach into web/. Shared knowledge lives in contract/.",
      severity: "error",
      from: { path: "^server/" },
      to: { path: "^web/" }
    },
    {
      name: "contract-not-server-or-web",
      comment: "contract/ is the shared package; it depends on neither side.",
      severity: "error",
      from: { path: "^contract/" },
      to: { path: "^(server|web)/" }
    },
    // Rule 4 of section 3 for the agent (#276): it imports nothing but its own
    // files, `contract` and Node's built-in modules, and nothing imports it.
    {
      name: "agent-only-contract",
      comment: "The agent imports its own files, contract/ and node: built-ins only. A runtime dependency needs its own decision (docs/design/feature-architecture.md, section 6).",
      severity: "error",
      from: { path: "^agent/" },
      to: { pathNot: "^(agent|contract)/", dependencyTypesNot: ["core"] }
    },
    {
      name: "not-into-agent",
      comment: "server/, web/ and contract/ do not reach into agent/. Shared knowledge lives in contract/.",
      severity: "error",
      from: { path: "^(server|web|contract)/" },
      to: { path: "^agent/" }
    },
    // The layer rules (rules 1 to 3 of section 3). Written once for both trees:
    // `$1` is the tree a file sits in, so the server and the web read the same
    // rule. The server got its folders in #249, the web in #255.
    {
      name: "feature-not-other-feature",
      comment: "A feature imports no other feature. What two need goes to domain/ or platform/, what two show together is put together in app/.",
      severity: "error",
      from: { path: "^(server|web)/src/features/([^/]+)/" },
      to: { path: "^$1/src/features/", pathNot: "^$1/src/features/$2/" }
    },
    {
      name: "feature-only-lower-layers",
      comment:
        "A feature imports its own files, domain/, platform/ and contract, nothing else of its tree (layers app → features → domain → platform). " +
        "The agent protocol is contract/src/agent/ since #272; server/src/agent/ is no exception.",
      severity: "error",
      from: { path: "^(server|web)/src/features/([^/]+)/" },
      to: {
        path: "^$1/src/",
        // Another feature is `feature-not-other-feature`; it is left out here
        // so one import does not report twice.
        pathNot: ["^$1/src/(features|domain|platform)/"]
      }
    },
    {
      name: "domain-not-features",
      comment: "domain/ knows no feature.",
      severity: "error",
      from: { path: "^(server|web)/src/domain/" },
      to: { path: "^$1/src/features/" }
    },
    {
      name: "platform-not-domain-or-features",
      comment: "platform/ knows neither domain/ nor a feature.",
      severity: "error",
      from: { path: "^(server|web)/src/platform/" },
      to: { path: "^$1/src/(domain|features)/" }
    },
    {
      name: "feature-only-through-door",
      comment:
        "From outside, a feature is reached through its index.ts only, or through a `.lazy.tsx` entry loaded with import(). " +
        "The web guards and DOM tests in web/tests/ are not outside: they test a feature's parts the way the server tests do from inside its folder (#258).",
      severity: "error",
      // ⚠️ `web/tests/` IS EXEMPT, AND ONLY FROM THIS RULE. The server keeps its
      // tests inside the feature (`server/src/features/logs/*.test.ts`); the web
      // runs its tests from `web/tests/` (`web/package.json`, script `test`),
      // and a DOM test of a view must reach the view, not a door that hides it.
      // Every other rule still holds for the tests: no test may import the
      // server, and a `.lazy.tsx` entry stays `import()` only.
      from: { pathNot: ["^(server|web)/src/features/", "^web/tests/"] },
      to: {
        path: "^(server|web)/src/features/[^/]+/",
        pathNot: ["^(server|web)/src/features/[^/]+/index\\.tsx?$", "\\.lazy\\.tsx$"]
      }
    },
    {
      name: "domain-only-through-door",
      comment: "From outside, a domain module is reached through its index.ts only (#251). Its door keeps what callers must not hold, such as the step that picks an agent secret.",
      severity: "error",
      from: { pathNot: "^(server|web)/src/domain/" },
      to: { path: "^(server|web)/src/domain/[^/]+/", pathNot: "^(server|web)/src/domain/[^/]+/index\\.tsx?$" }
    },
    {
      name: "lazy-only-dynamic",
      comment: "A `.lazy.tsx` entry is loaded with import() only. A static import pulls it into the main chunk, and React.lazy does nothing.",
      severity: "error",
      from: {},
      to: { path: "\\.lazy\\.tsx$", dependencyTypesNot: ["dynamic-import"] }
    },
    {
      name: "xterm-only-dynamic",
      comment:
        "xterm and the file that holds it, features/shell/terminal-surface.ts, are loaded with import() only (#261). " +
        "A static import pulls the terminal into the chunk of the importer, and the shell view would not be the only one to pay for it.",
      severity: "error",
      // The surface file itself imports xterm statically: it IS the dynamic
      // chunk. Everything else, tests included, reaches it with `import()`.
      from: { pathNot: "^web/src/features/shell/terminal-surface\\.ts$" },
      to: {
        path: ["(^|node_modules/)@xterm/", "^web/src/features/shell/terminal-surface\\.ts$"],
        dependencyTypesNot: ["dynamic-import"]
      }
    },
    {
      name: "diff-editor-only-dynamic",
      comment:
        "The compose editor and diff (prismjs, the highlighting, the diff and the editor of features/compose/) are reached from outside that feature with import() only, through ComposeView.lazy.tsx (#271). " +
        "A static import pulls prismjs and the diff into the chunk of the importer.",
      severity: "error",
      // Inside the feature the view imports them statically: ComposeView.tsx
      // IS the lazy chunk. That the door and the rest of the feature do not
      // pull them into the main chunk is checked by the graph walk from
      // main.tsx in web/tests/import-boundaries.test.mjs. The DOM tests and
      // guards in web/tests/ are not bundled and test these parts directly,
      // as for `feature-only-through-door`.
      from: { pathNot: ["^web/src/features/compose/", "^web/tests/"] },
      to: {
        path: [
          "(^|node_modules/)prismjs/",
          "^web/src/features/compose/(DiffView|ComposeEditor|YamlCode)\\.tsx$",
          "^web/src/features/compose/(text-diff|yaml-highlight)\\.ts$"
        ],
        dependencyTypesNot: ["dynamic-import"]
      }
    },
    {
      name: "no-circular",
      comment: "No import cycles. The known-violations file is empty since #271.",
      severity: "error",
      from: {},
      to: { circular: true }
    }
  ],
  options: {
    // `import type` counts: a type import couples the trees just as much.
    tsPreCompilationDeps: true,
    // `import()` is followed by default; #271 depends on it.
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)dist/" },
    enhancedResolveOptions: {
      // Off by default in dependency-cruiser; without it `contract` and every
      // other package with `exports` stays unresolved.
      exportsFields: ["exports"],
      // The same condition tsx, tsc and Vite use to read `contract` from its
      // source (`contract/package.json`, `exports`).
      conditionNames: ["source", "import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"]
    }
  }
};
