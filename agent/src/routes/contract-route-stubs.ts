import { type StopIntentTarget } from "contract";
import { registry } from "../runtime/state.js";

// Resolve stable preview targets from the current registry, including observers.
export function containerIdsForTarget(target: StopIntentTarget): string[] {
  return registry.knownIds().filter((id) => {
    const entry = registry.get(id)!;
    return target.kind === "container" ? entry.containerName === target.containerName
      : entry.compose?.projectName === target.projectName && entry.compose.serviceName === target.serviceName;
  });
}
