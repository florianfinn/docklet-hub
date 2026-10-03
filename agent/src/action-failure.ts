// How a thrown error becomes a response that actually says something.
//
// Without this mapping, a throw from an engine or Compose call falls into the
// global handler in `src/index.ts` and becomes
// `500 {"error":"internal-error"}` there. This is not cosmetic: that is exactly
// how the outage of 2026-08-25 reached the operator (safe actions, fixed in
// v0.13.0), and again the one of 2026-09-01 (#48, recreate). Both times the
// engine had long since said a sentence about it, and both times the operator
// took the path for failed and reached for the next bigger hammer — the second
// time for a problem the first call had already solved.
//
// The translation sits in its own module and not in the handler code
// (`src/index.ts`, `src/routes/*.ts`), because that code has no test and this
// mapping is exactly the kind of rule you want to check: which status goes out,
// what lands in the audit log, and what a caller who is NOT internal gets to see.

import { ComposeError } from "./compose-cli.js";
import { EngineError, engineMessage } from "./engine.js";
import { ImageMismatchError, RecreateFailure } from "./recreate.js";

export type ActionFailure = {
  // The HTTP status of the response.
  status: number;
  // What goes into the agent's audit log. It lives on the host, not on the
  // network — the full sentence goes here, even when the response withholds it.
  auditReason: string;
  // The response body. The reason is a stable value so that a consumer can
  // translate it instead of parsing a sentence.
  body: Record<string, unknown>;
};

// `null` means: this error is none of the known failures but a programming
// error. On recreate it also carries the rollback outcome, but stays a 500
// with the generic error key.
export function actionFailureOf(
  error: unknown,
  options: { tier: "internal" | "external" | null }
): ActionFailure | null {
  if (error instanceof RecreateFailure) {
    const original = actionFailureOf(error.original, options);
    const rollback = { rollbackAttempted: error.rollbackAttempted, rolledBack: error.rolledBack };
    // An unknown programming error stays a 500. The outcome of the rollback
    // steps that already ran must still not disappear.
    return {
      status: original?.status ?? 500,
      auditReason: `${original?.auditReason ?? `${error.name}: ${error.message}`} (rollbackAttempted: ${error.rollbackAttempted}, rolledBack: ${error.rolledBack})`,
      body: { ...(original?.body ?? { error: "internal-error" }), ...rollback }
    };
  }
  if (error instanceof EngineError) {
    const message = engineMessage(error);
    return {
      // The engine DID answer — its status is the more honest information than
      // a blanket 502. Only a status outside the HTTP error range (e.g. the 502
      // of the response size cap) falls back to it.
      status: error.status >= 400 && error.status < 600 ? error.status : 502,
      auditReason: `engine-action-failed: ${message}`,
      body: {
        error: "engine-action-failed",
        engineStatus: error.status,
        // ⚠️ The message itself goes out ONLY internally. It can carry container
        // names and ids; the agent draws the same line for the field errors of
        // spec validation, and the main API only passes structured details on
        // for `tier: internal` anyway.
        ...(options.tier === "internal" ? { engineMessage: message } : {})
      }
    };
  }

  if (error instanceof ComposeError) {
    return {
      // Compose has no HTTP. 502 says what is true: the tool behind the agent
      // failed, not the request.
      status: 502,
      auditReason: `compose-action-failed (exit ${error.code ?? "?"}): ${error.message}`,
      body: {
        error: "compose-action-failed",
        composeExitCode: error.code
        // ⚠️ stderr does NOT go out. It carries host paths and image refs and
        // stays in the agent log; the stack path draws the same line with
        // `compose-stack-aktion-fehlgeschlagen`.
      }
    };
  }

  if (error instanceof ImageMismatchError) {
    // Not an engine failure but the guard kicking in: between confirmation and
    // `create`, the ref pointed to a different image. The container has been
    // rolled back. 409 like the check before it, but with its own reason —
    // "confirmed, and still a different one" is a different situation from
    // "never confirmed in the first place".
    return {
      status: 409,
      auditReason: `image-mismatch-after-create: ${error.actualImageId.slice(0, 19)} instead of ${error.expectedImageId.slice(0, 19)}`,
      body: {
        error: "image-mismatch-after-create",
        expectedImageId: error.expectedImageId,
        actualImageId: error.actualImageId
      }
    };
  }

  return null;
}
