import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { Response } from "express";

import { AgentError } from "../agent-transport/protocol.js";
import { relayAgentBytes, type AgentBytes } from "./agent-bytes-relay.js";

// WHAT THIS FILE CHECKS (#262)
//
// The agent side is a Web `ReadableStream` the test feeds by hand; its
// `cancel` callback is the measurement for "the agent stream was ended". The
// response is a real `Writable` (a `PassThrough` with a tiny buffer), so
// `write` returns `false` and `drain`, `close` and `destroyed` behave as in
// Node and not as a fake promises them.
//
//   1. Chunks arrive in order, with the headers and the length the agent named.
//   2. With a full output buffer the relay waits: the agent stream is not read
//      ahead of the browser.
//   3. The browser leaving under a full buffer ends the agent stream, aborts
//      the signal and settles the relay's promise (no hanging promise).
//   4. A failure before the status is a status; after it the response is cut,
//      never ended cleanly.

type FakeResponse = PassThrough & {
  statusCode: number;
  sentHeaders: Record<string, string>;
  status: (code: number) => FakeResponse;
  setHeader: (name: string, value: string) => FakeResponse;
  flushHeaders: () => void;
};

function fakeResponse(highWaterMark = 1): FakeResponse {
  const response = new PassThrough({ highWaterMark }) as FakeResponse;
  response.statusCode = 0;
  response.sentHeaders = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.setHeader = (name, value) => {
    response.sentHeaders[name] = value;
    return response;
  };
  response.flushHeaders = () => {};
  return response;
}

const asResponse = (response: FakeResponse): Response => response as unknown as Response;

/** The agent stream stand-in; `pulled` counts the chunks the relay asked for. */
function agentSide(chunks: number, size = 2): { bytes: AgentBytes; state: { pulled: number; cancelled: boolean } } {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(state.pulled));
    },
    cancel() {
      state.cancelled = true;
    }
  });
  return { bytes: { size: chunks * size, stream }, state };
}

async function collect(response: PassThrough): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of response) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

const HEADERS = { "content-type": "application/octet-stream" };

/** Settles within `ms` or fails the test with `what`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(what)), ms);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("die Blöcke kommen der Reihe nach an, mit Kopfzeilen und der Länge des Agenten", async () => {
  const response = fakeResponse();
  const { bytes } = agentSide(3);
  const received = collect(response);

  await relayAgentBytes(asResponse(response), { headers: HEADERS }, async () => bytes);

  assert.deepEqual([...(await received)], [1, 1, 2, 2, 3, 3]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.sentHeaders["content-type"], "application/octet-stream");
  assert.equal(response.sentHeaders["content-length"], "6");
});

test("ohne genannte Länge steht keine Länge in der Antwort", async () => {
  const response = fakeResponse();
  const { bytes } = agentSide(1);
  const received = collect(response);

  await relayAgentBytes(asResponse(response), { headers: HEADERS }, async () => ({ ...bytes, size: null }));

  await received;
  assert.equal("content-length" in response.sentHeaders, false);
});

test("bei vollem Ausgabepuffer liest das Relay den Agenten nicht voraus", async () => {
  const response = fakeResponse();
  const { bytes, state } = agentSide(50);
  const relaying = relayAgentBytes(asResponse(response), { headers: HEADERS }, async () => bytes);

  await new Promise((resolve) => setTimeout(resolve, 50));
  // Nobody reads the response: the buffer is full after the first chunks, and
  // the relay stands at `drain`. A relay that ignored `write`'s answer would
  // have pulled all 50 by now (the stream's own queue adds one or two).
  assert.ok(response.writableLength > 0, "der Test muss den Ausgabepuffer füllen");
  assert.ok(state.pulled < 10, `der Agent wurde ${state.pulled} Mal gelesen, obwohl der Browser nichts nimmt`);

  const received = collect(response);
  await within(relaying, 1000, "das Relay endet nicht, obwohl der Browser jetzt liest");
  assert.equal((await received).length, 100);
  assert.equal(state.pulled, 50);
});

test("ein Abbruch unter vollem Puffer beendet den Agentenstrom und das Relay", async () => {
  const response = fakeResponse();
  const { bytes, state } = agentSide(50);
  let signal: AbortSignal | undefined;
  const relaying = relayAgentBytes(asResponse(response), { headers: HEADERS }, async (given) => {
    signal = given;
    return bytes;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(response.writableLength > 0, "der Test muss den Ausgabepuffer füllen");
  // The browser leaves while the relay waits for `drain`.
  response.destroy();

  await within(relaying, 500, "das Warten auf drain hängt nach dem Abbruch");
  assert.equal(signal?.aborted, true, "das Signal an den Agenten wurde nicht abgebrochen");
  assert.equal(state.cancelled, true, "der Agentenstrom wurde nicht freigegeben");
  assert.ok(state.pulled < 50, "nach dem Abbruch wurde weitergelesen");
});

test("ein Browser, der vor dem Start schon weg ist, bekommt keinen Status und keinen Agentenstrom", async () => {
  const response = fakeResponse();
  response.destroy();
  let signal: AbortSignal | undefined;
  const { bytes, state } = agentSide(3);

  await relayAgentBytes(asResponse(response), { headers: HEADERS }, async (given) => {
    signal = given;
    return bytes;
  });

  assert.equal(signal?.aborted, true);
  assert.equal(response.statusCode, 0, "an eine geschlossene Verbindung wurde ein Status vergeben");
  assert.equal(state.cancelled, true, "der Agentenstrom blieb offen");
});

test("ein Fehler des Agenten vor dem Status wird übersetzt, mit dem 429 als too-many-streams", async () => {
  const response = fakeResponse();
  const answers: { status: number; body: unknown }[] = [];
  Object.assign(response, {
    json: (body: unknown) => {
      answers.push({ status: response.statusCode, body });
      return response;
    }
  });

  await relayAgentBytes(asResponse(response), { headers: HEADERS }, async () => {
    throw new AgentError("zu viele Ströme", 429);
  });

  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.status, 429);
  assert.equal((answers[0]?.body as { error: string }).error, "too-many-streams");
  assert.equal("content-type" in response.sentHeaders, false, "vor dem Status wurden Kopfzeilen gesetzt");
});

test("was kein Fehler des Agenten ist, geht an den Fehlerbehandler", async () => {
  const response = fakeResponse();
  await assert.rejects(
    relayAgentBytes(asResponse(response), { headers: HEADERS }, async () => {
      throw new TypeError("ein Fehler des Hubs");
    }),
    TypeError
  );
});

test("bricht der Agent nach dem Status ab, wird die Antwort gekappt und nicht sauber beendet", async () => {
  const response = fakeResponse();
  const closed = new Promise<void>((resolve) => response.once("close", resolve));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === 0) {
        sent += 1;
        controller.enqueue(new Uint8Array(2));
        return;
      }
      controller.error(new AgentError("Verbindung zum Arm abgerissen"));
    }
  });
  response.resume();

  await relayAgentBytes(asResponse(response), { headers: HEADERS }, async () => ({ size: 100, stream }));

  await within(closed, 500, "die Antwort wurde nicht geschlossen");
  assert.equal(response.destroyed, true);
  assert.equal(response.writableFinished, false, "eine halbe Datei wurde als ganze beendet");
});
