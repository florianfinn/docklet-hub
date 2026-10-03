// Which container am I?
//
// Up to v0.13.0 there was nothing here — the answer was `process.env.HOSTNAME`,
// because Docker sets the hostname to the short container id on creation. That
// holds exactly as long as the container has its OWN network namespace.
//
// ⚠️ With `network_mode: container:<X>` it does not hold. Docker passes the
// namespace PROVIDER's `/etc/hostname` through to the container; the hostname
// is then the provider's short id. On 2026-08-26 this swapped the tunnel
// sidecar on `remote-host` instead of the agent: the self-update job carried the
// sidecar's id, the watcher dutifully replaced it, and afterwards the agent hung
// in a netns that no longer existed — still `running` according to Docker. The
// host was unreachable for an hour.
//
// ⚠️ The obvious workarounds do not help. `/proc/self/mountinfo` points to the
// same foreign path (`/containers/<geber-id>/hostname`), because exactly this
// file comes from the provider; `/proc/self/cgroup` only yields `0::/` under
// cgroup v2. Measured live: from inside, the own id cannot be read by any of the
// usual ways in this setup.
//
// That is why it is no longer READ here but PROVEN: the agent carries
// `DOCKER_AGENT_SECRET` in its own environment, and via `env_file` the same
// value sits in `Config.Env` of exactly its container. Whoever carries this
// value is the agent.

import crypto from "node:crypto";

export type IdCandidate = {
  id: string;
  // The container's `Config.Env` as the engine reports it: lines of the form
  // `NAME=wert`.
  envLines: readonly string[];
};

export type OwnIdResult = {
  id: string | null;
  reason: "verified" | "unverifiable" | "ambiguous";
};

const ENV_NAME = "DOCKER_AGENT_SECRET";

function same(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

// ⚠️ Only the first `=` separates. A secret may contain `=` (Base64 padding),
// and a `split("=")[1]` would cut it off exactly there — the check would then
// fail for the right container and the agent would consider itself unknown.
// That would be fail closed, but for the wrong reason.
export function carriesSecret(envLines: readonly string[], secret: string): boolean {
  for (const line of envLines) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    if (line.slice(0, separator) !== ENV_NAME) continue;
    if (same(line.slice(separator + 1), secret)) return true;
  }
  return false;
}

// Exactly ONE match is an answer. None means "unverifiable" (not provable),
// several mean "ambiguous" (ambiguous) — and both lead to `null`.
//
// ⚠️ `null` is not an edge case here but the actual intent. Everything that
// needs the own id (self-update, the hardening's self-protection) then refuses
// instead of guessing. That intent was already stated in the comment of the old
// line — it just could not detect the case, because a foreign hostname looks
// syntactically like an own one.
export function pickOwnContainerId(
  candidates: readonly IdCandidate[],
  secret: string
): OwnIdResult {
  if (!secret) return { id: null, reason: "unverifiable" };
  const match = candidates.filter((candidate) => carriesSecret(candidate.envLines, secret));
  if (match.length === 1) return { id: match[0].id, reason: "verified" };
  if (match.length === 0) return { id: null, reason: "unverifiable" };
  return { id: null, reason: "ambiguous" };
}
