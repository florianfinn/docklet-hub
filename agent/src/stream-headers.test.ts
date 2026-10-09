import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { ACTOR_HEADER, SECRET_HEADER } from "contract";
import { FileArchive } from "./file-archive.js";

// Stay below the hub's 3,000 ms monitor-events setup deadline.
const HEADER_TIMEOUT_MS = 2_000;
const TEST_TIMEOUT_MS = 5_000;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-stream-headers-"));
const stateDirectory = path.join(directory, "state");
const mountedPath = path.join(directory, "external-data");
fs.mkdirSync(stateDirectory);
fs.mkdirSync(path.join(directory, "apps"));
fs.mkdirSync(mountedPath, { recursive: true });
const secret = "s".repeat(64);
process.env.DOCKER_SOCKET_PATH = path.join(stateDirectory, "synthetic-engine-source");
process.env.DOCKER_AGENT_SECRET = secret;
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(stateDirectory, "registry.json");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(stateDirectory, "monitors.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(stateDirectory, "audit.jsonl");
process.env.DOCKER_AGENT_BIND_BASE_PATH = path.join(directory, "apps");
const { handleRequest } = await import("./dispatch.js");
const { audit, dockerEvents, engine, registry } = await import("./runtime/state.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function withAgent(run: (baseUrl: string) => Promise<void>, closeSource?: () => void): Promise<void> {
  const tasks: Promise<void>[] = [];
  const server = http.createServer((request, response) => {
    tasks.push(handleRequest(request, response));
  });
  // Loopback and an ephemeral port isolate the synthetic HTTP transport.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    closeSource?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(tasks);
  }
}

async function fetchHeaders(url: string, actor = "system:monitor"): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { [SECRET_HEADER]: secret, [ACTOR_HEADER]: actor },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

test("monitor dispatch sends HTTP 200 headers within 2,000 ms without a Docker event", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  let subscribed = false;
  let unsubscribed = false;
  t.mock.method(dockerEvents, "isObserving", () => true);
  t.mock.method(dockerEvents, "subscribe", () => {
    subscribed = true;
    return () => { unsubscribed = true; };
  });
  await withAgent(async (baseUrl) => {
    const response = await fetchHeaders(`${baseUrl}/monitor-events`);
    try {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      assert.equal(subscribed, true);
    } finally {
      await response.body?.cancel();
    }
  });
  assert.equal(unsubscribed, true);
});

test("audit archive dispatch sends HTTP 200 headers within 2,000 ms before any file bytes", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const source = new PassThrough();
  t.after(() => source.destroy());
  t.mock.method(audit, "prepareHandoff", async () => ({ bytes: 1, sha256: "a".repeat(64) }));
  t.mock.method(audit, "readStream", () => source);
  await withAgent(async (baseUrl) => {
    const response = await fetchHeaders(`${baseUrl}/audit-archive`, "demo-user");
    try {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-length"), "1");
      assert.equal(response.headers.get("x-audit-sha256"), "a".repeat(64));
      assert.equal(source.readableLength, 0);
      assert.equal(source.writableEnded, false);
    } finally {
      await response.body?.cancel();
    }
  }, () => source.destroy());
});

test("file download dispatch sends HTTP 200 headers within 2,000 ms before any archive bytes", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const containerId = "a".repeat(64);
  const source = new PassThrough();
  t.after(() => source.destroy());
  registry.replaceAll([{ containerId, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true }]);
  t.mock.method(engine, "info", async () => ({ DockerRootDir: path.join(directory, "docker") }));
  t.mock.method(engine, "inspect", async () => ({ Id: containerId, Name: "/demo-web", Config: { Labels: {} },
    Mounts: [{ Type: "bind", Source: mountedPath, Destination: "/data", RW: false }] }));
  t.mock.method(engine, "listContainerIds", async () => [containerId]);
  t.mock.method(engine, "statArchive", async () => ({ name: "data", size: 0, mode: 0x80000000, mtime: "", linkTarget: "" }));
  t.mock.method(FileArchive.prototype, "download", async () => ({ ok: true, size: 1, stream: source,
    cancel: async () => { source.destroy(); } }));
  await withAgent(async (baseUrl) => {
    const listing = await fetchHeaders(`${baseUrl}/containers/${containerId}/file-sources`, "demo-user");
    assert.equal(listing.status, 200);
    const { sources } = await listing.json() as { sources: Array<{ sourceId: string; readable: boolean }> };
    assert.equal(sources.length, 1);
    assert.equal(sources[0].readable, true);
    const response = await fetchHeaders(`${baseUrl}/containers/${containerId}/file?sourceId=${sources[0].sourceId}&path=demo.txt`, "demo-user");
    try {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/octet-stream");
      assert.equal(response.headers.get("content-length"), "1");
      assert.equal(source.readableLength, 0);
      assert.equal(source.writableEnded, false);
    } finally {
      await response.body?.cancel();
    }
  }, () => source.destroy());
});
