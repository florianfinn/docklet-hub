// The raw editor and the `.env` write change the definition of every service
// in the stack. If the anchor or any existing container of the stack is
// externally managed, its manager owns that definition and would roll the
// edit back (#56, #121), so writing stays locked. Reading stays allowed.
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
