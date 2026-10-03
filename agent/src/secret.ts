import crypto from "node:crypto";

// Check of the shared secret between main API and agent — with a transition
// value for rotation (#19).
//
// Up to here the agent compared exactly ONE value. A change was therefore a
// synchronous intervention on two hosts: as long as the main API still sends
// the old value and the agent already expects the new one, it answers every
// request with 401 — on the only path that leads to the socket. A change that
// costs an outage does not happen; the secret then stays the same for years,
// and that is the actual finding.
//
// A module of its own and not three lines in the HTTP layer (index.ts,
// runtime/http.ts, runtime/state.ts), because the properties that matter (both
// values are checked, the timing does not reveal which, the counter only counts
// the transition value) would otherwise not be testable — the HTTP layer has no
// test file.

export type SecretMatch = "primary" | "secondary" | "wrong";

function same(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

export class SecretValidation {
  private secondaryUses = 0;

  constructor(
    private readonly primary: string,
    // `null` = no rotation, and that is the normal state.
    private readonly secondary: string | null = null
  ) {}

  check(value: unknown): SecretMatch {
    if (typeof value !== "string") return "wrong";
    // ⚠️ Both comparisons ALWAYS run, even if the first one already matches. A
    // `||` would skip the second and thereby reveal via the timing WHICH of the
    // two values matched — during a rotation that is exactly the information
    // nobody outside is supposed to get.
    const matchMain = same(value, this.primary);
    const matchSecondary = this.secondary !== null && same(value, this.secondary);
    if (matchMain) return "primary";
    if (matchSecondary) {
      // Only what came in EXCLUSIVELY via the transition value is counted.
      // Exactly this number answers "can the old value go?" — if it stands
      // still after switching the main API over, the window is empty.
      this.secondaryUses += 1;
      return "secondary";
    }
    return "wrong";
  }

  get secondaryActive(): boolean {
    return this.secondary !== null;
  }

  get secondaryUsed(): number {
    return this.secondaryUses;
  }
}
