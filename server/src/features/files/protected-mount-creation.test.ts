import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { startAgent, loadAgentModule, CONTAINER_ID, CONTAINER_NAME, PROJECT_NAME, SERVICE_NAME, COMPOSE_FILE_NAME, SHARE } from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { REGISTRY_SYNC_ACTOR, syncRegistry } from "../../domain/containers/index.js";
import { applyFileAction, listFileSources, listFiles, uploadFile } from "./agent-client.js";

test("RW-Socket: sichtbare Neuanlagen bleiben erlaubt, Archivquellen bleiben geschützt", async (t) => {
  const agent = await startAgent();
  t.after(agent.stop);
  await syncRegistry(agent.target, [{
    containerId: CONTAINER_ID, containerName: CONTAINER_NAME, imageRef: "nginx:1.27", allowed: true, sharePath: SHARE,
    compose: { projectDir: agent.projectDir, projectName: PROJECT_NAME, serviceName: SERVICE_NAME, composeFileName: COMPOSE_FILE_NAME, origin: "adopted" }
  }], { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl });
  type Mount = { Type: string; Source: string; Destination: string; RW: boolean };
  type Engine = { inspect(id: string): Promise<{ Mounts: Mount[] }>; statArchive(id: string, target: string): Promise<unknown>; openArchiveStream: unknown; putArchive(id: string, target: string, bytes: Buffer): Promise<void> };
  const { engine } = await loadAgentModule<{ engine: Engine }>("runtime/state.ts");
  const { rawOps } = await loadAgentModule<{ rawOps: { config: unknown } }>("runtime/raw-ops.ts");
  const { MemoryArchive } = await loadAgentModule<{ MemoryArchive: new () => {
    statArchive(id: string, target: string): Promise<unknown>;
    putArchive(id: string, target: string, bytes: Buffer): Promise<void>;
    openArchiveStream: (...args: unknown[]) => unknown; calls: { method: string }[];
  } }>("archive-test-support.ts");
  const external = new MemoryArchive();
  const inspect = engine.inspect.bind(engine);
  const original = await inspect(CONTAINER_ID);
  const visible = original.Mounts[0];
  const mounts = [...original.Mounts,
    { Type: "bind", Source: "/external/example/storage", Destination: "/data", RW: true },
    { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }];
  engine.inspect = async (id) => ({ ...await inspect(id), Mounts: mounts });
  rawOps.config = async () => ({ services: { [SERVICE_NAME]: {
    image: "nginx:1.27", volumes: mounts.map((mount) => ({ type: "bind", source: mount.Source, target: mount.Destination }))
  } } });
  const stat = engine.statArchive.bind(engine);
  const put = engine.putArchive.bind(engine);
  const stream = engine.openArchiveStream;
  engine.statArchive = (id, target) => target === "/data" || target.startsWith("/data/") ? external.statArchive(id, target) : stat(id, target);
  engine.openArchiveStream = async (...args: [string, string]) => args[1] === "/data" || args[1].startsWith("/data/")
    ? external.openArchiveStream(...args) : (stream as (...args: [string, string]) => unknown)(...args);
  engine.putArchive = (id, target, bytes) => target === "/data" || target.startsWith("/data/") ? external.putArchive(id, target, bytes) : put(id, target, bytes);
  const options = { actor: { kind: "user" as const, id: "u-1" }, fetchImpl: agent.fetchImpl };
  const sources = await listFileSources(agent.target, CONTAINER_ID, options);
  const visibleSource = sources.find((source) => source.target === visible.Destination)!;
  const archiveSource = sources.find((source) => source.target === "/data")!;
  assert.equal(visibleSource.writable, true);
  assert.equal(visibleSource.writeBlocker, null);
  assert.equal(archiveSource.writable, false);
  assert.equal(archiveSource.writeBlocker, "source-protected");
  const protectedResponse = (error: unknown) => {
    assert.equal((error as { status: number }).status, 403);
    assert.equal((error as { detail: { error: string } }).detail.error, "source-protected");
    return true;
  };
  for (const [label, location, allowed] of [
    ["visible-source", { sourceId: visibleSource.sourceId, path: "" }, true],
    ["visible-share", { share: SHARE, path: "" }, true],
    ["archive-source", { sourceId: archiveSource.sourceId, path: "" }, false]
  ] as const) {
    await t.test(`${label}: uploadable follows the selected backend`, async () => {
      const listing = await listFiles(agent.target, CONTAINER_ID, location, options);
      assert.equal(listing.diagnostics?.uploadable, allowed);
    });
    await t.test(`${label}: file creation`, async () => {
      const name = label + ".txt";
      const uploading = uploadFile(agent.target, CONTAINER_ID, { ...location, name }, Buffer.from("created bytes"), options);
      if (allowed) {
        assert.equal((await uploading).ok, true);
        assert.equal(await fs.readFile(path.join(agent.projectDir, SHARE, name), "utf8"), "created bytes");
      } else await assert.rejects(uploading, protectedResponse);
    });
    await t.test(`${label}: folder creation`, async () => {
      const name = label + "-folder";
      const creating = applyFileAction(agent.target, CONTAINER_ID, SHARE, { action: "create-folder", path: "", name }, options, "sourceId" in location ? location.sourceId : undefined);
      if (allowed) {
        await creating;
        assert.equal((await fs.stat(path.join(agent.projectDir, SHARE, name))).isDirectory(), true);
      } else await assert.rejects(creating, protectedResponse);
    });
  }
  assert.equal(external.calls.some((call) => call.method === "PUT"), false);
});
