// No call to the hub inside `useEffect` — the web loads data through TanStack
// Query (docs/design/feature-architecture.md, section 3; #256 on), not through
// an effect per screen. An effect that fetches has to track a dependency array,
// cancel a response that comes back after unmount, and keep its own loading
// and error state, and every screen did that a little differently. Acceptance
// criterion of the milestone "Umbau: Ordnung nach Features" (#271).
//
// What counts as a call to the hub is decided by WHERE the callee comes from,
// not by its name:
//
// - the global `fetch` (also as `window.fetch` or `globalThis.fetch`);
// - every value imported from a module named `api.ts` (`features/<name>/api.ts`,
//   `domain/hosts/api.ts`, `platform/session/api.ts`, `platform/i18n/api.ts`)
//   or from the transport `platform/http/transport.ts`;
// - the same names re-exported by a door (`index.ts`/`index.tsx`) from such a
//   module, one step deep: a feature hands out its calls through its door.
//
// That every module that calls the hub IS named `api.ts` holds
// `web/tests/no-api-call-in-effect.test.mjs`; without it the rule would go
// blind by renaming a file.
//
// ⚠️ A PROCESS IS NOT A READ. A stream, the shell session and the watch over
// an agent update run for minutes, send while they read, or have a deadline;
// none of that is a query. Such a process lives in a module outside React
// that owns its timers and its cancellation (`platform/streams/`,
// `features/shell/shell-session.ts`, `features/logs/log-stream.ts`,
// `features/hosts/agent-update-watch.ts`), and the view's effect only starts
// it and stops it in the cleanup. That module may call the hub; the effect
// may not.
//
// ⚠️ THE LIMIT, named instead of hidden: the rule sees the callee by name. An
// effect that calls a local helper which in turn calls the hub is not seen,
// and neither is an API function passed in as a property. The rule closes the
// direct way, which is the one every screen took before #256; it is not a
// proof, and a helper that only exists to hide a read from it is a finding in
// review.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const RE_EXPORT = /export\s*\{([^{}]*)\}\s*from\s*["']([^"']+)["']/g;

/** The file a relative import points to, or null for a package or a miss. */
export function resolveImport(fromFile, source) {
  if (!source.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), source.replace(/\.js$/, ""));
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** True for a module that calls the hub: an `api.ts`, or the transport. */
export function isApiModule(file) {
  return basename(file) === "api.ts" || /(^|[\\/])platform[\\/]http[\\/]transport\.ts$/.test(file);
}

function isDoor(file) {
  return /^index\.tsx?$/.test(basename(file));
}

/** The names a door re-exports from an API module, as exported. */
function apiNamesOfDoor(door) {
  const names = new Set();
  const source = readFileSync(door, "utf8");
  for (const match of source.matchAll(RE_EXPORT)) {
    const target = resolveImport(door, match[2]);
    if (target === null || !isApiModule(target)) continue;
    for (const raw of match[1].split(",")) {
      const spec = raw.trim();
      if (spec === "" || spec.startsWith("type ")) continue;
      const [, exported] = spec.match(/(?:\S+\s+as\s+)?(\S+)$/) ?? [];
      if (exported) names.add(exported);
    }
  }
  return names;
}

function isEffectCall(node) {
  const callee = node.callee;
  if (callee.type === "Identifier") return EFFECT_HOOKS.has(callee.name);
  return callee.type === "MemberExpression" && !callee.computed && EFFECT_HOOKS.has(callee.property.name);
}

function isGlobalFetch(callee) {
  if (callee.type === "Identifier") return callee.name === "fetch";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.name === "fetch" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "window" || callee.object.name === "globalThis")
  );
}

export const rule = {
  meta: {
    type: "problem",
    docs: { description: "No call to the hub inside useEffect; data comes through TanStack Query" },
    schema: [],
    messages: {
      apiCallInEffect:
        "{{name}} calls the hub inside {{hook}}. Load data with TanStack Query (useQuery/useMutation), not in an effect " +
        "(docs/design/feature-architecture.md, section 3)."
    }
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Local name → true for every value imported from an API module.
    const apiImports = new Set();
    // Effect callbacks we are inside of, innermost last.
    const effects = [];

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const target = resolveImport(filename, node.source.value);
        if (target === null) return;
        const direct = isApiModule(target);
        const viaDoor = !direct && isDoor(target) ? apiNamesOfDoor(target) : null;
        if (!direct && (viaDoor === null || viaDoor.size === 0)) return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === "type") continue;
          if (direct) {
            apiImports.add(specifier.local.name);
          } else if (specifier.type === "ImportSpecifier") {
            const imported = specifier.imported.name ?? specifier.imported.value;
            if (viaDoor.has(imported)) apiImports.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (isEffectCall(node)) {
          const callback = node.arguments[0];
          if (callback && (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression")) {
            effects.push({ callback, hook: node.callee.type === "Identifier" ? node.callee.name : node.callee.property.name });
          }
          return;
        }
        if (effects.length === 0) return;
        const callee = node.callee;
        const apiName = callee.type === "Identifier" && apiImports.has(callee.name) ? callee.name : null;
        if (apiName === null && !isGlobalFetch(callee)) return;
        const name = apiName ?? (callee.type === "Identifier" ? callee.name : `${callee.object.name}.fetch`);
        context.report({ node, messageId: "apiCallInEffect", data: { name, hook: effects[effects.length - 1].hook } });
      },
      ":function:exit"(node) {
        if (effects.length > 0 && effects[effects.length - 1].callback === node) effects.pop();
      }
    };
  }
};

export default { rules: { "no-api-call-in-effect": rule } };
