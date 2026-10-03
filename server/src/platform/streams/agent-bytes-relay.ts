// Binds one agent byte stream to one Express response — the counterpart of
// `relayAgentStream` for a body that is not NDJSON, the download of a file
// (#262).
//
// ⚠️ WHAT THIS MODULE DECIDES, AND WHY NOT THE ROUTE. The download of a file is
// a relay and not a collection: `FileDownload` carries a `ReadableStream`, and
// in this direction the agent knows NO upper bound (`MAX_UPLOAD_BYTES` caps
// the upload only). Whoever reads the stream to its end and then delivers it
// holds the whole file in the hub's memory, per simultaneous download and with
// no number to estimate it from. So:
//
//   1. Every chunk is written as soon as it is there, and the writer waits for
//      the response buffer when `response.write` says it is full
//      (`waitUntilWritable`, the one back-pressure of #131). Without the wait
//      Node's output buffer grows exactly as far as collecting would have, only
//      unseen.
//   2. The browser leaving aborts the agent stream and ends the loop, also
//      while a write waits for the buffer: a closed connection counts as
//      `drain`, and the loop checks `signal` and `destroyed` before the next
//      write. Otherwise the agent keeps one of its slots (`MAX_OPEN_STREAMS`)
//      and reads a file nobody receives.
//   3. A failure BEFORE the status is out is still a status, translated by
//      `translateAgentError` (that is where the agent's `429` becomes
//      `too-many-streams`). After it, the response can only end: a status code
//      cannot be sent once headers are out, and a half file must not look like
//      a whole one, so the connection is destroyed and not ended cleanly.
//
// ⚠️ ONLY THE `close` OF THE RESPONSE IS BOUND, not the request's. A download is
// a GET, and `close` on the request can fire as soon as the call is fully
// read; the response's `close` is the one that falls when the connection ends.

import type { Response } from "express";

import { AgentError } from "../agent-transport/protocol.js";
import { translateAgentError } from "../http/agent-error-translation.js";
import { waitUntilWritable } from "../http/stream-response.js";

/** What the agent hands over: the raw body and, if it said so, its length. */
export type AgentBytes = {
  /** From `content-length`; `null` when the agent does not name it. */
  size: number | null;
  stream: ReadableStream<Uint8Array>;
};

export type AgentBytesRelayOptions = {
  /** The headers of the answer, set once the agent stream stands. */
  headers: Record<string, string>;
  /** How an `AgentError` before the status became a status; defaults to `translateAgentError`. */
  translateError?: (error: AgentError, response: Response) => void;
};

/**
 * Opens the agent's byte stream and relays it to `response`.
 *
 * Resolves once the response is finished in every case it handles: normal end,
 * browser abort, agent failure before or after the status. Rethrows only what
 * is not an `AgentError` and happened before the status — a bug of the hub that
 * belongs to the error handler.
 */
export async function relayAgentBytes(
  response: Response,
  options: AgentBytesRelayOptions,
  open: (signal: AbortSignal) => Promise<AgentBytes>
): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => {
    // A response that finished on its own is no abort.
    if (!response.writableFinished) controller.abort();
  };
  response.once("close", abort);
  // A browser that left while the hub was still deciding (host, container,
  // share) is gone before this function started; its `close` fired already.
  if (response.destroyed) abort();

  try {
    let bytes: AgentBytes;
    try {
      bytes = await open(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        // Nobody is there to send a status to.
        if (!response.writableEnded) response.end();
        return;
      }
      if (!(error instanceof AgentError)) throw error;
      (options.translateError ?? translateAgentError)(error, response);
      return;
    }

    if (controller.signal.aborted) {
      // The browser left while the agent answered: nobody receives the status,
      // and the agent's stream must not stay open.
      void bytes.stream.cancel().catch(() => undefined);
      return;
    }

    // ⚠️ FROM HERE THE STATUS IS GIVEN. Everything that can be translated is
    // translated above; a failure after this can only be the end of the answer.
    // A `response.status(…)` here throws.
    response.status(200);
    for (const [name, value] of Object.entries(options.headers)) response.setHeader(name, value);
    // Only if the agent named it: a guessed length is worse than none, the
    // browser would cut the file at the wrong place.
    if (bytes.size !== null) response.setHeader("content-length", String(bytes.size));

    await pump(bytes.stream, response, controller.signal);
  } finally {
    response.off("close", abort);
  }
}

async function pump(stream: ReadableStream<Uint8Array>, response: Response, signal: AbortSignal): Promise<void> {
  const reader = stream.getReader();
  let finished = false;
  try {
    for (;;) {
      if (signal.aborted || response.destroyed) break;
      const step = await reader.read();
      if (step.done) {
        finished = true;
        break;
      }
      if (!response.write(step.value)) await waitUntilWritable(response);
    }
  } catch (error) {
    // The agent side broke after the status: the answer cannot say so, and
    // ending it cleanly would let a half file pass for a whole one. The
    // browser sees an aborted download; only what is no failure of the
    // transfer goes on to the error handler.
    response.destroy();
    if (signal.aborted || error instanceof AgentError || isAbort(error)) return;
    throw error;
  } finally {
    // Also on abort: without it the connection to the agent stays open until
    // the agent notices by itself.
    reader.releaseLock();
    void stream.cancel().catch(() => undefined);
  }
  if (finished && !response.destroyed && !response.writableEnded) response.end();
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
