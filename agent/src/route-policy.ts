// The agent's network tier policy as a TABLE instead of a property one has to
// piece together from 6,400 lines.
//
// ⚠️ The reason is a finding, not taste. Until now, whether a route is
// intern-only was stated in THREE places: in `INTERNAL_ONLY_ACTIONS`, in an `if`
// in `gate()` and in a handwritten `if` per special route — sixteen of them.
// Two routes had simply not received the third place; that was finding S1 of
// the security review (`PUT /registry` and `PUT /monitors` could be written
// from the external path). A list that has to be maintained in three places is
// one that drifts apart.
//
// Here it stands once. "Which route requires which tier?" is thus a row that
// can be read and counted through in a test.
//
// Pure and without imports, so the policy can be checked without Docker,
// without a socket and without a running server.

export type Method = "GET" | "PUT" | "POST" | "DELETE";

export type RouteTier =
  // Only via the internal path. The agent enforces this ITSELF, regardless of
  // what the main API checked before (stage plan 3.3, class "never") — it is
  // the last authority.
  | "intern-only"
  // Also reachable externally. That does NOT mean "open": on top of it still
  // sit the secret, allowlist, delegation lock, self-management lock, kill
  // switch and — for the file routes — a configured share.
  | "extern-ok"
  // Before the secret check, without a tier. Exactly one route: /health.
  | "public";

export type Route = {
  methods: readonly Method[];
  // Path pattern in segments. `:name` is a placeholder for exactly one
  // segment, `*` stands for "this segment and everything below it".
  pattern: string;
  tier: RouteTier;
  // Whether THIS method on this path changes the state of the host. Reading and
  // writing therefore stand as separate rows, even where they share a path
  // (`GET`/`PUT` on `/containers/:id/env`): a row claiming "mutating" for both
  // would be worthless as information. It stands here as information of the
  // table, not as a second enforcement: a mutating action is still stopped in
  // gate() (kill switch, delegation lock, self-management lock) — the place
  // where the container is known.
  mutating: boolean;
  // The name under which a rejection appears in the audit log.
  //
  // The name belongs in the table because otherwise the rejection loses its
  // trace: the rollout document for v0.8.0 explicitly names
  // `registry-sync`/`monitor-sync` with `outcome: denied` as the place where a
  // missing tier header shows up. A central point that logs "rejected" instead
  // would be a step back.
  audit: string;
  // Additionally bound to exactly one caller.
  onlyActor?: string;
  // The name under which gate() sees the same route. INTERNAL_ONLY_ACTIONS is
  // built from these names — the second, container-level check remains, but it
  // now reads from the same table instead of from a list of its own.
  gate?: string;
};

export const ROUTES: readonly Route[] = [
  // --- Before the secret check ------------------------------------------
  { methods: ["GET"], pattern: "/health", tier: "public", mutating: false, audit: "health" },

  // The response contains the whole route surface. It stays behind the
  // secret; extern-ok lets the dashboard query it over every network path.
  { methods: ["GET"], pattern: "/contract", tier: "extern-ok", mutating: false, audit: "contract" },

  // --- Information and control on the individual container --------------
  { methods: ["GET"], pattern: "/containers", tier: "extern-ok", mutating: false, audit: "list" },
  { methods: ["GET"], pattern: "/containers/:id", tier: "extern-ok", mutating: false, audit: "view", gate: "view" },
  { methods: ["GET"], pattern: "/containers/:id/update-check", tier: "extern-ok", mutating: false, audit: "update-check", gate: "update-check" },
  { methods: ["GET"], pattern: "/containers/:id/logs", tier: "extern-ok", mutating: false, audit: "logs", gate: "logs" },
  { methods: ["GET"], pattern: "/containers/:id/logs-stream", tier: "extern-ok", mutating: false, audit: "logs-stream", gate: "logs" },
  { methods: ["GET"], pattern: "/containers/:id/log-file", tier: "extern-ok", mutating: false, audit: "log-file", gate: "logs" },
  { methods: ["GET"], pattern: "/containers/:id/configuration", tier: "extern-ok", mutating: false, audit: "configuration", gate: "configuration" },
  { methods: ["POST"], pattern: "/containers/:id/pull", tier: "extern-ok", mutating: true, audit: "pull", gate: "pull" },
  // start/stop/restart: the three "safe" actions. Externally they are stopped
  // by the delegation lock, not by the tier (S9/5d).
  { methods: ["POST"], pattern: "/containers/:id/start", tier: "extern-ok", mutating: true, audit: "start", gate: "start" },
  { methods: ["POST"], pattern: "/containers/:id/stop", tier: "extern-ok", mutating: true, audit: "stop", gate: "stop" },
  { methods: ["POST"], pattern: "/containers/:id/restart", tier: "extern-ok", mutating: true, audit: "restart", gate: "restart" },

  // --- Web-FTP -----------------------------------------------------------
  //
  // Explicitly NOT intern-only: with decision E4 write access is
  // `grant-required` in the main API. Without a configured share there is no
  // target here at all, and the mutating routes run through gate().
  { methods: ["GET"], pattern: "/containers/:id/files", tier: "extern-ok", mutating: false, audit: "webftp" },
  { methods: ["POST"], pattern: "/containers/:id/files", tier: "extern-ok", mutating: true, audit: "webftp" },
  { methods: ["GET"], pattern: "/containers/:id/file", tier: "extern-ok", mutating: false, audit: "webftp-file" },
  { methods: ["PUT"], pattern: "/containers/:id/file", tier: "extern-ok", mutating: true, audit: "webftp-file" },
  { methods: ["GET"], pattern: "/containers/:id/file-text", tier: "extern-ok", mutating: false, audit: "webftp-file-text" },
  { methods: ["PUT"], pattern: "/containers/:id/file-text", tier: "extern-ok", mutating: true, audit: "webftp-file-text" },

  // --- Intern-only on the container --------------------------------------
  //
  // Common denominator: the response reveals the STRUCTURE of the host (mounts,
  // project directories, env values in plain text, layer IDs) or it creates,
  // replaces and removes containers.
  { methods: ["GET"], pattern: "/containers/:id/hardening", tier: "intern-only", mutating: false, audit: "hardening", gate: "hardening" },
  { methods: ["GET"], pattern: "/containers/:id/share-candidates", tier: "intern-only", mutating: false, audit: "share-candidates", gate: "share-candidates" },
  { methods: ["GET"], pattern: "/containers/:id/compose", tier: "intern-only", mutating: false, audit: "compose-read", gate: "compose" },
  { methods: ["GET"], pattern: "/containers/:id/stack-services", tier: "intern-only", mutating: false, audit: "stack-services", gate: "stack-services" },
  { methods: ["GET"], pattern: "/containers/:id/env", tier: "intern-only", mutating: false, audit: "env", gate: "env" },
  { methods: ["PUT"], pattern: "/containers/:id/env", tier: "intern-only", mutating: true, audit: "env", gate: "env" },
  { methods: ["GET"], pattern: "/containers/:id/compose-raw", tier: "intern-only", mutating: false, audit: "compose-raw", gate: "compose-raw-read" },
  { methods: ["POST"], pattern: "/containers/:id/compose-raw", tier: "intern-only", mutating: true, audit: "compose-raw", gate: "compose-raw" },
  { methods: ["GET"], pattern: "/containers/:id/compose-candidates", tier: "intern-only", mutating: false, audit: "compose-candidates", gate: "compose-raw-read" },
  { methods: ["PUT"], pattern: "/containers/:id/compose-selection", tier: "intern-only", mutating: true, audit: "compose-selection", gate: "compose-raw" },
  { methods: ["DELETE"], pattern: "/containers/:id/compose-selection", tier: "intern-only", mutating: true, audit: "compose-selection", gate: "compose-raw" },
  // The same operation, observable (#86). Same tier, same gate action,
  // `mutating: true` — it does character for character the same as the row
  // above and reports along the way where it currently stands.
  //
  // ⚠️ NEXT TO it and not in its place, just as `logs` and `logs-stream`
  // stand side by side. The error keys of this route are contract (since #89
  // the set lives in contract/src/agent/compose-reasons.ts, 24 of them on the anchor);
  // that contract only survives as long as the synchronous response remains
  // available — the stream passes it through unchanged in its final line.
  { methods: ["POST"], pattern: "/containers/:id/compose-raw-stream", tier: "intern-only", mutating: true, audit: "compose-raw", gate: "compose-raw" },
  // The dry run (#85). `mutating: false` is not carelessness: it runs the
  // phase 1 check chain and leaves nothing behind — the draft that
  // `docker compose config` has to read for it is removed again in every case.
  // No container, no image and no Compose file changes.
  // POST, although it only gives information: the draft is up to 256 KiB large
  // and belongs in a body, not in a URL.
  //
  // ⚠️ The gate action is the one for WRITING, not the one for the read response.
  // The dry run answers exactly the questions the apply would otherwise answer
  // with a `409` — including which images are missing on the host. That is
  // information about the host's image inventory that is not in the read
  // response. Whoever gets it belongs to the editor, not to reading.
  { methods: ["POST"], pattern: "/containers/:id/compose-raw-preview", tier: "intern-only", mutating: false, audit: "compose-raw-preview", gate: "compose-raw" },
  { methods: ["GET"], pattern: "/containers/:id/recreate-preview", tier: "intern-only", mutating: false, audit: "recreate-preview", gate: "recreate" },
  { methods: ["POST"], pattern: "/containers/:id/recreate", tier: "intern-only", mutating: true, audit: "recreate", gate: "recreate" },
  { methods: ["POST"], pattern: "/containers/:id/remove", tier: "intern-only", mutating: true, audit: "remove", gate: "remove" },
  { methods: ["POST"], pattern: "/containers/:id/apply-spec", tier: "intern-only", mutating: true, audit: "apply-spec", gate: "apply-spec" },
  { methods: ["POST"], pattern: "/containers/:id/resolve", tier: "intern-only", mutating: false, audit: "resolve", gate: "resolve" },
  { methods: ["POST"], pattern: "/containers/:id/exec", tier: "intern-only", mutating: true, audit: "exec", gate: "exec" },
  // The observable pull reveals registry, layer IDs and sizes; the silent
  // `pull` tells none of that and therefore stays externally allowed.
  { methods: ["POST"], pattern: "/containers/:id/pull-stream", tier: "intern-only", mutating: true, audit: "pull-stream", gate: "pull-stream" },
  { methods: ["POST"], pattern: "/containers", tier: "intern-only", mutating: true, audit: "create", gate: "create" },

  // --- Running shell sessions --------------------------------------------
  { methods: ["POST"], pattern: "/exec/:session/input", tier: "intern-only", mutating: true, audit: "exec-input" },
  { methods: ["POST"], pattern: "/exec/:session/size", tier: "intern-only", mutating: true, audit: "exec-resize" },
  { methods: ["POST"], pattern: "/exec/:session/close", tier: "intern-only", mutating: true, audit: "exec-close" },

  // --- Stacks -------------------------------------------------------------
  //
  // The two anchor routes are reachable externally, their INDIVIDUAL actions
  // are not: `apply` and `down` run as `stack-apply`/`stack-down` through
  // gate() and are intern-only there. That is why `extern-ok` stands here and
  // not some third tier — the action decides, not the path.
  { methods: ["GET"], pattern: "/stacks/:anker/context", tier: "extern-ok", mutating: false, audit: "stack-context" },
  { methods: ["POST"], pattern: "/stacks/:anker/actions/:aktion", tier: "extern-ok", mutating: true, audit: "stack-action" },
  { methods: ["GET"], pattern: "/stacks", tier: "intern-only", mutating: false, audit: "stack-discovery" },
  { methods: ["POST"], pattern: "/stacks/adopt", tier: "intern-only", mutating: true, audit: "stack-adopt" },
  { methods: ["POST"], pattern: "/stacks/raw", tier: "intern-only", mutating: true, audit: "compose-raw" },
  { methods: ["POST"], pattern: "/stacks/raw-preview", tier: "intern-only", mutating: false, audit: "compose-raw-preview" },

  // --- Lists the agent receives from the main API -------------------------
  //
  // ⚠️ Finding S1: `PUT /registry` writes the list AGAINST which the agent
  // checks everything else. It is thus more powerful than any single action it
  // authorizes — and was the only writing route without a tier check.
  { methods: ["PUT"], pattern: "/registry", tier: "intern-only", mutating: true, audit: "registry-sync" },
  { methods: ["GET"], pattern: "/monitors", tier: "extern-ok", mutating: false, audit: "monitor-list" },
  { methods: ["PUT"], pattern: "/monitors", tier: "intern-only", mutating: true, audit: "monitor-sync" },
  { methods: ["GET"], pattern: "/host-containers", tier: "intern-only", mutating: false, audit: "host-discovery" },
  { methods: ["GET"], pattern: "/host-info", tier: "intern-only", mutating: false, audit: "host-info" },
  // Images, volumes and networks of the whole host with their users (#10).
  // Intern-only for the same reason as `/host-containers`: it names containers
  // outside the allowlist. Read only.
  { methods: ["GET"], pattern: "/resources", tier: "intern-only", mutating: false, audit: "resources" },
  // The internal continuous stream. Additionally bound to the one caller that
  // runs it — a second reader would siphon off events without anyone
  // noticing, because ndjson lines are not delivered twice.
  { methods: ["GET"], pattern: "/monitor-events", tier: "intern-only", mutating: false, audit: "monitor-events", onlyActor: "system:monitor" },

  // --- Audit archive (#30) ------------------------------------------------
  //
  // The only path through which the audit log's inventory gets SMALLER. Both
  // routes are intern-only, and not out of caution: one hands out the complete
  // log of the component with root-equivalent access (every call, every
  // caller, every rejected path), the other discards it on the host. Nobody on
  // the external path has any business with either — there the first would be
  // an information channel about half the operation and the second the way to
  // get rid of traces.
  { methods: ["GET"], pattern: "/audit-archive", tier: "intern-only", mutating: false, audit: "audit-archive-fetched" },
  { methods: ["POST"], pattern: "/audit-archive/discard", tier: "intern-only", mutating: true, audit: "audit-archive-discarded" },

  // --- Self-update (#36) --------------------------------------------------
  //
  // All three intern-only, and for two different reasons. `POST` triggers the
  // replacement of the component that holds docker.sock — nobody on the
  // external path has any business with that. The two read routes reveal image
  // digests, versions and the reason for a failure; that is the same kind of
  // information about the host's setup as `/host-info`.
  //
  // No `gate`: there is no container from the allowlist here that could be
  // checked against. The agent swaps its OWN image, and the bolt for that is
  // the kill switch (`DOCKER_AGENT_READ_ONLY`), not the allowlist.
  { methods: ["POST"], pattern: "/self-update", tier: "intern-only", mutating: true, audit: "self-update" },
  { methods: ["GET"], pattern: "/self-update", tier: "intern-only", mutating: false, audit: "self-update-status" },
  { methods: ["GET"], pattern: "/self-update/available", tier: "intern-only", mutating: false, audit: "self-update-available" },
];

// Actions that gate() hard-binds to the internal path.
//
// Now comes FROM the table instead of from a second list beside it. The
// container-level check in gate() remains nonetheless: it is the second half
// of "the agent is the last authority" and also applies where an action does
// not come in through its own route.
export const INTERNAL_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  ...ROUTES.filter((route) => route.tier === "intern-only" && route.gate).map((route) => route.gate as string),
  // Actions WITHOUT their own route. They stand here for the same reason the
  // list used to contain some that did not even exist yet: the answer should
  // not depend on the order in which routing happens.
  "update",
  // Stack actions: they come in via /stacks/:anker/actions/:aktion and
  // therefore have no path pattern of their own (see there).
  "stack-apply",
  "stack-down"
]);

// Gate actions that change or replace the DEFINITION of a container. On an
// externally managed entry (`externallyManaged`) exactly these are locked: the
// manager would roll them back from its template on the next "Apply Update"
// (#78). "recreate" also covers the read-only preview — a preview of something
// that may not be executed would show a route that does not exist. "pull-stream"
// replaces the image just like "pull" and is therefore locked alongside it.
// "stack-apply" recreates and "stack-down" removes every container of a stack;
// one externally managed service locks the whole stack action (#56). The raw
// editor does not run through gate() and checks the same flag itself.
//
// Lives here and not in runtime/http.ts so that a test can reach it: the
// runtime modules load the agent configuration on import.
export const DEFINITION_ACTIONS: ReadonlySet<string> = new Set([
  "pull",
  "pull-stream",
  "recreate",
  "apply-spec",
  "remove",
  "stack-apply",
  "stack-down"
]);

function matches(pattern: string, pathname: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  for (let i = 0; i < patternParts.length; i += 1) {
    const part = patternParts[i];
    // `*` covers this segment and everything below it.
    if (part === "*") return pathParts.length > i;
    if (pathParts[i] === undefined) return false;
    if (part.startsWith(":")) {
      // A placeholder covers exactly ONE non-empty segment.
      if (pathParts[i] === "") return false;
      continue;
    }
    if (part !== pathParts[i]) return false;
  }
  return patternParts.length === pathParts.length;
}

function placeholders(pattern: string): number {
  return pattern.split("/").filter((part) => part.startsWith(":") || part === "*").length;
}

// The route for a request, or `null`.
//
// With several matches the MORE SPECIFIC pattern wins (fewer placeholders) —
// otherwise the answer for `/stacks/adopt` depends on the order in which the
// table was written, and that is exactly the property the table stands
// against.
export function findRoute(method: string, pathname: string): Route | null {
  let match: Route | null = null;
  for (const route of ROUTES) {
    if (!(route.methods as readonly string[]).includes(method)) continue;
    if (!matches(route.pattern, pathname)) continue;
    if (match === null || placeholders(route.pattern) < placeholders(match.pattern)) match = route;
  }
  return match;
}

// The container id from a path `/containers/<id>/...`.
//
// It goes into the audit entry of a rejection, because "who was rejected"
// without it is only half the information — the handwritten checks carried it
// before, and the central point should not lose that.
export function containerIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/");
  if (parts[1] !== "containers" || !parts[2]) return null;
  try {
    return decodeURIComponent(parts[2]);
  } catch {
    // Broken percent encoding: then raw it is. The value is logged, not
    // executed, and audit.ts truncates and defuses it anyway.
    return parts[2];
  }
}

export type TierDecision =
  | { ok: true }
  | { ok: false; status: 400 | 403; reason: "tier-missing" | "internal-only-action"; audit: string };

// The tier decision for a request — the one point where it is made.
//
// ⚠️ DEFAULT DENY: a route that is not in the table is treated like
// `intern-only`. Whoever adds a route and forgets the row here thus gets the
// STRICTEST tier and not the weakest. That is the property that would have
// prevented S1.
export function checkTier(
  method: string,
  pathname: string,
  tier: "internal" | "external" | null,
  actor: string | null
): TierDecision {
  const route = findRoute(method, pathname);
  if (route?.tier === "public") return { ok: true };
  const audit = route?.audit ?? "route-unknown";
  if (route === null || route.tier === "intern-only") {
    if (tier === null) return { ok: false, status: 400, reason: "tier-missing", audit };
    if (tier !== "internal") return { ok: false, status: 403, reason: "internal-only-action", audit };
    if (route?.onlyActor !== undefined && actor !== route.onlyActor) {
      return { ok: false, status: 403, reason: "internal-only-action", audit };
    }
    return { ok: true };
  }
  // Externally allowed routes still need a usable tier: without it gate()
  // can apply neither the delegation lock nor hardening.
  if (tier === null) return { ok: false, status: 400, reason: "tier-missing", audit };
  return { ok: true };
}
