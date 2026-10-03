// The door of the feature `settings` (#269; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// Only the routes and the type of the readers leave the feature: the readers
// of the other surfaces come in through `server/src/app/features.ts`, so that
// `settings` imports no other feature.

export { registerSettingsRoutes, type SettingsRouteOptions } from "./routes.js";
export type { SettingsReaders } from "./service.js";
