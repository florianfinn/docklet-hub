import { toInspectedContainer, type RawInspect } from "./engine.js";
import { hardeningRuleNames, type HardeningRule } from "./hardening.js";
import { mutabilityOfRef, type Mutability } from "./image-ref.js";
import { foreignManagementOf, type ExternalManagement } from "./external-management.js";
import type { ContainerStats } from "./stats.js";

// Secret visibility (stage plan 3.9).
//
// `docker inspect` returns all env variables — DB passwords, API keys, tokens.
// The masking sits here in the agent and not in the frontend: that way the
// plain text does not leave the agent at all, instead of carrying it through
// the API and the network and only hiding it at render time.
//
// Env plain text is bound to docker.control.destructive; the agent only
// returns it when it is explicitly requested AND the main API sends the
// corresponding proof along.

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
  startedAt: string | null;
  health: string | null;
  // A running container can hang in an old network namespace even though
  // status and stats look unremarkable (#47). The Docker mode and the key
  // allow comparing it with its netns provider.
  networkMode: string | null;
  sandboxKey: string | null;
  // Key visible, value masked — the key alone is useful (which configuration
  // exists at all) and rarely secret.
  envKeys: string[];
  env?: Record<string, string>;
  // Result of the continuous check (stage 4, three levels since S9),
  // deliberately without details: the rule names tell the UI that something is
  // wrong without naming host paths. The details come from
  // /containers/:id/hardening.
  hardening: {
    delegationLock: HardeningRule[];
    warning: HardeningRule[];
    hint: HardeningRule[];
  };
  // CPU/RAM (stage 6b). null means "cannot be determined" (container just
  // started/stopped, stats call failed) — not a security feature, therefore
  // without a gate of its own, via the same scope as the rest of the summary.
  stats: ContainerStats | null;
  // Compose membership, straight from the labels of the running container.
  //
  // It complements the adoption in the app DB (stage 5d) and does not replace
  // it: a container is only adopted once someone has linked its Compose file.
  // For the mere question "which containers belong together" that is far too
  // high a hurdle — which is why the answer lives here, where it holds without
  // any precondition for EVERY Compose-managed container.
  //
  // ⚠️ EXPLICITLY only these two labels travel along, not the whole label map:
  // labels are set freely by the image author and in practice carry
  // descriptions, Traefik rules and occasionally credentials. The same
  // discipline as in engine.listWithComposeLabels().
  compose: { project: string; service: string } | null;
  // Who manages the definition when it is not this hub; see
  // external-management.ts. The gate is the registry's `externallyManaged`.
  externalManagement: ExternalManagement | null;
  // Does this container run from a ref whose content can change under the
  // same name (R1, security review 2026-08)?
  //
  // ⚠️ Derived from `image` — the same ref that is in this response anyway.
  // So no new information travels along, only an evaluated one.
  //
  // Like `externalManagement` this is an EXPLANATION and not a gate:
  // `image-ref.ts` explains why it does not turn into a refusal. `null` means
  // "ref cannot be parsed" and explicitly not "immutable".
  imageMutability: Mutability | null;
};

const MASK = "••••";

// The key can be a secret too, if it already is the value itself (e.g. for
// tokens accidentally stored as a key). Such keys are additionally shortened
// instead of being shown in full.
const SUSPICIOUS_KEY = /^[A-Za-z0-9+/=_-]{40,}$/;

export function splitEnvEntry(entry: string): { key: string; value: string } {
  const index = entry.indexOf("=");
  if (index < 0) return { key: entry, value: "" };
  return { key: entry.slice(0, index), value: entry.slice(index + 1) };
}

export function envKeysOf(env: string[] | null | undefined): string[] {
  return (env ?? []).map((entry) => {
    const { key } = splitEnvEntry(entry);
    return SUSPICIOUS_KEY.test(key) ? `${key.slice(0, 8)}…` : key;
  });
}

export function envPlaintextOf(env: string[] | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of env ?? []) {
    const { key, value } = splitEnvEntry(entry);
    result[key] = value;
  }
  return result;
}

export type SummaryOptions = {
  // Only true if the main API has proven destructive rights. The default is deliberately false: whoever specifies nothing gets no
  // secrets.
  includeEnvPlaintext?: boolean;
  // Base path of the bind mount allowlist (stage 5a). Without it this one rule
  // does not run — see HardeningOptions.
  bindBasePath?: string;
  // Own universe of a secured container (stage 5e). If it is set, the
  // hardening reports a neighbour mount as bind-outside-universe.
  secureUniverse?: string;
  // This host's own operating directories (S23) — see
  // HardeningOptions.selfPaths. Must be passed through: without them the
  // container summary falls back to the LOCAL constants and, on a foreign
  // host, reports no delegation lock for a mount onto the agent directory.
  selfPaths?: readonly string[];
  // The host paths resolved from named volumes (security review stage 7).
  // They come in from outside, because fetching them needs a second engine
  // call and this module is meant to stay pure.
  //
  // ⚠️ If they are missing, the summary reports a container with a bind-like
  // volume as clean — so the caller is expected to pass them.
  volumeBinds?: readonly string[];
  // Names of named volumes whose inspect failed. They are only used for the
  // fail-closed hardening rule; the summary still exposes exclusively the rule
  // name and no volume names.
  unresolvedVolumes?: readonly string[];
  // Precomputed stats (stage 6b). They come in from outside, because fetching
  // them needs a second engine call and this module is meant to stay pure —
  // the same separation as for volumeBinds.
  stats?: ContainerStats | null;
  // Unraid's manager label on the image (imageManagerLabelOf). Missing counts
  // as unreadable and reports a claimed manager as `unknown`.
  imageManagerLabel?: string | null;
};

// Only `project` and `service`, and only if BOTH are present: a half-filled
// anchor looks like membership but can be neither grouped nor labelled.
export function composeLabelsOf(
  labels: Record<string, string> | null | undefined
): { project: string; service: string } | null {
  const project = labels?.["com.docker.compose.project"];
  const service = labels?.["com.docker.compose.service"];
  if (typeof project !== "string" || !project.trim()) return null;
  if (typeof service !== "string" || !service.trim()) return null;
  return { project: project.trim(), service: service.trim() };
}

export function toContainerSummary(raw: RawInspect, options: SummaryOptions = {}): ContainerSummary {
  const inspected = toInspectedContainer(raw);
  const withVolumes = {
    ...inspected,
    binds: [...inspected.binds, ...(options.volumeBinds ?? [])],
    unresolvedVolumes: [...(options.unresolvedVolumes ?? [])]
  };
  const summary: ContainerSummary = {
    id: raw.Id,
    name: (raw.Name ?? "").replace(/^\//, ""),
    image: raw.Config?.Image ?? raw.Image ?? "",
    status: raw.State?.Status ?? "unknown",
    running: raw.State?.Running === true,
    startedAt: raw.State?.StartedAt ?? null,
    health: raw.State?.Health?.Status ?? null,
    networkMode: raw.HostConfig?.NetworkMode ?? null,
    sandboxKey: raw.NetworkSettings?.SandboxKey || null,
    envKeys: envKeysOf(raw.Config?.Env),
    hardening: hardeningRuleNames(withVolumes, {
      bindBasePath: options.bindBasePath,
      secureUniverse: options.secureUniverse,
      selfPaths: options.selfPaths
    }),
    stats: options.stats ?? null,
    compose: composeLabelsOf(raw.Config?.Labels),
    externalManagement: foreignManagementOf(raw.Config?.Labels, options.imageManagerLabel),
    imageMutability: mutabilityOfRef(raw.Config?.Image ?? raw.Image)
  };

  if (options.includeEnvPlaintext) {
    summary.env = envPlaintextOf(raw.Config?.Env);
  }

  return summary;
}

// For error messages and log lines: remove known secret values from a text
// before it leaves the agent. Applies when a container writes a password into
// its own logs.
export function redactKnownSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    // Very short values would produce too many random hits and make the text
    // unreadable without offering real protection.
    if (secret.length < 8) continue;
    result = result.split(secret).join(MASK);
  }
  return result;
}
