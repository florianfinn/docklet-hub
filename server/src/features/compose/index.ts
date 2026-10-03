// The door of the feature `compose` (#264; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature is what `features.ts` needs to register it. The
// route tests under `api/` run the whole router and need nothing else.

export { registerComposeRoutes, type ComposeRouteOptions } from "./routes.js";
