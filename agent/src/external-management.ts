// Who manages a container's definition when it is not this hub (#5). Unraid
// sets `dockerman` (templates) or `composeman` (Compose Manager plugin). Since
// `Config.Labels` merges image and container labels, a manager also needs
// matching Compose labels and a value the image does not carry; otherwise it is
// `unknown`. Any non-null result makes the hub set `externallyManaged`, so the
// classification can only narrow rights.

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

type ImageInspector = (imageId: string) => Promise<{ Config?: { Labels?: Record<string, string> | null } } | null>;

/**
 * Returns a lookup for the manager label on a container's image: `null` when
 * the container claims nothing or the image lacks the label, `undefined` when
 * the image is unreadable. An image id names immutable content, so cached
 * answers never go stale; failures are not cached.
 */
export function createImageManagerLabelLookup(inspectImage: ImageInspector, limit = 512) {
  const cache = new Map<string, string | null>();
  return async (
    labels: Record<string, string> | null | undefined,
    imageId: string | undefined
  ): Promise<string | null | undefined> => {
    if (labels?.[UNRAID_MANAGED_LABEL] === undefined) return null;
    if (!imageId) return undefined;
    const cached = cache.get(imageId);
    if (cached !== undefined) return cached;
    try {
      const image = await inspectImage(imageId);
      if (!image) return undefined;
      const value = image.Config?.Labels?.[UNRAID_MANAGED_LABEL] ?? null;
      if (cache.size >= limit) cache.clear();
      cache.set(imageId, value);
      return value;
    } catch (error) {
      console.error(`[agent] image ${imageId} not readable:`, error);
      return undefined;
    }
  };
}
