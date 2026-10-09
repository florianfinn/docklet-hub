import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { sendNotification, type NotificationMessage, type NotificationRuntimeConfig } from "./index.js";
import { MAX_RESPONSE_BYTES, TRUNCATION_MARKER } from "./http.js";

const message: NotificationMessage = { title: "Example incident", requiredText: "target\ncause\ntime\naction",
  optionalText: 'optional "text"\n@everyone <@123> **bold**', idempotencyKey: "episode:example-1" };
// Loopback sockets are isolated synthetic services; no operator endpoint is accessed.
async function fixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handler(request, response, body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => { server.closeAllConnections(); server.close(); await once(server, "close"); });
  return `http://127.0.0.1:${address.port}`;
}
function configs(endpoint: string): NotificationRuntimeConfig[] {
  return [{ kind: "discord", endpoint }, { kind: "gotify", endpoint, token: "synthetic-token" },
    { kind: "webhook", endpoint, authorization: "Bearer synthetic-token" }];
}
const signal = () => new AbortController().signal;

test("all HTTP adapters encode their protocol, private destinations and only their own headers", async (t) => {
  const captures: { path: string; headers: IncomingMessage["headers"]; payload: Record<string, unknown> }[] = [];
  const endpoint = await fixture(t, (request, response, body) => {
    captures.push({ path: request.url!, headers: request.headers, payload: JSON.parse(body) });
    response.end(request.url!.includes("wait=") ? '{"id":"123"}' : '{"id":1}');
  });
  for (const config of configs(`${endpoint}/custom`)) {
    assert.deepEqual(await sendNotification(config, message, signal()), { status: "delivered" });
  }
  assert.equal(captures[0].path, "/custom?wait=true");
  assert.deepEqual(captures[0].payload.allowed_mentions, { parse: [] });
  assert.ok(String(captures[0].payload.content).includes("\\*\\*bold\\*\\*"));
  assert.ok(String(captures[0].payload.content).includes("\\<@123\\>"));
  assert.equal(captures[1].path, "/custom/message");
  assert.equal(captures[1].headers["x-gotify-key"], "synthetic-token");
  assert.deepEqual(captures[1].payload, { title: message.title, message: `${message.requiredText}\n${message.optionalText}`, priority: 5 });
  assert.equal(captures[2].headers.authorization, "Bearer synthetic-token");
  assert.equal(captures[2].headers["idempotency-key"], message.idempotencyKey);
  assert.deepEqual(captures[2].payload, { title: message.title, text: `${message.requiredText}\n${message.optionalText}`, idempotencyKey: message.idempotencyKey });
  for (const capture of captures) {
    assert.equal(capture.headers["x-agent-token"], undefined);
    assert.equal(capture.headers["x-agent-contract-version"], undefined);
    assert.equal(capture.headers["content-type"], "application/json");
  }
  assert.equal(captures[0].headers.authorization, undefined);
  assert.equal(captures[2].headers["x-gotify-key"], undefined);
});

test("Discord chooses its own endpoint, forces wait and preserves essentials under its 2000 cap", async (t) => {
  const paths: string[] = [];
  let content = "";
  const endpoint = await fixture(t, (request, response, body) => {
    paths.push(request.url!); content = JSON.parse(body).content; response.end('{"id":"234"}');
  });
  const expanded = { ...message, optionalText: "*".repeat(4000) };
  assert.deepEqual(await sendNotification({ kind: "discord", endpoint: `${endpoint}/other-channel?wait=false` }, expanded, signal()), { status: "delivered" });
  assert.deepEqual(paths, ["/other-channel?wait=true"]);
  assert.ok(content.length <= 2000);
  assert.ok(content.includes(message.requiredText));
  assert.ok(content.endsWith(TRUNCATION_MARKER));
  assert.deepEqual(await sendNotification({ kind: "discord", endpoint }, { ...message, requiredText: "*".repeat(1500) }, signal()),
    { status: "failed", failure: "validation" });
  assert.equal(paths.length, 1);
});

test("all HTTP adapters classify non-2xx with secret-free fixed outcomes", async (t) => {
  let status = 500;
  const endpoint = await fixture(t, (_request, response) => { response.writeHead(status); response.end("synthetic-token private details"); });
  for (const config of configs(endpoint)) {
    for (const [code, failure] of [[408, "timeout"], [429, "transient"], [500, "transient"], [503, "transient"],
      [401, "authentication"], [403, "authentication"], [400, "validation"], [413, "validation"], [422, "validation"], [404, "destination-rejected"]] as const) {
      status = code;
      assert.deepEqual(await sendNotification(config, message, signal()), { status: "failed", failure });
    }
  }
});

test("all HTTP adapters reject redirects without forwarding secrets", async (t) => {
  let forwarded = 0;
  const destination = await fixture(t, (_request, response) => { forwarded++; response.end(); });
  const endpoint = await fixture(t, (_request, response) => { response.writeHead(307, { Location: destination }); response.end(); });
  for (const config of configs(endpoint)) {
    assert.deepEqual(await sendNotification(config, message, signal()), { status: "failed", failure: "destination-rejected" });
  }
  assert.equal(forwarded, 0);
});

test("all HTTP adapters bound response bytes, reject false acknowledgements and observe abrupt closes", async (t) => {
  let mode = "large";
  const endpoint = await fixture(t, (_request, response) => {
    if (mode === "close") { response.writeHead(200); response.write("partial"); response.socket!.destroy(); }
    else response.end(mode === "large" ? "x".repeat(MAX_RESPONSE_BYTES + 1) : "false");
  });
  for (const config of configs(endpoint)) {
    for (const value of ["large", "false", "close"]) {
      mode = value;
      assert.deepEqual(await sendNotification(config, message, signal()),
        { status: "failed", failure: value === "close" ? "transient" : "destination-rejected" });
    }
  }
});

test("HTTP cancellation covers response consumption and closes every active socket", async (t) => {
  let closed = 0;
  const endpoint = await fixture(t, (request, response) => {
    request.socket.once("close", () => { closed++; });
    response.writeHead(200); response.write("partial");
  });
  for (const config of configs(endpoint)) {
    assert.deepEqual(await sendNotification(config, message, AbortSignal.timeout(60)), { status: "failed", failure: "timeout" });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, 3);
  assert.deepEqual(await sendNotification(configs(endpoint)[0], message, AbortSignal.abort("synthetic-token")), { status: "failed", failure: "timeout" });
});

test("runtime guards prevent URL/header injection and bounded message overflow before any connection", async (t) => {
  let requests = 0;
  const endpoint = await fixture(t, (_request, response) => { requests++; response.end(); });
  const invalid: NotificationRuntimeConfig[] = [
    { kind: "webhook", endpoint: `${endpoint}/`, authorization: "Bearer token\r\nX-Agent: injected" },
    { kind: "gotify", endpoint, token: "token\nInjected" },
    { kind: "gotify", endpoint: `${endpoint}?token=synthetic-token`, token: "synthetic-token" },
    { kind: "discord", endpoint: endpoint.replace("http://", "http://name:token@") },
    { kind: "discord", endpoint: "file:///example.invalid" },
    { kind: "discord", endpoint: `${endpoint}#fragment` }
  ];
  for (const config of invalid) assert.deepEqual(await sendNotification(config, message, signal()), { status: "failed", failure: "validation" });
  for (const override of [{ title: "title\r\nBcc: injected" }, { idempotencyKey: "key\nInjected" },
    { requiredText: "x".repeat(8000) }, { priority: 11 }, { requiredText: "" }]) {
    for (const config of configs(endpoint)) assert.deepEqual(await sendNotification(config, { ...message, ...override }, signal()), { status: "failed", failure: "validation" });
  }
  assert.equal(requests, 0);
});

test("Gotify configured priority and generic unauthenticated empty 204 acceptance", async (t) => {
  const endpoint = await fixture(t, (request, response, body) => {
    if (request.url === "/message") { assert.equal(JSON.parse(body).priority, 9); response.end('{"id":2}'); }
    else { assert.equal(request.headers.authorization, undefined); response.writeHead(204); response.end(); }
  });
  assert.deepEqual(await sendNotification({ kind: "gotify", endpoint, token: "synthetic-token" }, { ...message, priority: 9 }, signal()), { status: "delivered" });
  assert.deepEqual(await sendNotification({ kind: "webhook", endpoint, authorization: null }, message, signal()), { status: "delivered" });
});

test("absolute HTTP deadline ends a trickling body within 15 seconds", { timeout: 18_000 }, async (t) => {
  const endpoint = await fixture(t, (_request, response) => {
    response.writeHead(200); response.write("x");
    const timer = setInterval(() => response.write("x"), 40);
    response.on("close", () => clearInterval(timer));
  });
  const start = performance.now();
  assert.deepEqual(await sendNotification({ kind: "webhook", endpoint, authorization: null }, message, signal()), { status: "failed", failure: "timeout" });
  assert.ok(performance.now() - start >= 14_900);
  assert.ok(performance.now() - start < 16_500);
});
