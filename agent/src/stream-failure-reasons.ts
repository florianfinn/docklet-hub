import {
  LOGS_STREAM_FAILURE_REASONS,
  PULL_STREAM_FAILURE_REASONS,
  type LogsStreamFailureReason,
  type PullStreamFailureReason
} from "contract";
import { EngineError, EnginePullError } from "./engine.js";

// The failure reason sets of the two Docker-backed streams (issue #82),
// broken down by cause instead of written into a catch-all bucket (#80).
//
// `log-file` does not get its own set here but in log-file.ts
// (LOG_FILE_FAILURE_REASONS) — that is where OpenError and TailEnded already
// live, from which it follows. This file only collects the two streams whose
// reasons arise in the route handlers (logs-stream in
// src/routes/container-routes.ts, pull-stream in src/routes/image-routes.ts)
// and that would otherwise have no file of their own. An array instead of a
// pure type union, for the same reason as there: a type is gone at runtime,
// but a reconciliation script can import and count an array.
//
// ⚠️ Deliberately THREE separate sets (two here, the third in log-file.ts)
// instead of a common base type: the three streams distinguish different
// amounts, and a common type would be a claim of sameness that is already
// wrong today.
//
// --- What changed with #80 ----------------------------------------------------
//
// Before, each of the two sets carried exactly two values: "abgebrochen" and a
// "*-fehlgeschlagen". Both told the caller too little, and for opposite
// reasons.
//
//   * "abgebrochen" was the NORMAL CASE — someone closed the tab. Reported as
//     `kind: "error"`, it turns an everyday occurrence into an event a UI has
//     to explain. That is why it is no longer in either set: the handler sends
//     no error line at all on an abort. The connection it would go into is
//     exactly the one that just closed — it never had a reader.
//   * "logs-fehlgeschlagen" and "pull-fehlgeschlagen" were the catch-all bucket
//     for everything else: container vanished, socket gone, engine restarted,
//     registry unreachable — all the same value. Of all cases, the one that
//     should have said something said the least.
//
// The breakdown follows what the caller would DO DIFFERENTLY: "the container
// is gone" means closing the view, "the engine refused" means looking at
// what, "the connection to the engine broke" means waiting and reconnecting.
//
// ⚠️ The catch-all bucket stays in both sets as the LAST value, and that is
// intentional: it now only catches what is none of the named cases — a
// programming error in the demuxer, for instance. Leaving it out would mean
// lying such a case into one of the named values.
//
// The values were English before the rest (#80): an English value is
// accessible to a German-speaking reader, a German one not to an
// English-speaking one. Since contract 6 (#278) every value is.

// The `code` values node attaches to a socket failure towards the Docker
// engine. The socket is a Unix socket, so nothing from name resolution
// appears here.
//
// ENOENT and EACCES are the case "docker.sock is not there or not readable" —
// for the agent typically a restarted daemon or a rebuilt container without
// the mount. ETIMEDOUT is set by engine.ts itself on its idle window
// (`engineTimeoutError`).
const ENGINE_TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ENOENT",
  "EACCES",
  "ETIMEDOUT"
]);

function isEngineTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && ENGINE_TRANSPORT_ERROR_CODES.has(code);
}

// The lists live in the shared contract since #272 (`contract/src/agent/reasons.ts`).
export { LOGS_STREAM_FAILURE_REASONS, PULL_STREAM_FAILURE_REASONS };
export type { LogsStreamFailureReason, PullStreamFailureReason };

// ⚠️ At this route 404 means exactly one thing: the container no longer
// exists. The path carries the id, and the agent resolved it itself right
// before — so it is not the "mistyped" case but "removed between the inspect
// and now". That is the most common real failure of this stream and could
// previously not be told apart from a daemon restart.
export function logsStreamFailureReason(error: unknown): LogsStreamFailureReason {
  if (error instanceof EngineError) {
    return error.status === 404 ? "container-gone" : "engine-refused";
  }
  if (isEngineTransportFailure(error)) return "engine-unreachable";
  return "logs-failed";
}


// ⚠️ The order of the branches is not arbitrary here: EnginePullError
// INHERITS from EngineError (engine.ts) and carries its status 502. If the
// EngineError branch came first, it would catch it too and every registry
// failure would arrive as `engine-refused` — i.e. as a statement about the
// daemon instead of about the registry.
//
// `pull-rejected` deliberately stays ONE value for everything the daemon
// reports in the stream (ref does not exist, no credentials, registry
// unreachable). Splitting it further would mean sorting the daemon's message
// text by wording — which is no promise and changes between daemon versions.
// In return the value reliably says WHERE to look: at the ref and the
// registry, not at the agent.
export function pullStreamFailureReason(error: unknown): PullStreamFailureReason {
  if (error instanceof EnginePullError) return "pull-rejected";
  if (error instanceof EngineError) {
    return error.status === 404 ? "image-not-found" : "engine-refused";
  }
  if (isEngineTransportFailure(error)) return "engine-unreachable";
  return "pull-failed";
}
