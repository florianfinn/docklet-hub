// The door of the feature `files` (#262; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature is what the route tests under `api/` need: they run
// the whole router (`app/file-routes-test-support.ts`) and count against the
// limits of the other side.

export { registerFileRoutes, type FileRouteOptions } from "./routes.js";
export { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES } from "./agent-client.js";
