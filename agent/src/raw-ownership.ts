// The raw editor writes the definition of every service in the stack's file.
// If the anchor or any existing container of the stack is externally managed,
// its manager owns that definition and would roll the edit back (#56), so the
// whole file stays locked. Reading it stays allowed.
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
