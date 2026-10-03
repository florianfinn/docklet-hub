import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { readNdjson } from "contract";
import type { Request, Response } from "express";

import { AgentError } from "../agent-transport/protocol.js";
import { listenOnFetchablePort } from "../testing/port-test-support.js";
import { relayAgentStream, type AgentStreamRelay } from "./agent-stream-relay.js";

// WHAT THIS FILE CHECKS (#253)
//
// The agent side is a stand-in: a Web `ReadableStream` the test feeds by
// hand, read by the real `readNdjson` — the same reader `streamLogs` uses.
// Its `cancel` callback is the measurement for "the agent stream was ended".
//
//   1. Browser abort with a full output buffer ends the agent stream, and the
//      relay's promise settles (no hanging promise).
//   2. Agent abort after the first line writes the hub's failure line and
//      ends the response.
//   3. A failure before the first line is an HTTP status, not a failure line
//      — and the agent's `429` stays `too-many-streams`.
//   4. A browser abort writes no line of its own.

const BROKEN = { kind: "error", reason: "agent-stream-broken" };

type FakeResponse = EventEmitter & {
  written: string[];
  /** What `response.write` returns next. */
  accepts: boolean;
  statusCode: number;
  jsonBody: unknown;
  headersSent: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
};

/**
 * Behaves like an Express response as far as the relay uses one. An
 * `EventEmitter`, so that `once`/`off` are the real ones and listener counts
 * measure the relay, not the fake.
 */
function fakeResponse(): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.written = [];
  response.accepts = true;
  response.statusCode = 0;
  response.jsonBody = undefined;
  response.headersSent = false;
  response.writableEnded = false;
  response.writableFinished = false;
  Object.assign(response, {
    status: (code: number) => {
      response.statusCode = code;
      return response;
    },
    setHeader: () => response,
    flushHeaders: () => {
      response.headersSent = true;
    },
    json: (body: unknown) => {
      response.headersSent = true;
      response.jsonBody = body;
      response.writableEnded = true;
      return response;
    },
    write: (chunk: string): boolean => {
      response.written.push(chunk);
      return response.accepts;
    },
    end: () => {
      response.writableEnded = true;
      return response;
    }
  });
  return response;
}

/** The agent stream stand-in, with a record of whether it was cancelled. */
function agentSide(): {
  body: ReadableStream<Uint8Array>;
  push: (line: unknown) => void;
  fail: (error: Error) => void;
  close: () => void;
  cancelled: () => boolean;
} {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      source = controller;
    },
    cancel: () => {
      cancelled = true;
    }
  });
  const encoder = new TextEncoder();
  return {
    body,
    push: (line) => source.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)),
    fail: (error) => source.error(error),
    close: () => source.close(),
    cancelled: () => cancelled
  };
}

/** A reader shaped like `streamLogs`: open, then relay every record. */
function relayingReader(body: ReadableStream<Uint8Array>) {
  return async ({ signal, open, write }: AgentStreamRelay): Promise<void> => {
    open();
    await readNdjson(body, { signal }, (record) => write(record));
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function run(
  request: EventEmitter,
  response: FakeResponse,
  read: (relay: AgentStreamRelay) => Promise<void>
): Promise<void> {
  return relayAgentStream(request as unknown as Request, response as unknown as Response, { brokenEvent: BROKEN }, read);
}

/** Resolves to `"settled"` or, if the promise still hangs, to `"hanging"`. */
async function settledWithin(promise: Promise<void>, ticks = 20): Promise<"settled" | "hanging"> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let index = 0; index < ticks && !settled; index++) await tick();
  return settled ? "settled" : "hanging";
}

const lines = (response: FakeResponse): unknown[] => response.written.map((chunk) => JSON.parse(chunk));

// ── 1. Browser abort with a full buffer ──────────────────────────────────────

test("bricht der Browser bei vollem Puffer ab, endet der Agent-Strom und nichts hängt", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();
  const agent = agentSide();
  response.accepts = false;

  const relayed = run(request, response, relayingReader(agent.body));
  agent.push({ kind: "line", text: "erste" });
  await tick();
  assert.equal(await settledWithin(relayed, 5), "hanging", "the case does not check a full buffer");
  assert.equal(agent.cancelled(), false);

  // A closed connection never sends `drain` again.
  response.emit("close");
  request.emit("close");

  assert.equal(await settledWithin(relayed), "settled", "the relay kept waiting after the browser left");
  assert.equal(agent.cancelled(), true, "the agent stream was not ended — it would hold one of the eight slots");
  assert.deepEqual(lines(response), [{ kind: "line", text: "erste" }], "a browser abort writes no line of its own");
  assert.equal(response.listenerCount("close"), 0, "listeners on close were left behind");
  assert.equal(response.listenerCount("drain"), 0, "listeners on drain were left behind");
  assert.equal(request.listenerCount("close"), 0, "listeners on the request were left behind");
});

// ── 2. Agent abort after the first line ──────────────────────────────────────

test("bricht der Agent nach der ersten Zeile ab, schreibt der Hub eine Fehlerzeile und schließt", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();
  const agent = agentSide();

  const relayed = run(request, response, relayingReader(agent.body));
  agent.push({ kind: "line", text: "erste" });
  await tick();
  agent.fail(new TypeError("terminated"));

  assert.equal(await settledWithin(relayed), "settled");
  assert.equal(response.statusCode, 200, "the status was out with the first line and must not change");
  assert.deepEqual(lines(response), [{ kind: "line", text: "erste" }, BROKEN]);
  assert.equal(response.writableEnded, true, "the response stayed open after the agent broke");
});

// ── 3. Failure before the first line ─────────────────────────────────────────

test("ein Fehler vor der ersten Zeile ergibt einen HTTP-Status statt einer Fehlerzeile", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();

  await run(request, response, async () => {
    throw new AgentError("too many streams", 429);
  });

  assert.equal(response.statusCode, 429);
  assert.equal((response.jsonBody as { error: string }).error, "too-many-streams");
  assert.deepEqual(response.written, [], "a failure before the stream opened was written as a line");
});

test("eine eigene Übersetzung ersetzt die allgemeine für einen Fehler vor der ersten Zeile (#260)", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();

  await relayAgentStream(
    request as unknown as Request,
    response as unknown as Response,
    {
      brokenEvent: BROKEN,
      translateError: (error, target) => {
        target.status(418).json({ error: "own-table", message: error.message });
      }
    },
    async () => {
      throw new AgentError("too many streams", 429);
    }
  );

  assert.equal(response.statusCode, 418, "the general table answered although the surface passed its own");
  assert.equal((response.jsonBody as { error: string }).error, "own-table");
});

test("ein Fehler vor dem Öffnen, der kein Agentenfehler ist, geht an die Fehlerbehandlung", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();

  await assert.rejects(
    run(request, response, async () => {
      throw new RangeError("bug in the hub");
    }),
    RangeError
  );
  assert.deepEqual(response.written, []);
});

// ── 4. Normal end ────────────────────────────────────────────────────────────

test("endet der Agent-Strom von selbst, endet die Antwort ohne eigene Fehlerzeile", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();
  const agent = agentSide();

  const relayed = run(request, response, relayingReader(agent.body));
  agent.push({ kind: "start", containerName: "web", tty: false });
  // The agent's own failure line is relayed verbatim; the hub adds none.
  agent.push({ kind: "error", reason: "container-gone" });
  agent.close();

  assert.equal(await settledWithin(relayed), "settled");
  assert.deepEqual(lines(response), [
    { kind: "start", containerName: "web", tty: false },
    { kind: "error", reason: "container-gone" }
  ]);
  assert.equal(response.writableEnded, true);
});

// ── 5. Browser abort before the agent answered ───────────────────────────────

test("bricht der Browser ab, bevor der Agent antwortet, endet die Antwort ohne Status und ohne Wurf", async () => {
  const request = new EventEmitter();
  const response = fakeResponse();

  const relayed = run(request, response, ({ signal }) => {
    // Stands in for `agentStream`, whose `fetch` rejects once the signal fires.
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
  request.emit("close");

  assert.equal(await settledWithin(relayed), "settled");
  await relayed;
  assert.equal(response.statusCode, 0, "a status was sent to a browser that had left");
  assert.deepEqual(response.written, []);
  assert.equal(response.writableEnded, true);
});

// ── 5. Browser gone before the relay started (#286) ─────────────────────────
//
// Over real HTTP, because the fakes above cannot show it: the question is
// what Node reports for a connection that closed while the route was still
// deciding. The log route asks the agent for its plan first; a browser that
// left in that time fired both `close` events before `relayAgentStream`
// bound its listeners. Measured on `355779c` with the same probe: the response
// was already destroyed, and the reader started with a signal that was not
// aborted, so the agent stream opened without a reader.

test("ist der Browser schon vor dem Relay gegangen, startet der Leser mit abgebrochenem Signal", async (t) => {
  let releaseRoute!: () => void;
  const routeMayContinue = new Promise<void>((resolve) => (releaseRoute = resolve));
  let responseClosed!: () => void;
  const browserGone = new Promise<void>((resolve) => (responseClosed = resolve));
  let seen: { destroyed: boolean; aborted: boolean } | null = null;
  let relayDone!: () => void;
  const relayed = new Promise<void>((resolve) => (relayDone = resolve));

  const server = http.createServer((request, response) => {
    response.once("close", responseClosed);
    void (async () => {
      // Stands in for the plan: the route waits before it reaches the relay.
      await routeMayContinue;
      await relayAgentStream(
        request as unknown as Request,
        response as unknown as Response,
        { brokenEvent: BROKEN },
        async ({ signal }) => {
          seen = { destroyed: response.destroyed, aborted: signal.aborted };
        }
      );
      relayDone();
    })();
  });
  const port = await listenOnFetchablePort(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const client = http.get({ host: "127.0.0.1", port, path: "/logs" });
  client.on("error", () => {
    // The client tears its own request down; that error is the point.
  });
  // The request reaches the server, then the browser leaves.
  await new Promise<void>((resolve) => server.once("request", () => resolve()));
  client.destroy();
  await browserGone;
  releaseRoute();
  await relayed;

  assert.ok(seen !== null, "the reader never ran");
  const observed = seen as { destroyed: boolean; aborted: boolean };
  assert.equal(observed.destroyed, true, "precondition: the response was gone before the relay");
  assert.equal(observed.aborted, true, "the reader started with a live signal for a browser that had left");
});
