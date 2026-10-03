import type { ContainerOverviewEntry } from "../../domain/containers/index.js";

/**
 * Does another manager own the definition of `anchor`'s stack (#56)?
 *
 * The raw editor writes the file of the whole Compose project, so one
 * externally managed container of the same project on this arm locks it.
 * The agent decides the same from its own registry copy; this is the hub's
 * check before it asks.
 */
export function isExternallyManagedStack(
  anchor: ContainerOverviewEntry,
  containers: readonly ContainerOverviewEntry[]
): boolean {
  if (anchor.externalManagement !== null) return true;
  if (anchor.compose === null) return false;
  const project = anchor.compose.project;
  return containers.some((entry) => entry.compose?.project === project && entry.externalManagement !== null);
}
