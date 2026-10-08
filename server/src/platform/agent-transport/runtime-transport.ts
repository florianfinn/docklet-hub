import { AgentError, agentPost, type AgentTarget, type RequestOptions } from "./protocol.js";
import { streamFetch, StreamFetchError } from "./stream-fetch.js";

import { HUB_RUNTIME_TIMEOUT_MS } from "contract";

export const RUNTIME_TIMEOUT_MS = HUB_RUNTIME_TIMEOUT_MS;

function outcomeUnknown(cause: unknown): AgentError {
  return new AgentError("Ausgang der Laufzeitaktion unbekannt.", 502,
    { cause, detail: { error: "runtime-outcome-unknown" } });
}

function notSent(error: unknown): boolean {
  if (error instanceof StreamFetchError) return !error.requestSent;
  // Injected fetch implementations may only report connection establishment errors.
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  return ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(String(code));
}

export function runtimeFetch(fetchImpl: typeof fetch = streamFetch): typeof fetch {
  return async (input, init) => {
    init?.signal?.throwIfAborted();
    try { return await fetchImpl(input, init); }
    catch (error) {
      if (error instanceof AgentError || notSent(error)) throw error;
      // Without proof of a pre-send failure, never imply the action did not run.
      throw outcomeUnknown(error);
    }
  };
}

export async function runtimePost(target: AgentTarget, path: string, body: unknown, options: RequestOptions) {
  try {
    return await agentPost(target, path, body,
      { ...options, fetchImpl: runtimeFetch(options.fetchImpl), timeoutMs: RUNTIME_TIMEOUT_MS });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // A response body can break after its headers, while a malformed JSON body is a response error.
    if (error instanceof AgentError && error.cause !== undefined && !(error.cause instanceof SyntaxError)) {
      if (error.status !== null) throw outcomeUnknown(error);
    }
    throw error;
  }
}

export async function runtimeJson(response: Response) {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new AgentError("Ungültiges Laufzeitergebnis.", 502,
      { detail: { error: "runtime-invalid-response" } });
    throw outcomeUnknown(error);
  }
}
