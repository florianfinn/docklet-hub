import { ActionQueueError } from "./concurrency.js";
import { StackEndpointError } from "./stack-control.js";
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

// Carries the original classification and recovered state to the handler.
export class RuntimeActionFailure extends Error {
  constructor(readonly failure: ActionFailure) {
    super(String(failure.body.error));
    this.name = "RuntimeActionFailure";
  }
}

export function actionFailureOf(error: unknown, runtime: true): ActionFailure;
export function actionFailureOf(error: unknown): ActionFailure | null;
export function actionFailureOf(error: unknown, runtime = false): ActionFailure | null {
  if (error instanceof RuntimeActionFailure) return error.failure;
  if (runtime && error instanceof AggregateError && error.errors.length > 0) {
    const failures = error.errors.map((cause: unknown) => actionFailureOf(cause, true));
    return { ...failures[0], auditReason: failures.map((failure) => failure.auditReason).join("; recovery: ") };
  }
  if (runtime && (error instanceof StackEndpointError || error instanceof ActionQueueError)) {
    return {
      status: error instanceof StackEndpointError ? error.status : 409,
      auditReason: error.code,
      body: { error: error.code, ...(error instanceof StackEndpointError ? error.details : {}) }
    };
  }
  if (error instanceof RecreateFailure) {
    const original = runtime ? actionFailureOf(error.original, true) : actionFailureOf(error.original);
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
        ...(runtime ? {} : { engineMessage: message })
      }
    };
  }

  if (error instanceof ComposeError) {
    return {
      // Compose has no HTTP. 502 says what is true: the tool behind the agent
      // failed, not the request.
      status: 502,
      auditReason: `compose-action-failed (exit ${error.code ?? "?"}): ${error.message}${error.stderr ? `; stderr: ${error.stderr}` : ""}`,
      body: {
        error: "compose-action-failed",
        ...(runtime ? {} : { composeExitCode: error.code })
        // stderr can contain host paths and stays in the audit.
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

  return runtime ? {
    status: 500,
    auditReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    body: { error: "internal-error" }
  } : null;
}
