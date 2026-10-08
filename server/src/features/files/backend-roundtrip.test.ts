import test from "node:test";
import assert from "node:assert/strict";
import { startAgent, loadAgentModule, CONTAINER_ID, CONTAINER_NAME, PROJECT_NAME, SERVICE_NAME, COMPOSE_FILE_NAME } from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { REGISTRY_SYNC_ACTOR, syncRegistry } from "../../domain/containers/index.js";
import { listFileSources, listFiles, writeFileText, downloadFile } from "./agent-client.js";

test("Archive-Quellen: großer Unterbaum, Einzeldatei-Mount und geschützter RW-Mount im echten Roundtrip", async (t) => {
  const agent = await startAgent();
  t.after(agent.stop);
  await syncRegistry(agent.target, [{ containerId: CONTAINER_ID, containerName: CONTAINER_NAME, imageRef: "nginx:1.27", allowed: true, sharePath: null,
    compose: { projectDir: agent.projectDir, projectName: PROJECT_NAME, serviceName: SERVICE_NAME, composeFileName: COMPOSE_FILE_NAME, origin: "adopted" } }],
    { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl });
  type Mount = { Type: string; Source: string; Destination: string; RW: boolean };
  type Engine = { inspect(id: string): Promise<{ Mounts: Mount[] }>; statArchive: unknown; openArchiveStream: unknown; putArchive: unknown };
  const { engine } = await loadAgentModule<{ engine: Engine }>("runtime/state.ts");
  const { rawOps } = await loadAgentModule<{ rawOps: { config: unknown } }>("runtime/raw-ops.ts");
  const { MemoryArchive } = await loadAgentModule<{ MemoryArchive: new () => {
    directory(target: string): void; file(target: string, bytes: string | Buffer): void;
    statArchive: (...args: unknown[]) => unknown; openArchiveStream: (...args: unknown[]) => unknown; putArchive: (...args: unknown[]) => unknown;
    calls: { method: string }[];
  } }>("archive-test-support.ts");
  const memory = new MemoryArchive();
  memory.file("/data/large", Buffer.alloc(17 * 1024 * 1024, 65));
  memory.file("/data/next", "next");
  memory.file("/single.txt", "old");
  const mounts: Mount[] = [
    { Type: "bind", Source: "/external/example/storage", Destination: "/data", RW: true },
    { Type: "bind", Source: "/external/example/single.txt", Destination: "/single.txt", RW: true }
  ];
  const inspect = engine.inspect.bind(engine);
  engine.inspect = async (id) => ({ ...await inspect(id), Mounts: mounts });
  rawOps.config = async () => ({ services: { [SERVICE_NAME]: { image: "nginx:1.27", volumes: mounts.map((mount) => ({ type: "bind", source: mount.Source, target: mount.Destination })) } } });
  engine.statArchive = memory.statArchive.bind(memory);
  engine.openArchiveStream = memory.openArchiveStream.bind(memory);
  engine.putArchive = memory.putArchive.bind(memory);
  const options = { actor: { kind: "user" as const, id: "u-1" }, fetchImpl: agent.fetchImpl };
  const sources = await listFileSources(agent.target, CONTAINER_ID, options);
  const directory = sources.find((source) => source.target === "/data")!;
  const singleton = sources.find((source) => source.target === "/single.txt")!;
  assert.equal(directory.writable, true);
  assert.equal(singleton.readable, true);
  assert.equal(singleton.writable, false);
  assert.equal(singleton.writeBlocker, "source-read-only");
  const listing = await listFiles(agent.target, CONTAINER_ID, { sourceId: directory.sourceId, path: "" }, options);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["large", "next"]);
  assert.equal(listing.truncated, false);
  assert.equal(listing.diagnostics?.deletable, false);
  const reject = (reason: string) => (error: unknown) => {
    assert.equal((error as { status: number }).status, 403);
    assert.equal((error as { detail: { error: string } }).detail.error, reason);
    return true;
  };
  await assert.rejects(writeFileText(agent.target, CONTAINER_ID, { sourceId: singleton.sourceId, path: "" }, { content: "new", expectedHash: "unused" }, options), reject("source-read-only"));
  await assert.rejects(downloadFile(agent.target, CONTAINER_ID, { sourceId: directory.sourceId, path: "missing" }, options), (error: unknown) => {
    assert.equal((error as { status: number }).status, 404); return true;
  });
  mounts.push({ Type: "bind", Source: "/etc", Destination: "/protected", RW: true });
  memory.directory("/protected");
  const protectedSources = await listFileSources(agent.target, CONTAINER_ID, options);
  assert.equal(protectedSources.find((source) => source.target === "/data")!.writeBlocker, "source-protected");
  memory.calls.length = 0;
  await assert.rejects(writeFileText(agent.target, CONTAINER_ID, { sourceId: directory.sourceId, path: "next" }, { content: "unsafe", expectedHash: "unused" }, options), reject("source-protected"));
  assert.equal(memory.calls.some((call) => call.method === "PUT"), false);
});
