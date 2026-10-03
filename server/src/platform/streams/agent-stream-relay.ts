// Binds one agent stream to one Express response — open, data, failure, end
// and abort in both directions, written once instead of per route (#253).
//
// ⚠️ WHAT THIS MODULE DECIDES, AND WHY NOT EACH ROUTE. Logs, shell and compose
// each relay NDJSON from the agent to the browser, and each wrote its own
// version of the same four decisions. They are easy to get subtly wrong in a
// copy:
//
//   1. The browser leaving is the NORMAL end of a stream, not an error. It
//      aborts the agent stream (otherwise it holds one of the agent's
//      slots, `MAX_OPEN_STREAMS` in `contract/src/agent/limits.ts`, until the
//      agent notices; that many abandoned tabs and it answers everyone with
//      `429`) and writes no line:
//      the connection that line would travel on is the one that just closed.
//      The hub never invents an `abgebrochen` for it (finding 14 of #117).
//   2. The agent side breaking after the status is out is a line in the
//      stream (`brokenEvent`) followed by the end of the response — a status
//      code can no longer be sent once headers are out.
//   3. A failure BEFORE the stream opened is still an HTTP status, translated
//      by `translateAgentError`. That is also where the agent's `429` becomes
//      `too-many-streams`, so the stream cap stays visible to the browser.
//   4. Back-pressure: `write` resolves only when the response buffer accepts
//      more (`ndjsonWriter`), and a closed connection counts as `drain`, so
//      a browser leaving with a full buffer cannot leave the reader hanging.
//
// Transport stays NDJSON over HTTP; there is no WebSocket here.

import type { Request, Response } from "express";

import { AgentError } from "../agent-transport/protocol.js";
import { translateAgentError } from "../http/agent-error-translation.js";
import { ndjsonWriter } from "../http/stream-response.js";

/** What the route's reader gets to work with while the stream runs. */
export type AgentStreamRelay = {
  /**
   * Aborted as soon as the browser's connection closes. Hand it to the agent
   * stream; reading stops with it.
   */
  readonly signal: AbortSignal;
  /**
   * The agent answered `200`: send status and headers now. From here on a
   * failure is a line in the stream, never a status code.
   *
   * ⚠️ Call it when the agent stream STANDS, not with the first line. A
   * container whose log opens slowly would otherwise look like a request
   * without an answer.
   */
  readonly open: () => void;
  /** Writes one event; the returned promise IS the back-pressure. */
  readonly write: (event: unknown) => Promise<void>;
};

export type AgentStreamRelayOptions = {
  /**
   * The line the hub writes when the agent side breaks after the stream is
   * open. It is a word of the hub (`contract/src/stream/hub-stream-reasons.ts`
   * file), passed in because each stream wraps it in its own event shape.
   */
  brokenEvent: unknown;
  /**
   * How an `AgentError` before the stream opened becomes a status. Defaults to
   * `translateAgentError`; a surface whose refusals mean other things for the
   * same status passes its own (the shell, `features/shell/rejections.ts`,
   * #260).
   */
  translateError?: (error: AgentError, response: Response) => void;
};

/**
 * Runs `read` against the agent and relays its events to `response`.
 *
 * Resolves once the response is finished in every case it handles: normal
 * end, browser abort, agent failure before or after opening. Rethrows only
 * what is not an `AgentError` and happened before the stream opened — that
 * is a bug of the hub and belongs to the error handler, not to the stream.
 */
export async function relayAgentStream(
  request: Request,
  response: Response,
  options: AgentStreamRelayOptions,
  read: (relay: AgentStreamRelay) => Promise<void>
): Promise<void> {
  // The stream's lifetime hangs on the browser's connection. Both events are
  // bound: `close` on the request is what the routes used so far, `close` on
  // the response is the one Node guarantees for a client that went away,
  // also while a write waits on `drain`.
  const controller = new AbortController();
  const abort = (): void => {
    // A response that finished on its own is no abort; aborting it anyway
    // would only mark a normal end as one.
    if (!response.writableFinished) controller.abort();
  };
  request.on("close", abort);
  response.on("close", abort);
  // ⚠️ A browser that left while the route was still deciding (the log
  // route's plan asks the agent first) is gone before this function started:
  // both `close` events fired already, and the listeners above never hear
  // them. Without this check the agent stream opened unbound and held one of
  // its slots with no reader (#286, measured on `355779c`). The response, not
  // the request: a request whose body a parser consumed is destroyed while the
  // client is still there. Same check as `relayAgentBytes`.
  if (response.destroyed) abort();

  const writer = ndjsonWriter(response);
  try {
    await read({ signal: controller.signal, open: writer.begin, write: writer.write });
    writer.end();
  } catch (error) {
    if (writer.started() || response.headersSent) {
      // Too late for a status code. The failure is a line in the stream —
      // unless the browser left, then nobody is there to read it.
      if (!response.writableEnded) {
        if (!controller.signal.aborted) void writer.write(options.brokenEvent);
        response.end();
      }
      return;
    }
    if (controller.signal.aborted) {
      // The browser left before the agent answered. There is no one to send a
      // status to; ending the response releases it without one.
      if (!response.writableEnded) response.end();
      return;
    }
    if (!(error instanceof AgentError)) throw error;
    (options.translateError ?? translateAgentError)(error, response);
  } finally {
    request.off("close", abort);
    response.off("close", abort);
  }
}
