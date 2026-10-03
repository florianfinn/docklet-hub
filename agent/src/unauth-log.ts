// Aggregation of rejected requests BEFORE the secret check.
//
// The endpoint path and the `actor` header of an unauthenticated request are
// entirely controlled by outsiders, and the audit log is by construction never
// deleted (audit.ts). One line per attempt would thus turn "someone is
// knocking" into a means of filling up the /state volume — and an agent
// without a writable audit log executes nothing at all any more
// (assertWritable).
//
// The answer to that is deliberately NOT discarding: the first attempt of a
// window is logged immediately, every further one increments a counter, and
// the next entry carries it along. A knock stays visible, a flood becomes a
// number instead of a million lines — the log thus holds more information
// than before, not less.
//
// Pure and without a clock import, so the window behaviour is testable without
// waiting.

export const UNAUTH_WINDOW_MS = 60_000;

export type UnauthDecision =
  | { write: false }
  | { write: true; suppressed: number };

export class UnauthThrottle {
  private windowStart = 0;
  private seen = 0;
  private suppressed = 0;

  constructor(private readonly windowMs: number = UNAUTH_WINDOW_MS) {}

  // `now` is passed in instead of coming from Date.now(): a throttle whose
  // behaviour can only be checked by actually waiting does not get checked.
  report(now: number): UnauthDecision {
    if (this.seen === 0 || now - this.windowStart >= this.windowMs) {
      const suppressed = this.suppressed;
      this.windowStart = now;
      this.seen = 1;
      this.suppressed = 0;
      return { write: true, suppressed };
    }
    this.seen += 1;
    this.suppressed += 1;
    return { write: false };
  }
}
