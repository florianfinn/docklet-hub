// Image refs for `pull` (stage plan 3.6).
//
// `pull` is not a downtime question but a code execution question: with a
// mutable tag, "update" effectively means "run arbitrary foreign code on the
// host". The precedent in our own operation was the Tailscale :latest reset
// loop.
//
// That is why the ref is taken apart and strictly validated here instead of
// passing it through to the engine as a string. What does not parse cleanly is
// not pulled.

import type { ImageMutability } from "contract";

export type ParsedImageRef = {
  // The value that goes to the engine (?fromImage=...). For digest refs the
  // full ref, for tag refs only the NAME — the tag travels separately.
  //
  // ⚠️ Use EXCLUSIVELY for /images/create. Everywhere else (looking up an
  // image, creating a container) this is the wrong value: the engine resolves
  // "nginx" without a tag to "nginx:latest", not to the pinned
  // "nginx:1.27-alpine". That is what fullRef is for.
  fromImage: string;
  // Only set for tag refs (?tag=...).
  tag: string | null;
  // The full, unambiguous ref — "name:tag" or "name@sha256:…".
  //
  // Found live 2026-07-20: the preview reported imageWouldChange=true for a
  // container freshly created from nginx:1.27-alpine, because it looked up
  // fromImage and thereby hit nginx:LATEST. On the recreate path the same bug
  // would have created the container from the wrong image — breaking exactly
  // the promise from stage plan 3.6.
  fullRef: string;
  // sha256:... if the ref is pinned to a digest.
  digest: string | null;
  // A tag that can change under the same name. Digest refs are never mutable;
  // a tag like "latest" practically always.
  mutable: boolean;
};

// Tags that are usually moved forward. Not complete protection — every tag CAN
// be re-set — but these ones are guaranteed to be.
const MUTABLE_TAGS = new Set(["latest", "stable", "main", "master", "edge", "dev", "develop", "nightly", "rolling"]);

const NAME_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isMutableTag(tag: string | null): boolean {
  return tag === null || MUTABLE_TAGS.has(tag.toLowerCase());
}

// Whitespace, control characters and DEL. Deliberately checked via code points
// instead of a character class: a range with invisible characters in the
// source cannot be verified by reading. All of these would later end up in a
// query string of the engine API.
function hasForbiddenChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Returns null if the ref cannot be taken apart unambiguously and safely.
// Deliberately restrictive: a ref we do not fully understand is not one we
// pull.
export function parseImageRef(reference: string): ParsedImageRef | null {
  const ref = reference.trim();
  if (!ref || ref.length > 512 || hasForbiddenChar(ref)) return null;

  let remainder = ref;
  let digest: string | null = null;

  const atIndex = remainder.indexOf("@");
  if (atIndex >= 0) {
    digest = remainder.slice(atIndex + 1);
    remainder = remainder.slice(0, atIndex);
    if (!DIGEST_PATTERN.test(digest)) return null;
  }

  // A ":" after the last "/" is the tag; before it, it would be a registry port.
  let tag: string | null = null;
  const lastSlash = remainder.lastIndexOf("/");
  const colonIndex = remainder.indexOf(":", lastSlash + 1);
  if (colonIndex >= 0) {
    tag = remainder.slice(colonIndex + 1);
    remainder = remainder.slice(0, colonIndex);
    if (!TAG_PATTERN.test(tag)) return null;
  }

  if (!isValidName(remainder)) return null;

  // Digest beats tag: if both are present, the digest counts, and the full ref
  // goes to the engine.
  if (digest) {
    const full = `${remainder}@${digest}`;
    return { fromImage: full, tag: null, digest, fullRef: full, mutable: false };
  }

  return {
    fromImage: remainder,
    tag,
    digest: null,
    // Without a tag Docker means :latest — made explicit here instead of
    // relying on the engine's resolution.
    fullRef: `${remainder}:${tag ?? "latest"}`,
    mutable: isMutableTag(tag)
  };
}

// Name = [registry[:port]/]path/segments. The registry host may contain dots
// and upper-case letters, the path segments may not.
function isValidName(name: string): boolean {
  if (!name || name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  // ".." would be a path trick in the query string of the engine API.
  if (name.includes("..")) return false;

  const segments = name.split("/");
  let pathSegments = segments;

  // The first segment is a registry host if it contains a dot or port or is
  // "localhost" (Docker convention).
  const first = segments[0];
  if (segments.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    if (!isValidRegistryHost(first)) return false;
    pathSegments = segments.slice(1);
  }

  if (!pathSegments.length) return false;
  return pathSegments.every((segment) => NAME_PATTERN.test(segment));
}

function isValidRegistryHost(host: string): boolean {
  const [name, port, ...rest] = host.split(":");
  if (rest.length) return false;
  if (port !== undefined && !/^[0-9]{1,5}$/.test(port)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name);
}

// --- Mutability of a ref (R1, security review 2026-08) ---------------------
//
// `mutable` above is the INTERNAL basis for decisions. For the inventory the
// same boolean is no use as information, for a reason that already stands in
// the comment on MUTABLE_TAGS: "Not complete protection — every tag CAN be
// re-set." A boolean says "nginx:1.27 is immutable", and that is simply wrong;
// it is only unlikely to move.
//
// That is why there are three levels instead of two — the same design as the
// hardening findings (hardening.ts), and for the same reason: the middle level
// is the honest answer for the normal case, and without it you would have to
// lie it into one of the two outer ones.
//
//   "pinned"   Digest ref (pinned). The content cannot change — that is a
//               guarantee of the registry, not an assumption.
//   "tag"       A concrete tag (`1.27`, `v2.11.0`). It is USUALLY not moved
//               forward, but nobody stops the registry from doing so.
//   "floating" `latest`, `main`, `stable` … or no tag at all (movable). A pull
//               on it effectively means: "run whatever lies there now".
//
// ⚠️ This value is explicitly INFORMATION and not a gate. Making it a refusal
// would have made half the inventory unusable (several containers run on
// `:latest`) — and a lock you have to switch off again right away is no lock.
// The reader is the UI: it can show "running on a movable tag", and the
// operator decides.
export type Mutability = ImageMutability;

export function mutabilityOf(parsed: ParsedImageRef): Mutability {
  if (parsed.digest) return "pinned";
  return parsed.mutable ? "floating" : "tag";
}

// For callers that only have the raw ref (container summary).
// `null` means "cannot be parsed" and is deliberately not the same as
// "floating": a ref we do not understand should not look as if we had
// classified it.
export function mutabilityOfRef(reference: string | null | undefined): Mutability | null {
  if (!reference) return null;
  const parsed = parseImageRef(reference);
  return parsed ? mutabilityOf(parsed) : null;
}
