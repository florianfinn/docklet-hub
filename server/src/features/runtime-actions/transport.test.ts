import assert from "node:assert/strict";
import { createServer, globalAgent, type ClientRequestArgs, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { LookupFunction, Socket } from "node:net";
import type { Duplex } from "node:stream";
import test from "node:test";

import { AgentError } from "../../platform/agent-transport/protocol.js";
import { streamFetch, StreamFetchError } from "../../platform/agent-transport/stream-fetch.js";
import { listenOnFetchablePort } from "../../platform/testing/port-test-support.js";
import { selfSignedTlsCredentials } from "../../platform/testing/self-signed-tls.js";
import { runContainer, runStack } from "./agent-client.js";
import { runtimeRejection } from "./rejections.js";

const actor = { kind: "user" as const, id: "demo-human" };
const tlsCredentials = selfSignedTlsCredentials();

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("real streamFetch does not count buffered bytes during an aborted lookup as sent", async (t) => {
  const controller = new AbortController();
  let finishLookup!: Parameters<LookupFunction>[2];
  const lookup: LookupFunction = (_hostname, _options, callback) => { finishLookup = callback; };
  const createConnection = globalAgent.createConnection;
  let socket!: Socket;
  t.mock.method(globalAgent, "createConnection", (options: ClientRequestArgs,
    callback?: Parameters<typeof globalAgent.createConnection>[1]) => {
    socket = createConnection.call(globalAgent, { ...options, lookup }, callback) as Socket;
    return socket;
  });
  const pending = streamFetch("http://agent.invalid/action", {
    method: "POST", body: "{}", signal: controller.signal
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(socket.connecting, true);
  assert.equal(socket.bytesWritten > 0, true, "the request must already be buffered");
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof StreamFetchError, true);
    assert.equal((error as StreamFetchError).requestSent, false);
    return true;
  });
  finishLookup(Object.assign(new Error("synthetic lookup failure"), { code: "ENOTFOUND" }), "");
});

// Loopback listeners and an injected lookup exercise HTTP/TLS without external services or DNS.
for (const scope of ["container", "stack"] as const) {
  function run(baseUrl: string) {
    const target = { baseUrl, secret: "synthetic" };
    if (scope === "container") return runContainer(target, "demo", "start", {}, { actor });
    return runStack(target, "demo", "start", {}, { actor }, {
      signal: new AbortController().signal, open: () => undefined, write: async () => undefined
    });
  }

  function rejection(key: "runtime-agent-unreachable" | "runtime-outcome-unknown") {
    return (error: unknown) => {
      assert.equal(error instanceof AgentError, true);
      assert.deepEqual(runtimeRejection(error as AgentError, scope === "stack"), {
        status: 502, body: { error: key }
      });
      return true;
    };
  }

  test(`${scope}: real streamFetch reports a closed port as runtime-agent-unreachable`, async () => {
    const listener = createServer();
    const port = await listenOnFetchablePort(listener);
    await close(listener);
    await assert.rejects(run(`http://127.0.0.1:${port}`), rejection("runtime-agent-unreachable"));
  });

  test(`${scope}: a self-signed TLS handshake failure is runtime-agent-unreachable`, { timeout: 5000 }, async (t) => {
    let actions = 0;
    let connections = 0;
    const sockets = new Set<Duplex>();
    const listener = createTlsServer(tlsCredentials, (_request, response) => { actions++; response.end("unexpected"); });
    listener.on("connection", (socket) => {
      connections++;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      return close(listener);
    });
    const port = await listenOnFetchablePort(listener);
    const baseUrl = `https://127.0.0.1:${port}`;
    await assert.rejects(run(baseUrl), rejection("runtime-agent-unreachable"));
    await assert.rejects(streamFetch(`${baseUrl}/action`, { method: "POST", body: "{}" }), (error: unknown) => {
      assert.ok(error instanceof StreamFetchError);
      assert.equal((error.cause as NodeJS.ErrnoException).code, "DEPTH_ZERO_SELF_SIGNED_CERT");
      assert.equal(error.requestSent, false);
      return true;
    });
    assert.equal(connections, 2, "each call must attempt the handshake exactly once");
    assert.equal(actions, 0, "no HTTP action may reach the TLS listener");
  });

  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]) {
    test(`${scope}: real streamFetch reports ${code} before connect as runtime-agent-unreachable`, async (t) => {
      let lookups = 0;
      const lookup: LookupFunction = (hostname, _options, callback) => {
        assert.equal(hostname, "agent.invalid");
        lookups++;
        // Let node:http buffer the request before failing connection establishment.
        setImmediate(() => callback(Object.assign(new Error("synthetic lookup failure"), { code }), ""));
      };
      const createConnection = globalAgent.createConnection;
      t.mock.method(globalAgent, "createConnection", (options: ClientRequestArgs,
        callback?: Parameters<typeof globalAgent.createConnection>[1]) =>
        createConnection.call(globalAgent, { ...options, lookup }, callback));
      await assert.rejects(run("http://agent.invalid"), rejection("runtime-agent-unreachable"));
      assert.equal(lookups, 1, "a failed action must not be retried");
    });
  }

  for (const reuse of [false, true]) {
    test(`${scope}: real streamFetch reports a disconnect after sending on a ${reuse ? "reused" : "new"} socket as unknown`, async (t) => {
      let warmSocket: Socket | undefined;
      let connections = 0;
      let actions = 0;
      const listener = createServer((request, response) => {
        if (request.url === "/warm") {
          warmSocket = request.socket;
          response.end("ready");
          return;
        }
        actions++;
        if (reuse) assert.equal(request.socket === warmSocket, true);
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          assert.equal(request.method, "POST");
          assert.equal(body, "{}");
          response.destroy();
        });
      });
      listener.on("connection", () => { connections++; });
      const port = await listenOnFetchablePort(listener);
      t.after(() => close(listener));
      const baseUrl = `http://127.0.0.1:${port}`;
      if (reuse) {
        const warm = await streamFetch(`${baseUrl}/warm`);
        assert.equal(await warm.text(), "ready");
      }
      await assert.rejects(run(baseUrl), rejection("runtime-outcome-unknown"));
      assert.equal(actions, 1, "a sent action must not be retried");
      assert.equal(connections, 1);
    });
  }
}
