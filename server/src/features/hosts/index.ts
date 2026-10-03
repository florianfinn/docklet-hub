// The door of the feature `hosts` (#266; docs/design/feature-architecture.md,
// sections 3 and 4). Named re-exports only, no `export *`.
//
// What leaves the feature: the routes for `features.ts`, the enrollment and
// the registration listener for `index.ts`, which starts both, and the type
// `Enrollment` the router options carry. `ARCHIVE_FILE_NAMES`,
// `generateWireGuardKeyPair` and `SIDECAR_LISTEN_PORT` are production code
// the end-to-end test of the enrollment (`app/enrollment-integration.test.ts`)
// needs as well; the agent simulator it drives lives in `platform/testing/`,
// so no test file has to pass through here.

export { registerHostRoutes, type HostRouteOptions } from "./routes.js";
export type { HostLoadOf } from "./service.js";
export {
  SIDECAR_LISTEN_PORT,
  createEnrollment,
  createRegistrationDeps,
  type Enrollment,
  type EnrollmentConfig
} from "./enrollment.js";
export { createRegistrationApp } from "./registration-app.js";
export { ARCHIVE_FILE_NAMES } from "./bootstrap/host-archive.js";
export { generateWireGuardKeyPair } from "./bootstrap/wireguard-keys.js";
