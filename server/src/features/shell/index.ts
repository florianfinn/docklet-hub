// The door of the feature `shell` (#260; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature is what the route tests under `api/` need: they run
// the whole router (`app/exec-test-support.ts`), inject the beat of the
// permission check and count against the limits the feature decides.

export { registerShellRoutes, type ShellRouteOptions } from "./routes.js";
export { type Scheduler } from "./permission-watch.js";
export { EXEC_MAX_SESSIONS_PER_USER, EXEC_PERMISSION_CHECK_MS } from "./session-register.js";
