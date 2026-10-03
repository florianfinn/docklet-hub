export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "EngineError";
  }
}

// The sentence the engine itself said — without the `engine responded
// <status>:` prefix and without the JSON wrapper the daemon puts around it.
//
// `EngineError.message` is built for a log and is right that way there. Where
// the message is instead shown to a human (stage: outage of 2026-08-25, where
// "cannot join network of a non running container" never made it out of the
// agent's stderr), the prefix is noise: the status code sits right next to it
// in the response anyway.
//
// ⚠️ Deliberately stays lenient. Older daemons and errors outside the JSON API
// answer with plain text; then the text itself is the best available
// information and is passed through, not discarded.
export function engineMessage(error: EngineError): string {
  const withoutPrefix = error.message.replace(/^engine responded \d+:\s*/, "");
  try {
    const payload = JSON.parse(withoutPrefix) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const message = (payload as Record<string, unknown>).message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    // Not JSON — then the text already is the message.
  }
  return withoutPrefix || error.message;
}

// The failure the daemon reports IN THE MIDDLE OF the pull stream instead of
// expressing it through the status (#80).
//
// /images/create answers 200 and writes "manifest unknown", "no basic auth
// credentials" or "connection refused" as a line into the progress output.
// Without its own type this reached the caller as an EngineError with status
// 502 — i.e. word for word the same as a daemon that rejects the route itself.
// Those are two different messages to the operator: one says "the registry or
// the ref", the other "the daemon here".
//
// Deliberately inherits from EngineError: every existing `instanceof EngineError`
// check in the codebase still sees it, and `status` stays 502 as before.
export class EnginePullError extends EngineError {
  constructor(message: string) {
    super(message, 502);
    this.name = "EnginePullError";
  }
}

// Not a failure of the engine but a request deliberately cut off by the caller
// (user request: cancel a pull manually). Its own type so the caller does not
// log or display the cancellation as a failure — since #80 that means there:
// no error line at all and an `aborted` in the audit.
export class EngineAbortError extends Error {
  constructor() {
    super("aborted by the caller");
    this.name = "EngineAbortError";
  }
}
