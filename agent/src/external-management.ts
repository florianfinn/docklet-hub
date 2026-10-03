// Who manages a container's definition when it is not this hub (#5).
//
// Unraid marks its containers with one label: `dockerman` for the native
// template UI, `composeman` for the Compose Manager plugin. The label alone is
// no proof, because `Config.Labels` merges image and container labels. A
// classification therefore also needs the matching Compose labels and a value
// the image itself does not carry. Anything else is `unknown`: still locked
// like a managed container, but without claiming a manager.
//
// The result only ever narrows: the hub turns any non-null value into
// `externallyManaged`, which locks pull, recreate, apply-spec, remove and the
// stack definition actions. A missing label cannot be detected and leaves the
// container with the hub.

export const UNRAID_MANAGED_LABEL = "net.unraid.docker.managed";
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

export type ExternalManager = "unraid" | "unraid-compose" | "unknown";
export type ExternalManagement = { manager: ExternalManager };

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Classifies the manager from the container's merged labels.
 *
 * `imageValue` is the same label on the container's image: `null` when the
 * image does not carry it, `undefined` when the image could not be read.
 */
export function foreignManagementOf(
  labels: Record<string, string> | null | undefined,
  imageValue: string | null | undefined
): ExternalManagement | null {
  const value = nonEmpty(labels?.[UNRAID_MANAGED_LABEL]);
  if (value === null) return null;

  // An equal value on the image means the container may never have set it.
  if (imageValue === undefined || nonEmpty(imageValue) === value) return { manager: "unknown" };

  const composeProject = nonEmpty(labels?.[COMPOSE_PROJECT_LABEL]) !== null;
  if (value === "dockerman" && !composeProject) return { manager: "unraid" };
  if (value === "composeman" && composeProject) return { manager: "unraid-compose" };
  return { manager: "unknown" };
}
