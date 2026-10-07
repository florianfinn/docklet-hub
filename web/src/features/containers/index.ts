// The door of the feature `containers` (#282). Named re-exports only, no
// `export *` (`web/tests/import-boundaries.test.mjs`).
//
// What leaves the feature: the overview and the container list as views
// (`OverviewView`, `ContainersView`), the two panels of the settings, the list
// of containers the stack page and the container page draw with
// (`ContainerList`, `ContainerStateDot`), the manager names of the container
// note, the read of the overview they share
// and the places a row leaves to the app (`ContainerSlots`). The marks and the
// usage in a row are NOT imported here: `app/containers/container-slots.tsx`
// hands them in (docs/design/feature-architecture.md, rule 1).

export { OverviewView } from "./OverviewView";
export { ContainersView } from "./ContainersView";
export { ContainerViewPanel } from "./ContainerViewPanel";
export { SystemContainersPanel } from "./SystemContainersPanel";
export { ContainerList } from "./ContainerList";
export { ContainerStateDot } from "./container-state";
export { isUnknownManager, managerName } from "./external-management";
export { fetchOverview, runContainerAction, runStackAction, runtimeActionErrorOf } from "./api";
export { useOverview, useOverviewUpdate } from "./overview-queries";
export type { ContainerRowNotice, ContainerSlots } from "./slots";
export { deContainers } from "./messages/de";
export { enContainers } from "./messages/en";

export { LifecycleControls } from "./LifecycleControls";
export { LifecycleProvider } from "./LifecycleProvider";
