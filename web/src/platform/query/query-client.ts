// The one place that decides how the web loads, caches and reloads data (#256).
//
// Before this step every screen loaded in its own `useEffect` with its own
// `cancelled` flag, and two screens asking the hub the same question asked it
// twice. TanStack Query takes over loading, caching and reloading; this file
// holds the policy every query shares, so a screen states WHAT it loads and
// not HOW OFTEN.
//
// Why `@tanstack/react-query` (AGENTS.md, "Abhängigkeiten"): MIT licensed, no
// runtime dependency besides its own core, and what it replaces is not twenty
// lines but a cache with request deduplication, invalidation by key prefix and
// cancellation, which every `useEffect` here rebuilt partly and differently.
//
// ⚠️ NO RELOAD ON WINDOW FOCUS, AS A DEFAULT AND NOT PER QUERY. Many reads of
// the hub contact an arm under the caller's name (`GET /api/hosts/:id/containers`
// lands in the agent's audit log, #117 Befund 9). A reload on every tab switch
// would write those entries without anyone asking. A query that wants it sets
// `refetchOnWindowFocus` itself, deliberately and next to a reason.
//
// ⚠️ NO REFETCH ON RECONNECT for the same reason, and because the screens that
// need fresh numbers have a "measure again" button that says what it does.

import { QueryClient } from "@tanstack/react-query";

import { ApiError, ResponseShapeError } from "../http/transport";

/** How many times a failed query is retried at most. */
export const MAX_RETRIES = 1;

/**
 * Whether a failed query is tried again.
 *
 * ⚠️ ONLY A FAILURE WITHOUT AN ANSWER IS RETRIED: `fetch` rejecting with a
 * network error. Every answer from the hub is final here:
 *
 * - a 4xx will not change by asking again, and a 401 must not be sent twice
 *   (the transport reports it to the sign-in on construction, see
 *   `session-expiry.ts`);
 * - a 5xx from the hub is mostly `502 agent-unreachable` or a timeout towards
 *   an arm; asking again doubles a wait of several seconds and changes nothing;
 * - a `ResponseShapeError` is a contract mismatch and as deterministic as a 4xx.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (error instanceof ApiError || error instanceof ResponseShapeError) return false;
  return true;
}

/**
 * A fresh client with the policy above.
 *
 * A factory and not a module value: a test builds one per mounted tree, so no
 * cache leaks from one case into the next, and the app builds exactly one in
 * `app/query/AppQueryProvider.tsx`.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false
      },
      mutations: {
        retry: false
      }
    }
  });
}
