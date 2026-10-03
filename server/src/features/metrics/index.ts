// The door of the feature `metrics` (#283; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature: the routes for `features.ts`, and the load of an arm
// by its containers (`hostLoad`), which `features.ts` hands to the feature
// `hosts` as an option: `hosts` imports nothing from here.

export { hostLoad, SAMPLE_CAPACITY, SAMPLE_INTERVAL_MS, type HostLoad, type LoadPoint } from "./container-load.js";
export { registerMetricsRoutes, type MetricsRouteOptions } from "./routes.js";
