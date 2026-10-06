// The agent's route table: one row per method and path, readable and countable
// in a test instead of spread over the handlers.
//
// Pure and without imports, so the policy can be checked without Docker,
// without a socket and without a running server.

export type Method = "GET" | "PUT" | "POST" | "DELETE";

export type Route = {
  methods: readonly Method[];
  // Path pattern in segments. `:name` is a placeholder for exactly one
  // segment, `*` stands for "this segment and everything below it".
  pattern: string;
  // Answered before the secret check. Exactly one route: /health.
  public?: true;
  // Whether THIS method on this path changes the state of the host. Reading and
  // writing therefore stand as separate rows, even where they share a path
  // (`GET`/`PUT` on `/containers/:id/env`). Information of the table, not an
  // enforcement: a mutating action is stopped in gate() (kill switch,
  // self-management lock), where the container is known.
  mutating: boolean;
  // The name under which a rejection appears in the audit log.
  audit: string;
  // Additionally bound to exactly one caller.
  onlyActor?: string;
  // The name under which gate() sees the same route.
  gate?: string;
};

export const ROUTES: readonly Route[] = [
  // --- Before the secret check ------------------------------------------
  { methods: ["GET"], pattern: "/health", public: true, mutating: false, audit: "health" },

  // The response contains the whole route surface, so it stays behind the
  // secret.
  { methods: ["GET"], pattern: "/contract", mutating: false, audit: "contract" },

  // --- Information and control on the individual container --------------
  { methods: ["GET"], pattern: "/containers", mutating: false, audit: "list" },
  { methods: ["GET"], pattern: "/containers/:id", mutating: false, audit: "view", gate: "view" },
  { methods: ["GET"], pattern: "/containers/:id/update-check", mutating: false, audit: "update-check", gate: "update-check" },
  { methods: ["GET"], pattern: "/containers/:id/logs", mutating: false, audit: "logs", gate: "logs" },
  { methods: ["GET"], pattern: "/containers/:id/logs-stream", mutating: false, audit: "logs-stream", gate: "logs" },
  { methods: ["GET"], pattern: "/containers/:id/log-file", mutating: false, audit: "log-file", gate: "logs" },
  { methods: ["GET"], pattern: "/containers/:id/configuration", mutating: false, audit: "configuration", gate: "configuration" },
  { methods: ["POST"], pattern: "/containers/:id/pull", mutating: true, audit: "pull", gate: "pull" },
  // start/stop/restart: the three "safe" actions.
  { methods: ["POST"], pattern: "/containers/:id/start", mutating: true, audit: "start", gate: "start" },
  { methods: ["POST"], pattern: "/containers/:id/stop", mutating: true, audit: "stop", gate: "stop" },
  { methods: ["POST"], pattern: "/containers/:id/restart", mutating: true, audit: "restart", gate: "restart" },

  // --- Web-FTP -----------------------------------------------------------
  //
  // Without a configured share there is no target here at all, and the
  // mutating routes run through gate().
  { methods: ["GET"], pattern: "/containers/:id/files", mutating: false, audit: "webftp" },
  { methods: ["POST"], pattern: "/containers/:id/files", mutating: true, audit: "webftp" },
  { methods: ["GET"], pattern: "/containers/:id/file", mutating: false, audit: "webftp-file" },
  { methods: ["PUT"], pattern: "/containers/:id/file", mutating: true, audit: "webftp-file" },
  { methods: ["GET"], pattern: "/containers/:id/file-text", mutating: false, audit: "webftp-file-text" },
  { methods: ["PUT"], pattern: "/containers/:id/file-text", mutating: true, audit: "webftp-file-text" },

  // --- Host structure and definition of the container --------------------
  //
  // Common denominator: the response reveals the STRUCTURE of the host (mounts,
  // project directories, env values in plain text, layer IDs) or it creates,
  // replaces and removes containers.
  { methods: ["GET"], pattern: "/containers/:id/hardening", mutating: false, audit: "hardening", gate: "hardening" },
  { methods: ["GET"], pattern: "/containers/:id/share-candidates", mutating: false, audit: "share-candidates", gate: "share-candidates" },
  { methods: ["GET"], pattern: "/containers/:id/compose", mutating: false, audit: "compose-read", gate: "compose" },
  { methods: ["GET"], pattern: "/containers/:id/stack-services", mutating: false, audit: "stack-services", gate: "stack-services" },
  { methods: ["GET"], pattern: "/containers/:id/env", mutating: false, audit: "env", gate: "env" },
  { methods: ["PUT"], pattern: "/containers/:id/env", mutating: true, audit: "env", gate: "env" },
  { methods: ["GET"], pattern: "/containers/:id/compose-raw", mutating: false, audit: "compose-raw", gate: "compose-raw-read" },
  { methods: ["POST"], pattern: "/containers/:id/compose-raw", mutating: true, audit: "compose-raw", gate: "compose-raw" },
  { methods: ["GET"], pattern: "/containers/:id/compose-candidates", mutating: false, audit: "compose-candidates", gate: "compose-raw-read" },
  { methods: ["PUT"], pattern: "/containers/:id/compose-selection", mutating: true, audit: "compose-selection", gate: "compose-raw" },
  { methods: ["DELETE"], pattern: "/containers/:id/compose-selection", mutating: true, audit: "compose-selection", gate: "compose-raw" },
  // The same operation, observable (#86). Same gate action,
  // `mutating: true` — it does character for character the same as the row
  // above and reports along the way where it currently stands.
  //
  // ⚠️ NEXT TO it and not in its place, just as `logs` and `logs-stream`
  // stand side by side. The error keys of this route are contract (since #89
  // the set lives in contract/src/agent/compose-reasons.ts, 24 of them on the anchor);
  // that contract only survives as long as the synchronous response remains
  // available — the stream passes it through unchanged in its final line.
  { methods: ["POST"], pattern: "/containers/:id/compose-raw-stream", mutating: true, audit: "compose-raw", gate: "compose-raw" },
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
  { methods: ["POST"], pattern: "/containers/:id/compose-raw-preview", mutating: false, audit: "compose-raw-preview", gate: "compose-raw" },
  { methods: ["GET"], pattern: "/containers/:id/recreate-preview", mutating: false, audit: "recreate-preview", gate: "recreate" },
  { methods: ["POST"], pattern: "/containers/:id/recreate", mutating: true, audit: "recreate", gate: "recreate" },
  { methods: ["POST"], pattern: "/containers/:id/remove", mutating: true, audit: "remove", gate: "remove" },
  { methods: ["POST"], pattern: "/containers/:id/apply-spec", mutating: true, audit: "apply-spec", gate: "apply-spec" },
  { methods: ["POST"], pattern: "/containers/:id/resolve", mutating: false, audit: "resolve", gate: "resolve" },
  { methods: ["POST"], pattern: "/containers/:id/exec", mutating: true, audit: "exec", gate: "exec" },
  // The observable pull reveals registry, layer IDs and sizes; the silent
  // `pull` tells none of that.
  { methods: ["POST"], pattern: "/containers/:id/pull-stream", mutating: true, audit: "pull-stream", gate: "pull-stream" },
  { methods: ["POST"], pattern: "/containers", mutating: true, audit: "create", gate: "create" },

  // --- Running shell sessions --------------------------------------------
  { methods: ["POST"], pattern: "/exec/:session/input", mutating: true, audit: "exec-input" },
  { methods: ["POST"], pattern: "/exec/:session/size", mutating: true, audit: "exec-resize" },
  { methods: ["POST"], pattern: "/exec/:session/close", mutating: true, audit: "exec-close" },

  // --- Stacks -------------------------------------------------------------
  //
  // The individual actions of the anchor route (`apply`, `down`, ...) run
  // through gate() as `stack-apply`/`stack-down` etc.: the action decides,
  // not the path.
  { methods: ["GET"], pattern: "/stacks/:anker/context", mutating: false, audit: "stack-context" },
  { methods: ["POST"], pattern: "/stacks/:anker/actions/:aktion", mutating: true, audit: "stack-action" },
  { methods: ["GET"], pattern: "/stacks", mutating: false, audit: "stack-discovery" },
  { methods: ["POST"], pattern: "/stacks/adopt", mutating: true, audit: "stack-adopt" },
  { methods: ["POST"], pattern: "/stacks/raw", mutating: true, audit: "compose-raw" },
  { methods: ["POST"], pattern: "/stacks/raw-preview", mutating: false, audit: "compose-raw-preview" },

  // --- Lists the agent receives from the main API -------------------------
  //
  // ⚠️ `PUT /registry` writes the list AGAINST which the agent checks
  // everything else. It is thus more powerful than any single action it
  // authorizes.
  { methods: ["PUT"], pattern: "/registry", mutating: true, audit: "registry-sync" },
  { methods: ["GET"], pattern: "/monitors", mutating: false, audit: "monitor-list" },
  { methods: ["PUT"], pattern: "/monitors", mutating: true, audit: "monitor-sync" },
  { methods: ["GET"], pattern: "/host-containers", mutating: false, audit: "host-discovery" },
  { methods: ["GET"], pattern: "/host-info", mutating: false, audit: "host-info" },
  // Images, volumes and networks of the whole host with their users (#10).
  // Like `/host-containers` it names containers outside the allowlist. Read
  // only.
  { methods: ["GET"], pattern: "/resources", mutating: false, audit: "resources" },
  // The monitor's continuous stream. Additionally bound to the one caller that
  // runs it — a second reader would siphon off events without anyone
  // noticing, because ndjson lines are not delivered twice.
  { methods: ["GET"], pattern: "/monitor-events", mutating: false, audit: "monitor-events", onlyActor: "system:monitor" },

  // --- Audit archive (#30) ------------------------------------------------
  //
  // The only path through which the audit log's inventory gets SMALLER. One
  // route hands out the complete log of the component with root-equivalent
  // access (every call, every caller, every rejected path), the other
  // discards it on the host.
  { methods: ["GET"], pattern: "/audit-archive", mutating: false, audit: "audit-archive-fetched" },
  { methods: ["POST"], pattern: "/audit-archive/discard", mutating: true, audit: "audit-archive-discarded" },

  // --- Self-update (#36) --------------------------------------------------
  //
  // `POST` triggers the replacement of the component that holds docker.sock.
  // The two read routes reveal image digests, versions and the reason for a
  // failure, the same kind of information about the host's setup as
  // `/host-info`.
  //
  // No `gate`: there is no container from the allowlist here that could be
  // checked against. The agent swaps its OWN image, and the bolt for that is
  // the kill switch (`DOCKER_AGENT_READ_ONLY`), not the allowlist.
  { methods: ["POST"], pattern: "/self-update", mutating: true, audit: "self-update" },
  { methods: ["GET"], pattern: "/self-update", mutating: false, audit: "self-update-status" },
  { methods: ["GET"], pattern: "/self-update/available", mutating: false, audit: "self-update-available" },
];

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

export type RouteDecision =
  | { ok: true }
  | { ok: false; status: 403; reason: "actor-not-allowed"; audit: string };

// The route-level decision for a request: only `onlyActor` is enforced here.
// A route that is not in the table passes and ends in the dispatcher's 404.
export function checkRoute(method: string, pathname: string, actor: string | null): RouteDecision {
  const route = findRoute(method, pathname);
  if (route?.onlyActor !== undefined && actor !== route.onlyActor) {
    return { ok: false, status: 403, reason: "actor-not-allowed", audit: route.audit };
  }
  return { ok: true };
}
