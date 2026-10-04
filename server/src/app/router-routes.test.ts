import test from "node:test";
import assert from "node:assert/strict";

import type { Auth } from "../platform/auth/auth.js";
import type { Enrollment } from "../features/hosts/index.js";
import type { HostRepository } from "../domain/hosts/index.js";
import { GET_ROUTES_WITH_EFFECT } from "../platform/http/request-origin.js";
import { createApiRouter } from "./router.js";

// The routes the real `createApiRouter` registers, read from the Express stack
// and not from the source text (#249). The list below was taken from the
// router as it stood before the feature list (`8d85e59`); the feature list
// in `server/src/app/features.ts` has to produce the same routes in the same
// order, apart from the moves named in the list. Express runs layers in the order they were registered, so the order
// is part of the behaviour and is compared as well, not only the set.
//
// A route that is added, removed or renamed lands here first. That is on
// purpose: a new GET path is exactly the case `GET_ROUTES_WITH_EFFECT`
// (`request-origin.ts`) cannot notice by itself (#125). Whoever adds a line
// below decides at the same place whether the route changes state.

const EXPECTED_LAYERS = [
  "use requireTrustedOrigin",
  "GET /setup",
  "GET /session",
  "PUT /session/language",
  "GET /users",
  "GET /hosts",
  "GET /hosts/:hostId/containers",
  "POST /hosts",
  "GET /hosts/:hostId/archive",
  "DELETE /hosts/:hostId",
  "POST /hosts/:hostId/agent-update",
  "GET /hosts/:hostId/agent-update",
  "GET /hosts/:hostId/containers/:containerId/stats",
  "GET /hosts/:hostId/containers/:containerId/logs-stream",
  // Moved up from between `PUT /settings/network` and `PUT /settings/containers`
  // with the feature `logs` (#254). No other registered pattern can match
  // `PUT /settings/logs`, so the order changes no answer; the case below holds
  // (`MOVED_BY_FEATURES`).
  "PUT /settings/logs",
  "GET /hosts/:hostId/containers/:containerId/share-candidates",
  "GET /hosts/:hostId/containers/:containerId/share",
  "PUT /hosts/:hostId/containers/:containerId/share",
  "DELETE /hosts/:hostId/containers/:containerId/share",
  "GET /hosts/:hostId/containers/:containerId/files",
  "GET /hosts/:hostId/containers/:containerId/file",
  "GET /hosts/:hostId/containers/:containerId/file-text",
  "PUT /hosts/:hostId/containers/:containerId/file",
  "PUT /hosts/:hostId/containers/:containerId/file-text",
  "POST /hosts/:hostId/containers/:containerId/files",
  "GET /hosts/:hostId/containers/:containerId/compose",
  // The selection by hand (#185), registered next to the read it complements.
  "GET /hosts/:hostId/containers/:containerId/compose/candidates",
  "PUT /hosts/:hostId/containers/:containerId/compose/selection",
  "DELETE /hosts/:hostId/containers/:containerId/compose/selection",
  "GET /hosts/:hostId/containers/:containerId/compose/env",
  "POST /hosts/:hostId/containers/:containerId/compose/preview",
  "POST /hosts/:hostId/containers/:containerId/compose",
  "POST /hosts/:hostId/projects/preview",
  "POST /hosts/:hostId/projects",
  "POST /hosts/:hostId/containers/:containerId/exec",
  "POST /hosts/:hostId/containers/:containerId/exec/:session/input",
  "POST /hosts/:hostId/containers/:containerId/exec/:session/size",
  "POST /hosts/:hostId/containers/:containerId/exec/:session/close",
  "GET /overview",
  // Moved up from behind `PUT /settings/network` with the feature `containers`
  // (#282). No other registered pattern can match `PUT /settings/containers`,
  // so the order changes no answer; the case below holds (`MOVED_BY_FEATURES`).
  "PUT /settings/containers",
  "GET /settings",
  "PUT /settings/network",
  "PUT /settings/theme",
  "PUT /hosts/:hostId/display",
  // Moved down behind the two routes above with the features `appearance` and
  // `marks` (#268); `MOVED_BY_FEATURES` holds that no other route can match it.
  "GET /marks",
  "POST /marks",
  "PUT /marks/:markId",
  "DELETE /marks/:markId",
  "PUT /hosts/:hostId/stacks/:project/marks",
  "PUT /hosts/:hostId/stacks/:project/display",
  "PUT /hosts/:hostId/stacks/:project/hidden",
  "PUT /hosts/:hostId/containers/:name/marks",
  "GET /hosts/:hostId/resources",
  // The JSON 404 for everything under `/api` that matched nothing.
  "use <anonymous>"
];

// What Express 5 keeps per layer. `stack` is not part of the typed surface of
// `Router`, but it is the one place that holds what was really registered.
type Layer = { name: string; route?: { path: string; methods: Record<string, boolean> } };

function registeredLayers(): string[] {
  // Registering touches none of these; every handler reads them per request.
  const router = createApiRouter({
    auth: {} as unknown as Auth,
    pool: {} as never,
    repository: {} as unknown as HostRepository,
    enrollment: {} as unknown as Enrollment,
    agentSecret: "unused",
    config: { wireguardEndpoint: "hub.test", wireguardPort: 51821 }
  }) as unknown as { stack: Layer[] };

  return router.stack.map((layer) => {
    if (layer.route === undefined) return `use ${layer.name}`;
    const methods = Object.keys(layer.route.methods)
      .filter((method) => layer.route?.methods[method] === true)
      .map((method) => method.toUpperCase());
    return `${methods.join(",")} ${layer.route.path}`;
  });
}

test("der Router meldet dieselben Routen in derselben Reihenfolge an wie vor der Feature-Liste", () => {
  assert.deepEqual(registeredLayers(), EXPECTED_LAYERS);
});

// The routes a feature moved against the order of `8d85e59` (see the head of
// `server/src/app/features.ts`). Each one may move only because no other route of
// the same method can match the same request.
const MOVED_BY_FEATURES = ["PUT /settings/logs", "PUT /settings/containers", "GET /marks"];

// Whether two registered routes could both match one request: same method,
// same number of segments, and in every position either a parameter or the
// same literal. Patterns with wildcards or optional parts do not occur in this
// router; a case below fails if one appears.
function canMatchSameRequest(left: string, right: string): boolean {
  const [leftMethod, leftPath] = left.split(" ");
  const [rightMethod, rightPath] = right.split(" ");
  if (leftMethod !== rightMethod) return false;
  const leftSegments = leftPath.split("/");
  const rightSegments = rightPath.split("/");
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every(
    (segment, index) => segment.startsWith(":") || rightSegments[index].startsWith(":") || segment === rightSegments[index]
  );
}

test("eine von einem Feature verschobene Route trifft mit keiner anderen dieselbe Anfrage", () => {
  const routes = registeredLayers().filter((layer) => !layer.startsWith("use "));
  for (const route of routes) {
    assert.ok(!/[*?(]/.test(route), `${route}: ein Muster mit Platzhalter oder Klammer — canMatchSameRequest kennt das nicht`);
  }
  for (const moved of MOVED_BY_FEATURES) {
    assert.ok(routes.includes(moved), `${moved} ist nicht angemeldet — MOVED_BY_FEATURES ist veraltet`);
    const overlapping = routes.filter((route) => route !== moved && canMatchSameRequest(moved, route));
    assert.deepEqual(overlapping, [], `${moved} trifft dieselbe Anfrage wie andere Routen; ihre Reihenfolge entscheidet dann`);
  }
  // The counter-check: the reader does see an overlap where there is one.
  assert.ok(canMatchSameRequest("PUT /marks/:markId", "PUT /marks/abc"));
  assert.ok(!canMatchSameRequest("PUT /marks/:markId", "DELETE /marks/:markId"));
});

test("jeder Eintrag in GET_ROUTES_WITH_EFFECT trifft eine angemeldete GET-Route", () => {
  // A path that moves during the rebuild and keeps its old spelling in the
  // list leaves the new route without the origin check, and nothing else
  // turns red: `hasEffect` simply never matches.
  const getPaths = new Set(
    registeredLayers()
      .filter((layer) => layer.startsWith("GET "))
      .map((layer) => layer.slice("GET ".length))
  );
  const stale = GET_ROUTES_WITH_EFFECT.filter((path) => !getPaths.has(path));
  assert.ok(stale.length === 0, `Ohne angemeldete GET-Route: ${stale.join(", ")}`);
  assert.ok(GET_ROUTES_WITH_EFFECT.length > 0, "GET_ROUTES_WITH_EFFECT ist leer — dieser Fall prüft dann nichts.");
});
