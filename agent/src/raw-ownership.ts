// The raw editor and the `.env` write change the definition of every service
// in the stack, and a stack `up` may recreate every container. If the anchor
// or any container of the stack is externally managed, its manager owns that
// definition (#56, #121, #122), so these stay locked. Reading stays allowed.
export function externallyManagedServices(
  anchorContainerId: string | null,
  containers: ReadonlyMap<string, string>,
  isExternallyManaged: (containerId: string) => boolean
): string[] | null {
  const services = [...containers.entries()]
    .filter(([, containerId]) => isExternallyManaged(containerId))
    .map(([serviceName]) => serviceName)
    .sort();
  const anchorManaged = anchorContainerId !== null && isExternallyManaged(anchorContainerId);
  return services.length > 0 || anchorManaged ? services : null;
}

// A missing service has no container; its last registry entry stands in,
// because `up` would recreate exactly that container.
export function createScopeContainerIds(
  services: ReadonlyArray<{ serviceName: string; containerId: string | null }>,
  registryContainerIdOf: (serviceName: string) => string | undefined
): Map<string, string> {
  const containers = new Map<string, string>();
  for (const { serviceName, containerId } of services) {
    const id = containerId ?? registryContainerIdOf(serviceName);
    if (id) containers.set(serviceName, id);
  }
  return containers;
}
