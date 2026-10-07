import type { ContainerEntry } from "contract";
import type { StackDiscovery } from "./stack-discovery.js";

export function stackOwnership(projectName: string, containers: ContainerEntry[], discovery: StackDiscovery | null): boolean | null {
  if (containers.some((entry) => entry.compose?.project === projectName && entry.externalManagement !== null)) return false;
  if (discovery === null) return null;
  return discovery.stacks.some((stack) => stack.projectName === projectName && stack.filePresent && stack.management === "full");
}
