import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry } from "./registry.js";
import {
  containerIdFromPath,
  DEFINITION_ACTIONS,
  findRoute,
  INTERNAL_ONLY_ACTIONS,
  checkTier,
  ROUTES
} from "./route-policy.js";
import {
  examplePathsFromRegex,
  containerActions,
  dispatchForms,
  foreignPathnameObjects,
  handlerPaths,
  prefixGuards
} from "./route-handler-paths.js";
import { handlerLocation, handlerSource } from "./handler-source-test-support.js";

// A concrete path for a pattern: every placeholder gets a value that the
// dispatcher in index.ts would actually accept.
function examplePath(pattern: string): string {
  return pattern
    .split("/")
    .map((part) => {
      return part.startsWith(":") ? "beispiel" : part;
    })
    .join("/");
}

test("every route is fully declared", () => {
  for (const route of ROUTES) {
    assert.ok(route.methods.length > 0, `${route.pattern} without a method`);
    assert.ok(route.pattern.startsWith("/"), `${route.pattern} is not a path`);
    assert.ok(route.audit.length > 0, `${route.pattern} without an audit name`);
    assert.ok(
      ["intern-only", "extern-ok", "public"].includes(route.tier),
      `${route.pattern} with an unknown tier`
    );
  }
});

test("there is exactly one \"public\" route", () => {
  // /health sits before the secret check. If a second one is added, that is a
  // decision someone should make explicitly — not one that gets lost in a
  // table.
  const publicRoutes = ROUTES.filter((route) => route.tier === "public");
  assert.deepEqual(publicRoutes.map((route) => route.pattern), ["/health"]);
});

test("findRoute matches placeholders, but not across segment boundaries", () => {
  assert.equal(findRoute("GET", "/containers/abc123/logs")?.pattern, "/containers/:id/logs");
  assert.equal(findRoute("GET", "/containers/abc123/logs/mehr"), null);
  assert.equal(findRoute("GET", "/containers//logs"), null);
  assert.equal(findRoute("GET", "/containers"), ROUTES.find((r) => r.pattern === "/containers"));
  // The method counts too: PUT /registry exists, GET /registry does not.
  assert.equal(findRoute("PUT", "/registry")?.tier, "intern-only");
  assert.equal(findRoute("GET", "/registry"), null);
});

test("the more specific pattern wins", () => {
  // Otherwise the answer for /stacks/adopt would depend on the order in which
  // the table was written.
  assert.equal(findRoute("POST", "/stacks/adopt")?.audit, "stack-adopt");
  assert.equal(findRoute("POST", "/stacks/raw")?.audit, "compose-raw");
  assert.equal(findRoute("POST", "/containers")?.audit, "create");
});

test("the dry run stands as its own, non-mutating row", () => {
  // #85: it runs the same check chain as the apply but writes nothing —
  // and therefore must NOT be listed as mutating, otherwise the table would be
  // worthless as information.
  const preview = findRoute("POST", "/containers/abc123/compose-raw-preview");
  assert.equal(preview?.pattern, "/containers/:id/compose-raw-preview");
  assert.equal(preview?.tier, "intern-only");
  assert.equal(preview?.mutating, false);
  assert.equal(preview?.audit, "compose-raw-preview");
  // It reveals the host's image inventory (which images are missing) — that is
  // not in the read response. Hence the editor's gate action, not the reading
  // one.
  assert.equal(preview?.gate, "compose-raw");
  assert.ok(INTERNAL_ONLY_ACTIONS.has("compose-raw"));
  // No GET: the draft is up to 256 KiB large and belongs in a body.
  assert.equal(findRoute("GET", "/containers/abc123/compose-raw-preview"), null);
  // And it stays a row of its own: the apply next to it still mutates.
  assert.equal(findRoute("POST", "/containers/abc123/compose-raw")?.mutating, true);
});

test("Compose candidates are read-only, the persistent selection is internal and mutating", () => {
  const candidates = findRoute("GET", "/containers/abc123/compose-candidates");
  assert.equal(candidates?.tier, "intern-only");
  assert.equal(candidates?.mutating, false);
  assert.equal(candidates?.gate, "compose-raw-read");
  for (const method of ["PUT", "DELETE"] as const) {
    const selection = findRoute(method, "/containers/abc123/compose-selection");
    assert.equal(selection?.tier, "intern-only");
    assert.equal(selection?.mutating, true);
    assert.equal(selection?.gate, "compose-raw");
  }
  assert.equal(findRoute("POST", "/containers/abc123/compose-selection"), null);
});

test("the observable path stands next to the synchronous one, not in its place", () => {
  // #86: `logs` and `logs-stream` stand side by side, and it is the same here.
  // If the synchronous row disappeared, the caller would lose the 24 error
  // keys of this route as an HTTP response.
  const stream = findRoute("POST", "/containers/abc123/compose-raw-stream");
  assert.equal(stream?.pattern, "/containers/:id/compose-raw-stream");
  assert.equal(stream?.tier, "intern-only");
  // It does the same as the apply — a row claiming "not mutating" here would
  // simply be wrong as information.
  assert.equal(stream?.mutating, true);
  assert.equal(stream?.gate, "compose-raw");
  assert.equal(stream?.audit, "compose-raw");
  // No GET: the same body as the apply, with draft and confirmations.
  assert.equal(findRoute("GET", "/containers/abc123/compose-raw-stream"), null);
  // And the synchronous path stays.
  assert.equal(findRoute("POST", "/containers/abc123/compose-raw")?.mutating, true);
});

// --- The decision ----------------------------------------------------------

test("an intern-only route rejects the external path", () => {
  assert.deepEqual(checkTier("PUT", "/registry", "external", "wer"), {
    ok: false,
    status: 403,
    reason: "internal-only-action",
    audit: "registry-sync"
  });
  assert.deepEqual(checkTier("PUT", "/registry", null, "wer"), {
    ok: false,
    status: 400,
    reason: "tier-missing",
    audit: "registry-sync"
  });
  assert.deepEqual(checkTier("PUT", "/registry", "internal", "wer"), { ok: true });
});

test("an unknown route counts as intern-only (default deny)", () => {
  // This is the property that would have prevented S1: whoever adds a route
  // and forgets the row in the table gets the STRICTEST tier.
  const decision = checkTier("POST", "/neue-route-von-morgen", "external", "wer");
  assert.deepEqual(decision, {
    ok: false,
    status: 403,
    reason: "internal-only-action",
    audit: "route-unknown"
  });
  assert.deepEqual(checkTier("POST", "/neue-route-von-morgen", "internal", "wer"), { ok: true });
});

test("externally allowed routes still need a usable tier", () => {
  // Without a tier gate() can apply neither the delegation lock nor hardening.
  assert.deepEqual(checkTier("GET", "/containers", null, "wer"), {
    ok: false,
    status: 400,
    reason: "tier-missing",
    audit: "list"
  });
  assert.deepEqual(checkTier("GET", "/containers", "external", "wer"), { ok: true });
});

test("/health decides without a tier", () => {
  assert.deepEqual(checkTier("GET", "/health", null, null), { ok: true });
});

test("/contract is externally readable and requires a usable tier", () => {
  assert.equal(findRoute("GET", "/contract")?.tier, "extern-ok");
  assert.equal(findRoute("POST", "/contract"), null);
  assert.deepEqual(checkTier("GET", "/contract", null, null), {
    ok: false, status: 400, reason: "tier-missing", audit: "contract"
  });
  assert.deepEqual(checkTier("GET", "/contract", "external", null), { ok: true });
});

test("the counter-check: external gets stuck on every truly internal action", () => {
  // Otherwise the boundary would have been opened instead of moved. First the
  // spot checks — the three most powerful actions —, then the whole table.
  for (const [method, pathname, audit] of [
    ["POST", "/containers/abc/recreate", "recreate"],
    ["POST", "/containers/abc/exec", "exec"],
    ["PUT", "/registry", "registry-sync"]
  ] as const) {
    assert.deepEqual(checkTier(method, pathname, "external", "wer"), {
      ok: false, status: 403, reason: "internal-only-action", audit
    }, `${method} ${pathname} lets the external path in`);
  }

  // The whole table: every intern-only row rejects the external path.
  // `selbstpruefend` stays out — there the route answers itself, and today
  // none of these rows carries `intern-only` any more.
  for (const route of ROUTES) {
    if (route.tier !== "intern-only") continue;
    for (const method of route.methods) {
      const pathname = examplePath(route.pattern);
      const decision = checkTier(method, pathname, "external", route.onlyActor ?? "wer");
      assert.equal(decision.ok, false, `${method} ${pathname} lets the external path in`);
    }
  }
});

test("monitor-events is additionally bound to its one caller", () => {
  assert.deepEqual(checkTier("GET", "/monitor-events", "internal", "system:monitor"), { ok: true });
  assert.deepEqual(checkTier("GET", "/monitor-events", "internal", "jemand-anders"), {
    ok: false,
    status: 403,
    reason: "internal-only-action",
    audit: "monitor-events"
  });
});

test("both audit archive routes are intern-only", () => {
  // One hands out the complete log of the component with root-equivalent
  // access, the other discards it on the host. Externally the first would be
  // an information channel about half the operation and the second the way to
  // get rid of traces.
  assert.deepEqual(checkTier("GET", "/audit-archive", "external", "wer"), {
    ok: false,
    status: 403,
    reason: "internal-only-action",
    audit: "audit-archive-fetched"
  });
  assert.deepEqual(checkTier("POST", "/audit-archive/discard", "external", "wer"), {
    ok: false,
    status: 403,
    reason: "internal-only-action",
    audit: "audit-archive-discarded"
  });
  assert.deepEqual(checkTier("GET", "/audit-archive", "internal", "wer"), { ok: true });
  assert.deepEqual(checkTier("POST", "/audit-archive/discard", "internal", "wer"), { ok: true });
  // The methods are not interchangeable: fetching reads, discarding writes.
  assert.equal(findRoute("POST", "/audit-archive"), null);
  assert.equal(findRoute("GET", "/audit-archive/discard"), null);
  assert.equal(findRoute("POST", "/audit-archive/discard")?.mutating, true);
  assert.equal(findRoute("GET", "/audit-archive")?.mutating, false);
});

test("containerIdFromPath reads the id from the path", () => {
  assert.equal(containerIdFromPath("/containers/abc123/hardening"), "abc123");
  assert.equal(containerIdFromPath("/containers/mein%20name/logs"), "mein name");
  assert.equal(containerIdFromPath("/containers/kaputt%zz/logs"), "kaputt%zz");
  assert.equal(containerIdFromPath("/registry"), null);
  assert.equal(containerIdFromPath("/containers"), null);
});

// --- The set that gate() checks -------------------------------------------

test("INTERNAL_ONLY_ACTIONS still contains every action from before the refactor", () => {
  // The list verbatim as it stood in index.ts until the refactor. It stands here
  // as an anchor: the refactor may extend the set but must not lose an action
  // — every lost one would be an action silently opened to the outside.
  const beforeRefactor = [
    "recreate",
    "share-candidates",
    "remove",
    "exec",
    "update",
    "compose",
    "env",
    "stack-services",
    "create",
    "apply-spec",
    "compose-raw",
    "pull-stream",
    "compose-raw-read",
    "resolve",
    "stack-apply",
    "stack-down"
  ];
  for (const action of beforeRefactor) {
    assert.ok(INTERNAL_ONLY_ACTIONS.has(action), `${action} is missing from INTERNAL_ONLY_ACTIONS`);
  }
});

test("no externally allowed route carries an internally bound gate action", () => {
  // Otherwise the table would contradict itself: the route would let the
  // external path in, and gate() would reject it two steps later.
  for (const route of ROUTES) {
    if (route.tier === "extern-ok" && route.gate) {
      assert.ok(
        !INTERNAL_ONLY_ACTIONS.has(route.gate),
        `${route.pattern} is allowed externally, but ${route.gate} is bound to internal`
      );
    }
  }
});

// --- Completeness against the actual handlers -------------------------------
//
// The other direction. Everything above reads the TABLE; no test there can see
// a handler for which no row exists at all. Yet that is exactly the failure
// that hurts in operation: `route-policy.ts` is default deny, a path without a
// row falls to `intern-only`. Whoever renames a handler path and leaves the
// pattern row in place silently shuts the network tier — external 403, audit
// `route-unknown`, and nothing turns red.

const METHODS = ["GET", "PUT", "POST", "DELETE"] as const;
const knows = (pathname: string): boolean => METHODS.some((method) => findRoute(method, pathname) !== null);

const sourceText = (): string => handlerSource();

// Exceptions — by name and with a reason, not as a silent filter.
//
// Today none of these rows carries any weight: the extractor reads only
// `url.pathname`, so the known non-routes are out by construction. That they
// STAY out is checked here instead of claimed — an extractor that is later
// widened (say, over all "/…" literals) would otherwise silently trip over
// them.
const NO_ROUTES: readonly (readonly [string, string])[] = [
  ["/var/run/docker.sock", "socket path to the daemon (runtime/state.ts, isUsableSelfPath), not an HTTP path"],
  ["/run/docker.sock", "the same socket, second location on the same line"],
  ["/state/selbstupdate", "mount point of the state directory (config.ts, selfUpdateDir), not in the handler sources"]
];

test("every handler path in the handler sources has a row in ROUTES", () => {
  const paths = handlerPaths(sourceText());

  // An extractor that finds nothing (any more) would be green and worthless. The
  // mark deliberately sits below today's count: it is meant to catch the IDLE
  // case, not to turn every added route into a test change.
  assert.ok(paths.length >= 40, `only ${paths.length} handler paths read from the handler sources`);

  const withoutLine = paths
    .filter(({ pathname }) => !knows(pathname))
    .map(({ pathname, row: line, origin }) => `${pathname} (${handlerLocation(line)}, ${origin})`);
  assert.deepEqual(withoutLine, [], "handlers without a pattern row — they would silently run as intern-only");

  for (const [pathname, reason] of NO_ROUTES) {
    assert.ok(!paths.some((entry) => entry.pathname === pathname), `${pathname} is not a route: ${reason}`);
  }
});

test("the handler sources dispatch routes only in the forms the guard reads", () => {
  // The guard above is only as good as its reading. If a fourth dispatch form
  // were added (a `switch`, a comparison against a variable, a second URL
  // object), it would not see the routes behind it — and would stay silently
  // green. That is the same failure one level up, which is why the form itself
  // is under observation.
  const source = sourceText();

  const unknown = dispatchForms(source)
    .filter(({ form }) => !['=== "…"', ".match(…)", '.startsWith("…")', "passed-on"].includes(form))
    .map(({ form, row: line }) => `${handlerLocation(line)} ${form}`);
  assert.deepEqual(unknown, [], "unknown dispatch form on url.pathname");

  // No other URL object may be dispatched on; one would be a second router.
  assert.deepEqual([...new Set(foreignPathnameObjects(source).map(({ object }) => object))], []);

  // A prefix guard that no longer matches any found path has turned the regex
  // handlers behind it into dead code without any pattern row having become
  // wrong.
  const paths = handlerPaths(source);
  for (const { prefix, row: line } of prefixGuards(source)) {
    assert.ok(
      paths.some(({ pathname }) => pathname.startsWith(prefix)),
      `prefix ${prefix} (${handlerLocation(line)}) no longer covers any handler path`
    );
  }
});

test("a body key `body.action` is not a dispatcher action", () => {
  // The dot itself is a word boundary. With `\b` the guard read an action
  // "string" out of `body.action === "string"` and demanded a pattern row for
  // it — a demand for a route that never existed.
  const source = [
    'const containerMatch = url.pathname.match(/^\\\\/containers\\\\/([^/]+)(?:\\\\/([^/]+))?$/);',
    'if (request.method === "POST" && action === "files") {',
    'const aktion = typeof body.action === "string" ? body.action : "";',
    'const SAFE_ACTIONS = new Set(["start", "stop", "restart"]);'
  ].join("\\n");
  assert.deepEqual(containerActions(source), ["files", "restart", "start", "stop"]);
});

test("normalisation unfolds a regex handler into its paths", () => {
  // Without this proof the unfolding could silently deliver too little —
  // and the guard above it would be green because it would have nothing left to check.
  assert.deepEqual(
    examplePathsFromRegex(String.raw`/^\/exec\/([^/]+)\/(input|size|close)$/`).sort(),
    ["/exec/x/close", "/exec/x/input", "/exec/x/size"]
  );
  // Optional group: the handler serves the anchor AND its sub-paths.
  assert.deepEqual(
    examplePathsFromRegex(String.raw`/^\/stacks\/([^/]+)(?:\/(context|raw))?$/`).sort(),
    ["/stacks/x", "/stacks/x/context", "/stacks/x/raw"]
  );
  // The container dispatcher's actions are not in the regex but below it —
  // with the three safe ones from SAFE_ACTIONS.
  const actions = containerActions(sourceText());
  for (const safe of ["start", "stop", "restart"]) {
    assert.ok(actions.includes(safe), `${safe} is missing from the container actions`);
  }
});

test("every variant of a definition action is locked on externally managed containers (#78)", () => {
  // `pull-stream` replaced the image just like `pull`, but was missing from
  // DEFINITION_ACTIONS: `/pull` answered 403 externally-managed, the stream
  // variant went through. The rule therefore reads the table: a container
  // route whose last segment is a definition action plus a suffix (`-stream`,
  // `-preview`) carries a locked gate action as well.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-")), "registry.json");
  new AgentRegistry(file).replaceAll([
    { containerId: "abc123", containerName: "app", imageRef: "app@sha256:feed", allowed: true, secured: false, externallyManaged: true }
  ]);
  const registry = new AgentRegistry(file);

  const variants = ROUTES.filter((route) => {
    const segment = route.pattern.match(/^\/containers\/:id\/([^/]+)$/)?.[1];
    return segment !== undefined && DEFINITION_ACTIONS.has(segment.replace(/-(stream|preview)$/, ""));
  });
  assert.ok(variants.some((route) => route.pattern.endsWith("/pull-stream")), "the pull-stream route is no longer found");
  for (const route of variants) {
    assert.ok(route.gate && DEFINITION_ACTIONS.has(route.gate), `${route.pattern} is not locked for externally managed containers`);
    // The same question gate() asks before it touches the engine.
    assert.equal(
      registry.checkAccess("abc123", route.mutating, DEFINITION_ACTIONS.has(route.gate)),
      "externally-managed",
      route.pattern
    );
  }
});
