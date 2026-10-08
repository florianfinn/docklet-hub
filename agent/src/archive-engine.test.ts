import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { DockerEngine } from "./engine.js";
import { archiveOf } from "./archive-test-support.js";
import { tarWithOneEntry } from "./tar.js";

test("HEAD, GET and PUT target stopped containers without exec or running-state checks", async (t) => {
  const calls: http.RequestOptions[] = [];
  let payload: Buffer | null = null;
  const stat = { name: "config.txt", size: 3, mode: 0o640, mtime: "2026-01-01T00:00:00Z", linkTarget: "" };
  const archive = archiveOf([{ name: "config.txt", kind: "file", content: Buffer.from("old"), uid: 7001, gid: 7002, mode: 0o640, mtime: 0 }]);
  t.mock.method(http, "request", (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    calls.push(options);
    const request = new EventEmitter() as http.ClientRequest;
    request.write = ((body: Buffer) => { payload = body; return true; }) as typeof request.write;
    request.end = (() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "x-docker-container-path-stat": Buffer.from(JSON.stringify(stat)).toString("base64") } }) as unknown as http.IncomingMessage;
      callback(response);
      if (options.method === "GET") response.emit("data", archive);
      response.emit("end");
      return request;
    }) as typeof request.end;
    return request;
  });
  const engine = new DockerEngine({ socketPath: "/unused.sock" });
  t.mock.method(engine, "inspect", async () => { throw new Error("stopped containers must not require state checks"); });
  assert.deepEqual(await engine.statArchive("stopped", "/data/config.txt"), stat);
  assert.deepEqual(await engine.getArchive("stopped", "/data/config.txt", 65536), archive);
  const put = tarWithOneEntry({ name: "config.txt", kind: "file", content: Buffer.from("new"), uid: 7001, gid: 7002, mode: 0o640, mtime: 0 });
  await engine.putArchive("stopped", "/data", put);
  assert.deepEqual(payload, put);
  assert.deepEqual(calls.map((call) => call.method), ["HEAD", "GET", "PUT"]);
  assert.equal(calls.every((call) => String(call.path).startsWith("/containers/stopped/archive?")), true);
  const query = new URL(String(calls[2].path), "http://docker").searchParams;
  assert.equal(query.get("path"), "/data");
  assert.equal(query.get("noOverwriteDirNonDir"), "1");
  assert.equal(query.has("copyUIDGID"), false);
});

test("archive streaming exposes transport chunks and closes rejected responses without collecting bodies", async (t) => {
  const { Readable } = await import("node:stream");
  let status = 200;
  let destroyed: boolean;
  const calls: http.RequestOptions[] = [];
  t.mock.method(http, "request", (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    calls.push(options);
    const request = new EventEmitter() as http.ClientRequest;
    request.end = (() => {
      const response = Object.assign(Readable.from([Buffer.from("first"), Buffer.from("second")]), { statusCode: status });
      response.on("close", () => { destroyed = true; });
      callback(response as unknown as http.IncomingMessage);
      return request;
    }) as typeof request.end;
    return request;
  });
  const engine = new DockerEngine({ socketPath: "/unused.sock" });
  const signal = new AbortController().signal;
  const stream = await engine.openArchiveStream("target", "/data", signal);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk.toString());
  assert.deepEqual(chunks, ["first", "second"]);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].method, "GET");
  assert.equal(new URL(String(calls[0].path), "http://docker").searchParams.get("path"), "/data");
  status = 404; destroyed = false;
  await assert.rejects(engine.openArchiveStream("target", "/missing"), { message: "archive-read-failed", status: 404 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(destroyed, true);
});

test("restore PUT streams chunks under backpressure without copying ownership or buffering the archive", async (t) => {
  let total = 0; let calls = 0; let seen: http.RequestOptions | null = null;
  t.mock.method(http, "request", (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    seen = options; const request = new EventEmitter() as http.ClientRequest;
    request.write = ((chunk: Buffer) => { total += chunk.length; calls++; queueMicrotask(() => request.emit("drain")); return false; }) as typeof request.write;
    request.end = (() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, resume() {} }) as unknown as http.IncomingMessage;
      callback(response); response.emit("end"); return request;
    }) as typeof request.end;
    return request;
  });
  const engine = new DockerEngine({ socketPath: "/unused.sock" });
  await engine.putArchiveStream("stopped", "/data", (async function* () {
    const chunk = Buffer.alloc(65536); for (let index = 0; index < 1024; index++) yield chunk;
  })());
  assert.equal(total, 64 * 1024 * 1024); assert.equal(calls, 1024);
  const query = new URL(String((seen as unknown as http.RequestOptions).path), "http://docker").searchParams;
  assert.equal(query.get("path"), "/data"); assert.equal(query.get("noOverwriteDirNonDir"), "1"); assert.equal(query.has("copyUIDGID"), false);
});
