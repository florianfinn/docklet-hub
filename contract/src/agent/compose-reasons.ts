import * as z from "zod/mini";

// The error keys of the raw editor — as a set with a name (#89), in `contract`
// since #272 so that hub and agent read the same list.
//
// They were already a contract before: the hub translates each of them into
// an answerable follow-up question, and the final line of the stream (#86)
// passes them on verbatim. They just were not WRITTEN DOWN anywhere — they came
// into being as strings at their throw sites in the agent, and every throw
// site was its own truth.
//
// ⚠️ What was silent about it, and on both sides:
//
//   * The hub could only ANCHOR its side ("this line holds this text"), not
//     COMPARE — there was no set it could have compared against. If a key
//     were added here, everything over there would stay green: the old anchors
//     still sit on their lines. The new case would fall into the `default`
//     branch of its translation and become a nameless failure — an answerable
//     question turned into a dead end, and precisely for the operator who is
//     applying a compose file right now.
//   * Here, a typo at a throw site could not break anything. `keine-
//     servics` would have passed every check and arrived at the caller as an
//     unknown key.
//
// The same construction as `reasons.ts` next to it, and for the same reason
// an array instead of a pure type union: a type is gone at runtime, but a
// reconciliation script can import an array and count it.
//
// ⚠️ A list that grows alongside reality is worse than none — it looks as if
// it were correct. Two guards hold both directions, and both are needed:
//
//   1. The compiler. No key of this route is created as a free string any
//      more: `planFromInspection` and `executeRawApply` in the agent return
//      the types from here, and in its route handlers
//      (routes/compose-raw-routes.ts, routes/stack-routes.ts) and
//      runtime/raw-ops.ts every `error:` value goes through `rawReason()`,
//      whose parameter is exactly this set. What is not in the list does not
//      compile.
//   2. agent/src/compose-raw-failure-reasons.test.ts. It checks the opposite direction
//      (every key really occurs in the source) and that the throw sites
//      actually take the route via `rawReason()`.
//
// The split by location is that of the flow and not a tidiness exercise: it
// tells the caller WHEN it can see a key. On the streamed route that is the
// difference between a real HTTP status and a final line.

// --- Gate: everything decided BEFORE the project lock ----------------------
//
// On the stream (#86) exactly these remain a real HTTP status: the header only
// goes out once the lock is held. Everything after that is in the final line.
//
// `stack-busy` does not arise in this branch but in the shared error
// handler, from the KeyedMutexBusyError of `runExclusive` (agent/src/concurrency.ts). It
// is listed here anyway, because the caller receives it on this route — the
// list describes what arrives, not where it is thrown.
//
// `directory-taken` only exists on creation (POST /stacks/raw),
// `too-many-streams` only on the stream, `tier-missing` on neither: the route
// table binds all three routes intern-only, the branch only exists for the
// type guarantee. A key that CAN occur still belongs in the list — the caller
// translates responses, not probabilities.
export const COMPOSE_RAW_GATE_FAILURE_REASONS = [
  "agent-read-only",
  "not-allowlisted",
  "tier-missing",
  "name-not-usable-as-directory",
  "invalid-compose-file-name",
  "compose-project-name-missing-or-invalid",
  "project-dir-outside-base-path",
  "self-management-locked",
  "compose-file-missing",
  "compose-anchor-labels-missing",
  "compose-anchor-outside-base-path",
  "compose-anchor-file-ambiguous",
  "directory-taken",
  "stack-service-not-allowlisted",
  "compose-hash-missing",
  "confirmation-missing",
  "too-many-streams",
  "stack-busy"
] as const;

// --- Phase 1: the verdict on the draft -------------------------------------

// What `planFromInspection` (agent/src/raw-apply.ts) holds against a draft. Pure: no
// file system, no process, no engine — which is why this set is available to
// the dry run without any reservations.
export const COMPOSE_RAW_PLAN_FAILURE_REASONS = [
  "invalid-compose-file",
  "no-services",
  "service-without-image"
] as const;

// What the dry run (#85) carries in its `reason` — verbatim the reason with
// which applying the same draft would abort.
//
// ⚠️ The dry run answers with 200 and `valid: false` in that case. A status
// other than 200 there always means that the INFORMATION could not be obtained
// (anchor stale, file missing) — never that the draft is no good.
export const COMPOSE_RAW_PREVIEW_FAILURE_REASONS = [
  "invalid-content",
  ...COMPOSE_RAW_PLAN_FAILURE_REASONS
] as const;

// The whole check phase as it applies to applying: the verdict on the text,
// the anchor freshly looked up under the lock and the three follow-up
// questions that require a decision by the caller.
//
// ⚠️ The last three are not rejections but follow-up questions: they NAME what
// has to be decided, and the same request with the list goes through. The
// purpose of this file hinges on exactly that — if one of them falls into a
// `default` branch at the hub, an answerable question becomes a dead end.
export const COMPOSE_RAW_CHECK_FAILURE_REASONS = [
  ...COMPOSE_RAW_PREVIEW_FAILURE_REASONS,
  "stack-anchor-stale",
  "service-confirmation-missing",
  "image-not-local",
  "image-ref-unreadable"
] as const;

// --- Phase 2: execute ------------------------------------------------------

// The hash latch from agent/src/compose-store.ts (`WriteResult`).
//
// ⚠️ These two keys do not belong to the raw editor alone — the spec path
// throws them as well. They are therefore NOT held here but mirrored:
// `executeRawApply` passes `written.reason` through unchanged, and it is at
// exactly this assignment that the compiler checks the subset relation. If a
// third reason is added in agent/src/compose-store.ts, the build fails there.
//
// `file-already-exists` only exists on creation (expectedHash === null),
// `file-changed-externally` only on editing. Only the latter additionally carries
// `actualHash` — the conflict dialog in the editor needs the actual hash to be
// able to offer "my version"/"file" (§13.4).
export const COMPOSE_RAW_FILE_FAILURE_REASONS = [
  "file-changed-externally",
  "file-already-exists"
] as const;

// What `executeRawApply` can report after something real has been written.
//
// ⚠️ Each of these responses carries `rolledBack`, and that is the part that
// counts: it says WHERE the stack stands. A failure without this information
// would be unmanageable for the operator.
export const COMPOSE_RAW_APPLY_FAILURE_REASONS = [
  ...COMPOSE_RAW_FILE_FAILURE_REASONS,
  "compose-up-failed",
  "container-not-resolvable",
  "hardening-newly-violated"
] as const;

// --- The stream ------------------------------------------------------------

// The only key that is NOT an outcome of applying (#86).
//
// ⚠️ `kind: "error"` means something different from a result with `error`:
// there the outcome is named and `rolledBack` says where the stack stands.
// Here it is UNKNOWN — the exception came from a call that never reached its
// verdict. The caller has to re-read the state. Anyone who translates it like
// a named failure promises the operator a certainty that does not exist here.
export const COMPOSE_RAW_STREAM_FAILURE_REASONS = ["compose-raw-failed"] as const;

// --- The whole set ---------------------------------------------------------

// Everything the four raw branches (`compose-raw`, `compose-raw-stream`,
// `compose-raw-preview`, `POST /stacks/raw`) themselves answer as a named
// failure.
//
// ⚠️ Where this list ends, and why exactly there: the shared front matter
// before the dispatch answers the same on EVERY route — `checkTier` with
// `internal-only-action` (agent/src/route-policy.ts), authentication, an unknown route.
// Those are not statements about the raw editor, and whoever translates them
// does so once for the whole agent. `stack-busy`, on the other hand,
// is included even though it also arises in the shared error handler: the lock
// it depends on is taken by this branch itself.
//
// ⚠️ These are more than the 24 that the changelog for v0.22.0 names, and that
// is not a contradiction: there the keys of APPLYING AT THE ANCHOR are counted.
// They lack the five that do not exist there — `directory-taken` and
// `file-already-exists` (only on creation), `too-many-streams` and
// `compose-raw-failed` (only on the stream) and `tier-missing` (not
// reachable on any of the routes). The test recalculates exactly that, so that
// the number from the changelog stays verifiable instead of asserted.
export const COMPOSE_RAW_FAILURE_REASONS = [
  ...COMPOSE_RAW_GATE_FAILURE_REASONS,
  ...COMPOSE_RAW_CHECK_FAILURE_REASONS,
  ...COMPOSE_RAW_APPLY_FAILURE_REASONS,
  ...COMPOSE_RAW_STREAM_FAILURE_REASONS
] as const;

export type ComposeRawPlanFailureReason = (typeof COMPOSE_RAW_PLAN_FAILURE_REASONS)[number];

export type ComposeRawPreviewFailureReason = (typeof COMPOSE_RAW_PREVIEW_FAILURE_REASONS)[number];

export type ComposeRawApplyFailureReason = (typeof COMPOSE_RAW_APPLY_FAILURE_REASONS)[number];

/**
 * Every key as a schema value, so that a rename happens under the type check.
 *
 * ⚠️ The hub does NOT parse a received `error` against it: a key a newer
 * agent adds travels on verbatim as `reason` and must not fail a reader here.
 */
export const composeRawFailureReasonSchema = z.enum(COMPOSE_RAW_FAILURE_REASONS);

export type ComposeRawFailureReason = z.infer<typeof composeRawFailureReasonSchema>;
