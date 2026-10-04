/** The address of the resource page of one host (#10). */
export function hostResourcesPath(hostId: string): string {
  return `/hosts/${encodeURIComponent(hostId)}/resources`;
}
