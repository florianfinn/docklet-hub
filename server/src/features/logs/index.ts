// The door of the feature `logs` (#254; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// `readLogSettings` leaves the feature for `GET /settings`, which answers all
// settings of the hub in one response (`features/settings/`, handed in by
// `server/src/app/features.ts`). The
// defaults leave it for the route tests under `api/`.

export { registerLogRoutes, type LogRouteOptions } from "./routes.js";
export { DEFAULT_LOG_SETTINGS, DEFAULT_LOG_TAIL_LINES, readLogSettings } from "./store.js";
