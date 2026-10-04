// Limits on what an operator types when creating a host. The server rejects
// input beyond them (`createHost`, `parseNewHost`), the web checks the same
// rule before sending.

/**
 * Longest allowed host name, in characters, after trimming.
 *
 * The hub's WireGuard peer list refuses longer names (`renderWireGuardConfig`);
 * a host accepted beyond this would break that file for every arm.
 */
export const HOST_NAME_MAX = 200;

/**
 * C0, DEL, C1 and the two Unicode line separators (U+2028, U+2029). Each of
 * them can end or split a line in a generated file (`docker-compose.yml`,
 * `.env`, `wg0.conf`). Wider than `hasControlCharacter` of the agent protocol.
 */
export function hasControlOrLineSeparator(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

export type HostNameProblem = "empty" | "control-character" | "too-long";

/** Why a host name is unusable, or `null`. Judges the trimmed value. */
export function hostNameProblem(name: string): HostNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === "") return "empty";
  if (hasControlOrLineSeparator(trimmed)) return "control-character";
  if (trimmed.length > HOST_NAME_MAX) return "too-long";
  return null;
}
