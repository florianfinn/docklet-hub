// The door of the feature `appearance` (#268; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature: the routes for `features.ts`, and the read of the
// global theme, which `GET /settings` carries next to the network and the log
// settings. `server/src/app/features.ts` hands it to the feature `settings` (#269).

export { registerAppearanceRoutes } from "./routes.js";
export { readGlobalTheme } from "./store.js";
