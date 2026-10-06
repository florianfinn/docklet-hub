import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";
import { stackActionStreamLineSchema, type StackRuntimeResult } from "contract";
import { stackRuntimeResponder } from "./runtime/action-stream.js";
import { actionConnection } from "./runtime/action-connection.js";

class Response extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
  asHttp() { return this as unknown as http.ServerResponse; }
}
const service = { serviceName: "web", containerId: "id", status: "running", startedAt: "now", exitCode: 0, health: "unhealthy", outcome: "ok" as const };
const body: StackRuntimeResult = { ok: true, action: "start", applyDefinition: false, outcome: "ok", services: [service], containerIds: { web: "id" } };

test("stack stream starts under the operation hook and carries service progress plus the exact result", () => {
  const response = new Response();
  const responder = stackRuntimeResponder(response.asHttp(), "start", "app", true);
  assert.equal(response.headersSent, false);
  responder.onStart(false);
  responder.onProgress(service);
  responder.finish({ status: 200, body });
  const lines = response.chunks.map((chunk) => stackActionStreamLineSchema.parse(JSON.parse(chunk)));
  assert.deepEqual(lines.map((line) => line.kind), ["start", "progress", "result"]);
  assert.deepEqual(lines.at(-1), { kind: "result", status: 200, body });
  assert.equal(response.headers["content-type"], "application/x-ndjson; charset=utf-8");
  assert.equal(response.writableEnded, true);
});

test("the synchronous fallback has the same status and body", () => {
  const response = new Response();
  const responder = stackRuntimeResponder(response.asHttp(), "start", "app", false);
  responder.onStart(false);
  responder.onProgress(service);
  responder.finish({ status: 200, body });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.chunks.join("")), body);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
});

test("preflight failure before the first stream line keeps its HTTP status", () => {
  const response = new Response();
  const failed = { ...body, ok: false, error: "runtime-image-missing" };
  stackRuntimeResponder(response.asHttp(), "start", "app", true).finish({ status: 409, body: failed });
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.chunks.join("")), failed);
});

test("a completed request body does not discard an action but a response disconnect does", () => {
  const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as http.IncomingMessage;
  const response = new Response();
  const connection = actionConnection(request, response.asHttp());
  request.emit("close");
  assert.equal(connection.signal.aborted, false);
  response.destroy();
  assert.equal(connection.signal.aborted, true);
  connection.dispose();
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("the aborted-request event also discards queued work", () => {
  const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as http.IncomingMessage;
  const response = new Response();
  const connection = actionConnection(request, response.asHttp());
  request.emit("aborted");
  assert.equal(connection.signal.aborted, true);
  connection.dispose();
});
