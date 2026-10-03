import { waitFor } from "./dom-harness.js";

// The settled roots of the lazily loaded ComposeView: file view, error and empty stack.
// The Suspense fallback and ComposeView's own loading text look alike and match none of them.
const SETTLED = ["compose-view", "compose-error", "compose-no-container"]
  .map((id) => `[data-testid="${id}"]`)
  .join(", ");

/** Waits until ComposeView has left its loading states; false after the deadline. */
export function composeSettled(timeoutMs?: number): Promise<boolean> {
  return waitFor(() => document.querySelector(SETTLED) !== null, timeoutMs);
}
