import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { relayAgentBytes } from "./agent-bytes-relay.js";
import { relayAgentStream } from "./agent-stream-relay.js";

// Stay below the hub's 3,000 ms monitor-events setup deadline.
const HEADER_TIMEOUT_MS = 2_000;
const TEST_TIMEOUT_MS = 5_000;

for (const kind of ["bytes", "ndjson"] as const) {
  test(`${kind} relay sends HTTP 200 headers within 2,000 ms without an agent body chunk`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const app = express();
    const tasks: Promise<void>[] = [];
    let closed = false;
    app.get("/stream", (request, response) => {
      if (kind === "bytes") {
        tasks.push(relayAgentBytes(response, { headers: { "content-type": "application/octet-stream" } }, async (signal) => {
          signal.addEventListener("abort", () => { closed = true; }, { once: true });
          // Wake the pending read when the synthetic browser disconnects.
          const stream = new ReadableStream<Uint8Array>({ start: (controller) => {
            signal.addEventListener("abort", () => controller.close(), { once: true });
          } });
          return { size: 1, stream };
        }));
      } else {
        tasks.push(relayAgentStream(request, response, { brokenEvent: { kind: "error" } }, async (relay) => {
          relay.open();
          await new Promise<void>((resolve) => relay.signal.addEventListener("abort", () => {
            closed = true;
            resolve();
          }, { once: true }));
        }));
      }
    });
    const server = http.createServer(app);
    // Loopback and an ephemeral port isolate the synthetic HTTP transport.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/stream`, { signal: controller.signal });
      clearTimeout(timer);
      try {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), kind === "bytes" ? "application/octet-stream" : "application/x-ndjson; charset=utf-8");
        if (kind === "bytes") assert.equal(response.headers.get("content-length"), "1");
      } finally {
        await response.body?.cancel();
      }
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(tasks);
    }
    assert.equal(closed, true);
  });
}
