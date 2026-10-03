import type { ComposeQuestion, ProjectCreateInput, ProjectPreview } from "./api";

// The state of creating a project, as pure functions like `apply-state.ts`.
// The agent compares every list for exact set equality, so a stale tick is as
// wrong as a missing one.

export type ProjectConfirmations = {
  services: ReadonlySet<string>;
  images: ReadonlySet<string>;
  external: ReadonlySet<string>;
  hardening: ReadonlySet<string>;
};

export const NO_PROJECT_CONFIRMATIONS: ProjectConfirmations = {
  services: new Set(),
  images: new Set(),
  external: new Set(),
  hardening: new Set()
};

/** What the dry run asks to confirm. Every service of a new project is new. */
export type ProjectDemands = {
  services: readonly string[];
  /** `null` when the agent did not survey them; it asks on create then. */
  images: readonly string[] | null;
  external: readonly string[];
};

export function projectDemandsOf(preview: ProjectPreview): ProjectDemands {
  return {
    services: preview.services ?? [],
    images: preview.missingImages,
    external: preview.externalSources
  };
}

export type ProjectBlocker =
  | { reason: "name-missing" }
  | { reason: "not-previewed" }
  | { reason: "invalid" }
  | { reason: "unconfirmed-services"; missing: readonly string[] }
  | { reason: "unconfirmed-images"; missing: readonly string[] }
  | { reason: "unconfirmed-external"; missing: readonly string[] }
  | { reason: "stale-confirmation" };

/**
 * Why creating may not go yet, or `null`. `previewed` is false when name or
 * draft changed after the dry run: its lists then describe another project.
 */
export function projectBlockerOf(
  name: string,
  preview: ProjectPreview | null,
  previewed: boolean,
  confirmations: ProjectConfirmations
): ProjectBlocker | null {
  if (name.trim().length === 0) return { reason: "name-missing" };
  if (preview === null || !previewed) return { reason: "not-previewed" };
  if (!preview.valid) return { reason: "invalid" };

  const demands = projectDemandsOf(preview);
  const missingServices = demands.services.filter((entry) => !confirmations.services.has(entry));
  if (missingServices.length > 0) return { reason: "unconfirmed-services", missing: missingServices };
  if (demands.images !== null) {
    const missingImages = demands.images.filter((entry) => !confirmations.images.has(entry));
    if (missingImages.length > 0) return { reason: "unconfirmed-images", missing: missingImages };
  }
  const missingExternal = demands.external.filter((entry) => !confirmations.external.has(entry));
  if (missingExternal.length > 0) return { reason: "unconfirmed-external", missing: missingExternal };

  const stale =
    [...confirmations.services].some((entry) => !demands.services.includes(entry)) ||
    (demands.images !== null && [...confirmations.images].some((entry) => !demands.images?.includes(entry))) ||
    [...confirmations.external].some((entry) => !demands.external.includes(entry));
  return stale ? { reason: "stale-confirmation" } : null;
}

export function projectInputOf(name: string, content: string, confirmations: ProjectConfirmations): ProjectCreateInput {
  return {
    name: name.trim(),
    content,
    confirmNew: [...confirmations.services],
    acknowledgeImagePull: [...confirmations.images],
    acknowledgeHardening: [...confirmations.hardening],
    confirmExternalSources: [...confirmations.external]
  };
}

/**
 * Takes the agent's list from a follow-up question unchanged, or `null` for a
 * question no confirmation answers.
 */
export function projectAnswered(
  current: ProjectConfirmations,
  question: ComposeQuestion
): ProjectConfirmations | null {
  switch (question.kind) {
    case "services":
      return { ...current, services: new Set(question.added) };
    case "images":
      return { ...current, images: new Set(question.missing) };
    case "external-sources":
      return { ...current, external: new Set(question.sources) };
    case "hardening":
      return { ...current, hardening: new Set(question.newViolations) };
    default:
      return null;
  }
}
