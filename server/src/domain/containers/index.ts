// The door of the domain `containers` (docs/design/feature-architecture.md,
// section 4; #281). Everything outside `domain/containers/` imports from here
// and from nowhere else in this folder; `.dependency-cruiser.mjs` holds that
// (`domain-only-through-door`).
//
// What lives here: the agent's container views as the hub reads them, the
// grouping into stacks, the registry sync and the share store. The host cycle
// in `domain/hosts/` reads shares and syncs the registry, the routes read
// containers and stacks; no single feature owns any of it.
//
// Named re-exports only, no `export *`: a new export of an inner file does not
// leave the folder by itself.

export {
  fetchContainerStats,
  fetchContainers,
  withoutHistory,
  type ContainerOverviewEntry,
  type ContainerStatsSample
} from "./containers.js";
export { fetchHostContainers } from "./host-containers.js";
export { stackOwnership } from "./stack-ownership.js";
export type { StackDiscovery } from "./stack-discovery.js";
export { fetchStackDiscovery } from "./stack-discovery.js";
export { groupIntoStacks, type HostStacks, type OverviewContainer, type StackView } from "./stacks.js";
export {
  REGISTRY_SYNC_ACTOR,
  buildRegistryEntries,
  syncRegistry,
  toRegistryRequestBody,
  type ContainerShareInput,
  type DiscoveredStack,
  type HostInventoryContainer,
  type RegistryEntryInput
} from "./registry-sync.js";
export { normalizeSharePath, readShare, readShares, removeShare, setShare } from "./shares.js";
export { isSystemImage, isSystemProject } from "./system-containers.js";
