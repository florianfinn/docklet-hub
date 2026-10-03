// The door of the feature `marks` (#268; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// What leaves the feature: the routes for `features.ts`, and what the overview
// reads of it. The overview (`features/containers/`) asks for the marks and the
// stack display of an arm (`readHostDecoration`) and holds them in a type of
// its own, the same shape; `server/src/app/features.ts` hands the reader in. A
// route test that needs the empty value takes `EMPTY_DECORATION` from here.

export { registerMarkRoutes } from "./routes.js";
export { readHostDecoration } from "./assignment-store.js";
export { EMPTY_DECORATION, type HostDecoration } from "./types.js";
