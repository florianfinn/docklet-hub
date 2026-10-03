// The door of the feature `containers` (#282; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature: the routes for `features.ts`, the reader of the
// container view for `GET /settings` (`features/settings/`, handed in by
// `features.ts`), and the defaults for the route tests under `api/`. The marks
// of an arm do not come in through an import: `features.ts` hands the reader
// in as `decorationFor`.

export { registerContainersRoutes, type ContainersRouteOptions } from "./routes.js";
export { DEFAULT_CONTAINER_VIEW_SETTINGS, readContainerViewSettings } from "./view-store.js";
