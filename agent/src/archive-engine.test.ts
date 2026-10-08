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
