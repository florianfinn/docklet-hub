import { CONTRACT_VERSION } from "contract";

// Minimum implementation release for writable operations; protocol compatibility is separate.
export const MIN_AGENT_VERSION = "0.32.0";

export type AgentVersion = readonly [major: number, minor: number, patch: number, rc?: number];

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(0|[1-9]\d*))?(?:\+[0-9A-Za-z.-]+)?$/;

// Missing or unreadable versions are returned as null so callers can fail closed.
export function parseAgentVersion(value: string | null | undefined): AgentVersion | null {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const rc = match[4] === undefined ? undefined : Number(match[4]);
  if (!core.every(Number.isSafeInteger) || (rc !== undefined && !Number.isSafeInteger(rc))) return null;
  return rc === undefined ? core : [...core, rc];
}

// Capability boundaries describe releases, so candidates of the same core remain eligible.
export function compareAgentReleaseVersions(a: AgentVersion, b: AgentVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// Update ordering includes numeric rc identifiers; the final release follows every candidate.
export function compareAgentVersions(a: AgentVersion, b: AgentVersion): number {
  const core = compareAgentReleaseVersions(a, b);
  if (core !== 0) return core;
  if (a[3] === b[3]) return 0;
  if (a[3] === undefined) return 1;
  if (b[3] === undefined) return -1;
  return a[3] - b[3];
}

export function isAgentOutdated(version: string | null | undefined): boolean {
  const parsed = parseAgentVersion(version);
  if (!parsed) return true;
  const minimum = parseAgentVersion(MIN_AGENT_VERSION);
  if (!minimum) throw new Error(`MIN_AGENT_VERSION ist keine Version: „${MIN_AGENT_VERSION}“.`);
  return compareAgentReleaseVersions(parsed, minimum) < 0;
}

// Missing protocol versions fail closed independently of the implementation release.
export function speaksAgentContract(contractVersion: number | null | undefined): boolean {
  return typeof contractVersion === "number" && contractVersion >= CONTRACT_VERSION;
}

// Older agents cannot enforce externallyManaged restrictions during registry synchronization.
export const EXTERNALLY_MANAGED_AGENT_VERSION = "0.31.0";

export function supportsExternallyManaged(version: string | null | undefined): boolean {
  const parsed = parseAgentVersion(version);
  const minimum = parseAgentVersion(EXTERNALLY_MANAGED_AGENT_VERSION);
  if (!parsed || !minimum) return false;
  return compareAgentReleaseVersions(parsed, minimum) >= 0;
}
