import type { ResourceUser } from "contract";

// Pure helpers of the resource lists (#10), testable without a DOM.

/** `unknown` when the container list could not be read: never shown as unused. */
export type UsageState = "in-use" | "unused" | "unknown";

export function usageState(usedBy: ResourceUser[] | null): UsageState {
  if (usedBy === null) return "unknown";
  return usedBy.length > 0 ? "in-use" : "unused";
}

export function isShared(usedBy: ResourceUser[] | null): boolean {
  return new Set((usedBy ?? []).map((user) => user.name)).size > 1;
}

/** The id without the digest prefix, cut to the twelve characters Docker shows. */
export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

export function imageLabel(image: { id: string; tags: string[] }): string {
  return image.tags[0] ?? shortId(image.id);
}
