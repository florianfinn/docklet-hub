import { test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import net from "node:net";
import {
  describeLimits,
  createServer,
  maxConnectionsFrom,
  MAX_CONNECTIONS,
  MIN_CONNECTIONS,
  CONNECTION_LIMITS,
  softDescriptorLimit,
  type ConnectionLimits
} from "./connection-limits.js";

// The agent's deadlines are in seconds to minutes. A test that waits for them
// would not be a test but a pause — so the trials here prove the MECHANISM
// with milliseconds, and a separate test next to them proves that the real
// numbers are attached to the real server. Both together are the statement;
// either alone would be half of it.
const TINY: ConnectionLimits = {
  connectionsCheckingInterval: 20,
  headersTimeout: 80,
  requestTimeout: 250,
  keepAliveTimeout: 50,
  maxConnections: 64
};

// One server per trial, on a free port, and closed again at the end. `0`
// lets the operating system choose the port — parallel test files must not
// fight over a fixed number.
async function withServer(
  handler: http.RequestListener,
  limits: Partial<ConnectionLimits>,
  run: (port: number) => Promise<void>
): Promise<void> {
  const server = createServer(handler, { ...TINY, ...limits });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

// The server's setTimeout and the client's Date.now() are two clocks, each with
// its own resolution: the same stream can be measured as 499 instead of 500 ms
// (#46, run 33818575234). The lower bounds of the tests below subtract this
// margin. It still distinguishes between cut off and ran through: TINY sets
// requestTimeout to 250 ms, the survival tests wait 500 and 600 ms, and the
// header deadline is 80 ms against a measured duration of about 250 ms.
const TIMER_TOLERANCE_MS = 20;

// What happened from the caller's point of view: when the connection closed
// and what came in before that.
type Outcome = { end: string; afterMs: number; first: string; bytes: number };

function rawRequest(port: number, send: (socket: net.Socket) => void, patienceMs = 2_000): Promise<Outcome> {
  const startMs = Date.now();
  return new Promise((done) => {
    let response = "";
    let bytes = 0;
    const completion = (end: string) =>
      done({ end, afterMs: Date.now() - startMs, first: response.split("\r\n")[0], bytes });
    const socket = net.connect(port, "127.0.0.1", () => send(socket));
    socket.on("data", (part) => {
      bytes += part.length;
      if (response.length < 2_000) response += part.toString();
    });
    socket.on("close", () => completion("zu"));
    socket.on("error", (failure) => completion(`error:${(failure as NodeJS.ErrnoException).code}`));
    // The fallback turns a cap that is not honoured into a red test instead of
    // a hanging one.
    setTimeout(() => {
      socket.destroy();
      completion("test-gab-auf");
    }, patienceMs).unref();
  });
}

// --- The finding from R5: the half-sent header line -------------------------

test("a connection with an incomplete header is closed after the header deadline", async () => {
  await withServer(
    (request, response) => response.end("never reached"),
    {},
    async (port) => {
      // No terminating CRLF: so the header never ends, and without a deadline
      // this connection holds its descriptor until TCP gives up.
      const outcome = await rawRequest(port, (socket) =>
        socket.write("GET /health HTTP/1.1\r\nHost: agent\r\nx-halb: ja\r\n")
      );
      assert.equal(outcome.end, "zu", `connection stayed open: ${JSON.stringify(outcome)}`);
      assert.match(outcome.first, /^HTTP\/1\.1 408/);
      // Deadline plus one check interval plus slack for a slow machine.
      assert.ok(outcome.afterMs < 1_000, `closed too late: ${outcome.afterMs} ms`);
    }
  );
});

test("a body that never finishes ends with the request deadline", async () => {
  await withServer(
    (request, response) => {
      request.on("data", () => {});
      request.on("end", () => response.end("ok"));
    },
    {},
    async (port) => {
      // Complete header, 100 bytes announced, one is delivered.
      // This is the second half of the same finding: the header alone is not
      // enough if someone may stay silent afterwards.
      const outcome = await rawRequest(port, (socket) =>
        socket.write("POST /containers HTTP/1.1\r\nHost: agent\r\ncontent-length: 100\r\n\r\na")
      );
      assert.equal(outcome.end, "zu", `connection stayed open: ${JSON.stringify(outcome)}`);
      assert.match(outcome.first, /^HTTP\/1\.1 408/);
      assert.ok(outcome.afterMs < 1_000, `closed too late: ${outcome.afterMs} ms`);
      // And the header deadline did NOT strike: at 80 ms it was long over
      // while the body was still running.
      assert.ok(outcome.afterMs >= TINY.headersTimeout - TIMER_TOLERANCE_MS, `closed too early: ${outcome.afterMs} ms`);
    }
  );
});

// --- The other half: the long-lived paths stay untouched --------------------

test("a running stream outlives the request deadline many times over", async () => {
  const DURATION_MS = 600;
  await withServer(
    (request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      const tick = setInterval(() => response.write("{\"art\":\"line\"}\n"), 25);
      request.on("close", () => clearInterval(tick));
      setTimeout(() => {
        clearInterval(tick);
        response.end();
      }, DURATION_MS).unref();
    },
    {},
    async (port) => {
      const outcome = await rawRequest(port, (socket) =>
        // `connection: close` only so the test does not wait for the keep-alive
        // deadline before the socket closes — what is measured is the response duration.
        socket.write("GET /containers/abc/logs-stream HTTP/1.1\r\nHost: agent\r\nconnection: close\r\n\r\n")
      );
      // The stream ran more than twice as long as the request deadline — exactly
      // the property that kept R5 open.
      assert.equal(outcome.end, "zu");
      assert.match(outcome.first, /^HTTP\/1\.1 200/);
      assert.ok(outcome.afterMs >= DURATION_MS - TIMER_TOLERANCE_MS, `cut off too early: ${outcome.afterMs} ms`);
      assert.ok(outcome.bytes > 10 * "{\"art\":\"line\"}\n".length, `let too little through: ${outcome.bytes} B`);
    }
  );
});

test("a SILENT stream survives as well — it looks like idleness but is not", async () => {
  // The most dangerous case: a log stream that has nothing to report. Whoever
  // sets `server.timeout` cuts exactly this one off — that deadline measures
  // socket inactivity and cannot tell a quiet stream from a forgotten socket.
  const SILENCE_MS = 500;
  await withServer(
    (request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      setTimeout(() => response.end("{\"art\":\"end\"}\n"), SILENCE_MS).unref();
    },
    {},
    async (port) => {
      const outcome = await rawRequest(port, (socket) =>
        socket.write("GET /monitor-events HTTP/1.1\r\nHost: agent\r\nconnection: close\r\n\r\n")
      );
      assert.equal(outcome.end, "zu");
      assert.match(outcome.first, /^HTTP\/1\.1 200/);
      assert.ok(outcome.afterMs >= SILENCE_MS - TIMER_TOLERANCE_MS, `cut off too early: ${outcome.afterMs} ms`);
    }
  );
});

test("a stream AFTER a body was read keeps running too", async () => {
  // The construction of `exec` and `pull-stream`: first read a JSON body, then
  // send for minutes. If the request deadline reached into the response
  // anywhere, then here — the clock of this deadline runs from the first byte
  // of the REQUEST, not from the end of the body.
  const DURATION_MS = 600;
  await withServer(
    (request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        const tick = setInterval(() => response.write("{\"art\":\"aus\"}\n"), 25);
        setTimeout(() => {
          clearInterval(tick);
          response.end();
        }, DURATION_MS).unref();
      });
    },
    {},
    async (port) => {
      const body = JSON.stringify({ cols: 80, rows: 24 });
      const outcome = await rawRequest(port, (socket) =>
        socket.write(
          "POST /containers/abc/exec HTTP/1.1\r\nHost: agent\r\nconnection: close\r\n" +
            `content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`
        )
      );
      assert.match(outcome.first, /^HTTP\/1\.1 200/);
      assert.ok(outcome.afterMs >= DURATION_MS - TIMER_TOLERANCE_MS, `cut off too early: ${outcome.afterMs} ms`);
    }
  );
});

test("createServer leaves server.timeout off", () => {
  // The one line that would cut off all long-lived paths at once.
  const server = createServer((request, response) => response.end());
  assert.equal(server.timeout, 0);
  server.close();
});

// --- The cap on simultaneous connections ------------------------------------

test("maxConnections rejects the excess connection instead of holding it", async () => {
  // The admitted responses stay open until both excess connections have ended.
  // A cap that queued instead of rejecting could never end them first, however
  // slow the machine; the fallback only bounds the test's duration.
  const held: http.ServerResponse[] = [];
  const events: string[] = [];
  let released = false;
  const release = (cause: string) => {
    if (released) return;
    released = true;
    events.push(`released:${cause}`);
    for (const response of held) response.end("ok");
  };
  const fallback = setTimeout(() => release("fallback"), 1_500);
  fallback.unref();
  let rejectedSoFar = 0;
  await withServer(
    (request, response) => {
      if (released) response.end("ok");
      else held.push(response);
    },
    { maxConnections: 2, requestTimeout: 2_000, headersTimeout: 2_000 },
    async (port) => {
      const outcomes = await Promise.all(
        [0, 1, 2, 3].map(() =>
          rawRequest(port, (socket) =>
            socket.write("GET /health HTTP/1.1\r\nHost: agent\r\nconnection: close\r\n\r\n")
          ).then((outcome) => {
            if (!outcome.first.startsWith("HTTP/1.1 200")) {
              events.push("rejected");
              rejectedSoFar += 1;
              if (rejectedSoFar === 2) release("rejections");
            }
            return outcome;
          })
        )
      );
      clearTimeout(fallback);
      const served = outcomes.filter((outcome) => outcome.first.startsWith("HTTP/1.1 200")).length;
      assert.equal(served, 2, `served=${served}: ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes.length - served, 2);
      // Rejected while both slots were still occupied, not held in an
      // invisible queue — the same promise as with the stream cap from R3.
      assert.deepEqual(events, ["rejected", "rejected", "released:rejections"], JSON.stringify(outcomes));
    }
  );
});

// --- The connection cap comes from the descriptor budget --------------------

test("maxConnectionsFrom divides the descriptor budget instead of guessing a number", () => {
  // (1024 - 128 reserve) / 2 descriptors per connection = 448.
  assert.equal(maxConnectionsFrom(1024), 448);
  assert.equal(maxConnectionsFrom(512), 192);
});

test("maxConnectionsFrom stays between lower and upper bound", () => {
  // A generous budget does not turn the agent into a load balancer.
  assert.equal(maxConnectionsFrom(1_048_576), MAX_CONNECTIONS);
  // And a tight budget does not let it drop below its own stream caps:
  // 8 reading + 4 monitor + 4 exec are 16 long-lived paths.
  assert.equal(maxConnectionsFrom(140), MIN_CONNECTIONS);
  assert.equal(maxConnectionsFrom(1), MIN_CONNECTIONS);
});

test("an unreadable budget yields the upper bound, not a lockout", () => {
  // The fallback must not point in the tight direction: a cap that is too small
  // narrows the only path to the socket without needing an attacker.
  assert.equal(maxConnectionsFrom(null), MAX_CONNECTIONS);
});

test("softDescriptorLimit reads the soft limit from the diagnostic report", () => {
  assert.equal(softDescriptorLimit(() => ({ userLimits: { open_files: { soft: 4096, hard: 8192 } } })), 4096);
});

test("softDescriptorLimit reports null where there is no number", () => {
  // "unlimited" is a STRING in the report, not a number — and a developer
  // machine does not have the section at all.
  assert.equal(softDescriptorLimit(() => ({ userLimits: { open_files: { soft: "unlimited" } } })), null);
  assert.equal(softDescriptorLimit(() => ({})), null);
  assert.equal(softDescriptorLimit(() => null), null);
  assert.equal(
    softDescriptorLimit(() => {
      throw new Error("no report");
    }),
    null
  );
});

// --- The production values themselves ---------------------------------------

test("the production values are attached to the server, not only in the constant", () => {
  const server = createServer((request, response) => response.end());
  assert.equal(server.headersTimeout, CONNECTION_LIMITS.headersTimeout);
  assert.equal(server.requestTimeout, CONNECTION_LIMITS.requestTimeout);
  assert.equal(server.keepAliveTimeout, CONNECTION_LIMITS.keepAliveTimeout);
  assert.equal(server.maxConnections, CONNECTION_LIMITS.maxConnections);
  server.close();
});

test("the production values are consistent with each other", () => {
  // Node throws on creation if the first condition does not hold — that should
  // show up here and not when the agent starts on the target host.
  assert.ok(CONNECTION_LIMITS.headersTimeout <= CONNECTION_LIMITS.requestTimeout);
  // A deadline that is checked less often than it is long is no deadline.
  assert.ok(CONNECTION_LIMITS.connectionsCheckingInterval < CONNECTION_LIMITS.headersTimeout);
  // The connection cap must carry the agent's own stream caps (8 + 4 + 4).
  assert.ok(CONNECTION_LIMITS.maxConnections >= MIN_CONNECTIONS);
  // None of the three deadlines may accidentally end up at 0 ("off").
  assert.ok(CONNECTION_LIMITS.headersTimeout > 0);
  assert.ok(CONNECTION_LIMITS.requestTimeout > 0);
  assert.ok(CONNECTION_LIMITS.keepAliveTimeout > 0);
});

test("describeLimits names every number that should appear in the startup log", () => {
  const line = describeLimits({
    connectionsCheckingInterval: 5_000,
    headersTimeout: 15_000,
    requestTimeout: 300_000,
    keepAliveTimeout: 5_000,
    maxConnections: 448
  });
  assert.equal(line, "headers 15s, request 300s, keep-alive 5s, max connections 448");
});
