// The door of the feature `account` (#269; docs/design/feature-architecture.md,
// section 3). Named re-exports only, no `export *`.
//
// Only the routes leave the feature, for `features.ts`. The list of accounts
// (`users.ts`) is read by one route of this feature and by nothing outside.

export { registerAccountRoutes } from "./routes.js";
