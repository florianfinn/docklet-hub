// The door of the domain `hosts` (docs/design/feature-architecture.md,
// section 4). Everything outside `domain/hosts/` imports from here and from
// nowhere else in this folder; `.dependency-cruiser.mjs` holds that
// (`domain-only-through-door`).
//
// Named re-exports only, no `export *`: a new export of an inner file does not
// leave the folder by itself.
//
// ⚠️ NOT HERE, AND ON PURPOSE: `resolveAgentSecret` and `readHostAgentSecret`.
// A route reaches an agent through `createHostAccess(…).connect(host)` and
// never holds the step that picks the secret (#77, #251). The single store
// functions behind `HostRepository` are not here either; the repository is
// the way to them.

export { createHostAccess, type HostAccess, type HostAccessDeps } from "./host-access.js";
export { createPoolRepository, type HostRepository } from "./host-repository.js";
export {
  HostError,
  deriveHostStatus,
  ensureLocalHost,
  markHostSeen,
  setHostDisplay,
  toHostView,
  type CreateHostInput,
  type HostErrorReason,
  type HostView,
  type RegistrationClaim,
  type RotateHostInput
} from "./host-store.js";
export {
  MAX_REGISTRATION_ATTEMPTS,
  MIN_REGISTRATION_TOKEN_LENGTH,
  hashRegistrationToken,
  isValidDockerGid,
  normalizeBindBasePath,
  normalizeTunnelAddress,
  type HostKind,
  type HostRecord,
  type HostState,
  type HostStatus
} from "./host-record.js";
export { ARM_AGENT_IMAGE } from "./arm-agent-image.js";
export { probeAgent, resolveProbeHost, type AgentHealth } from "./health.js";
export {
  openContainerAccess,
  type ContainerAccess,
  type ContainerAccessDeps,
  type ContainerAccessRequest,
  type ContainerAccessResult,
  type RouteWriting
} from "./container-access.js";
export type { HostInfo } from "./host-info.js";
export {
  MIN_AGENT_VERSION,
  compareAgentVersions,
  isAgentOutdated,
  parseAgentVersion,
  speaksAgentContract
} from "./version.js";
export type { HostCycleOutcome } from "./host-cycle.js";
export { startHostCycleService } from "./host-cycle-service.js";
export { createObservedProbe, staleAfterMs } from "./host-observation-store.js";
export { fetchSelfUpdateStatus, requestSelfUpdate } from "./self-update.js";
export {
  NO_HUB_NETWORK,
  normalizeExternalEndpoint,
  readHubNetwork,
  writeHubNetwork,
  type HubNetwork
} from "./hub-network-store.js";
