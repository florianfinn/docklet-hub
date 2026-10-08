export function projectLockKey(input: {
  registryProject?: string | null; labelProject?: string | null; projectName?: string | null;
  containerId?: string | null; containerName?: string | null; projectDir?: string;
}): string {
  // The registered anchor wins over labels until revalidation accepts a move.
  return input.registryProject || input.projectName || input.labelProject ||
    ((input.containerName || input.containerId) ? `container:${input.containerName || input.containerId}` : `project-dir:${input.projectDir ?? ""}`);
}
