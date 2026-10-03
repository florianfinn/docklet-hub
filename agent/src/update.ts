// Update check (Docker monitoring D2): the local manifest digest of a running
// container, read from the RepoDigests of its image. Pure, so that the mapping
// ref -> digest stays testable without the engine. The comparison with the
// REMOTE digest (and the decision whether to report) lives in the main API
// (L2) — here only the local value is extracted cleanly.

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

// Repo part of a ref without tag/digest: "ghcr.io/u/app:1.2" -> "ghcr.io/u/app".
export function repoOfRef(ref: string): string {
  let remainder = ref.trim();
  const at = remainder.indexOf("@");
  if (at >= 0) remainder = remainder.slice(0, at);
  const lastSlash = remainder.lastIndexOf("/");
  const colon = remainder.indexOf(":", lastSlash + 1);
  if (colon >= 0) remainder = remainder.slice(0, colon);
  return remainder;
}

// Pull the manifest digest for the matching repo out of the image's
// RepoDigests. An image can be known under several repos (several
// RepoDigests); the one belonging to the ref counts. Null if no clean digest
// can be derived (e.g. a locally built image without RepoDigest) — then
// "update available?" simply cannot be determined.
//
// Found live: after a ref without a tag accidentally pulled EVERY tag of a
// repo (see pullQueryParams in engine.ts), MORE than one RepoDigest stood
// there for the same repo name — with DIFFERENT digests, because some of the
// foreign tags pointed to other versions. `.find()` would simply have taken
// the first of them, depending on the order sometimes the matching one,
// sometimes a foreign one — "update available?" would then have depended on
// chance, not on state. That is why several hits only count if they agree on
// ONE digest; otherwise the case is just as undeterminable as "no hit".
export function localManifestDigest(repoDigests: string[] | undefined, ref: string): string | null {
  const list = (repoDigests ?? []).filter((entry) => typeof entry === "string" && entry.includes("@"));
  if (list.length === 0) return null;

  const repo = repoOfRef(ref);
  const exact = list.filter((entry) => entry.slice(0, entry.indexOf("@")) === repo);
  const match = exact.length > 0 ? exact : list.filter((entry) => entry.slice(0, entry.indexOf("@")).endsWith(`/${repo}`));
  const candidates = match.length > 0 ? match : list.length === 1 ? list : [];
  if (candidates.length === 0) return null;

  // Several hits are only unambiguous if they agree on ONE digest.
  const digests = new Set(candidates.map((entry) => entry.slice(entry.indexOf("@") + 1)));
  if (digests.size !== 1) return null;

  const digest = [...digests][0];
  return DIGEST_PATTERN.test(digest) ? digest : null;
}
