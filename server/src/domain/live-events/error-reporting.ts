import { AgentError } from "../../platform/agent-transport/protocol.js";

export type LiveRuntimeError = {
  operation: "reconcile" | "monitor";
  reason: string;
  status?: number;
  code?: string;
  suppressed: number;
};
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const LOCAL_REASONS = new Set(["host-unknown", "host-resync-failed", "monitor-stream-unavailable", "monitor-stream-interrupted", "monitor-stream-ended"]);
const ERROR_NAMES = new Set(["TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError"]);
export const LIVE_ERROR_INTERVAL_MS = 30_000;

/** Log only local categories, HTTP status and known transport codes, never remote text. */
export function createLiveErrorReporter(log: (error: LiveRuntimeError) => void, now: () => number = Date.now) {
  const recent = new Map<string, { at: number; suppressed: number }>();
  return (operation: LiveRuntimeError["operation"], error: unknown) => {
    const detail: LiveRuntimeError = {
      operation,
      reason: error instanceof AgentError ? "agent-error" :
        error instanceof Error && LOCAL_REASONS.has(error.message) ? error.message :
          error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : "unknown-error",
      suppressed: 0
    };
    if (error instanceof AgentError && error.status !== null) detail.status = error.status;
    let cause = error;
    for (let depth = 0; depth < 4 && cause !== null && typeof cause === "object"; depth++) {
      if ("code" in cause && typeof cause.code === "string" && NETWORK_CODES.has(cause.code)) { detail.code = cause.code; break; }
      cause = "cause" in cause ? cause.cause : undefined;
    }
    const key = JSON.stringify(detail);
    const previous = recent.get(key);
    if (previous && now() - previous.at < LIVE_ERROR_INTERVAL_MS) { previous.suppressed++; return; }
    detail.suppressed = previous?.suppressed ?? 0;
    if (recent.size >= 32) recent.delete(recent.keys().next().value!);
    recent.set(key, { at: now(), suppressed: 0 });
    log(detail);
  };
}
