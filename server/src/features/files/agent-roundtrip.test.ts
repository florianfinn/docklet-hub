import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { FILE_ACTIONS } from "contract";

import {
  CONTAINER_ID,
  CONTAINER_NAME,
  COMPOSE_FILE_NAME,
  PROJECT_NAME,
  SERVICE_NAME,
  SHARE,
  schemaRefusals,
  startAgent
} from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { REGISTRY_SYNC_ACTOR, syncRegistry } from "../../domain/containers/index.js";
import {
  applyFileAction,
  downloadFile,
  listFiles,
  listFileSources,
  readFileText,
  uploadFile,
  writeFileText
} from "./agent-client.js";

// The contract test of #272 for the files: the hub's agent client against the
// agent's REAL handlers in this process, with only Docker faked
// (`platform/agent-transport/agent-roundtrip-test-support.ts`). No request of
// the hub may meet a schema refusal of the agent (`schemaRefusals`): that
// would be the two sides disagreeing about a field.

test("Dateien: Liste, Text, Speichern, Upload, Download und die drei Aktionen treffen keine Schemaprüfung", async (t) => {
  const agent = await startAgent();
  t.after(agent.stop);
  await syncRegistry(
    agent.target,
    [
      {
        containerId: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        imageRef: "nginx:1.27",
        allowed: true,
        compose: {
          projectDir: agent.projectDir,
          projectName: PROJECT_NAME,
          serviceName: SERVICE_NAME,
          composeFileName: COMPOSE_FILE_NAME,
          origin: "adopted"
        },
        sharePath: SHARE
      }
    ],
    { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl }
  );
  const options = { actor: { kind: "user" as const, id: "u-1" }, fetchImpl: agent.fetchImpl };
  const sources = await listFileSources(agent.target, CONTAINER_ID, options);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "project");
  assert.equal(sources[0].writable, true);
  const root = { sourceId: sources[0].sourceId, path: "" };

  const listing = await listFiles(agent.target, CONTAINER_ID, root, options);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["index.html"]);

  const file = { sourceId: sources[0].sourceId, path: "index.html" };
  const inodePath = path.join(agent.projectDir, SHARE, "index.html");
  const hardlinkPath = path.join(agent.projectDir, SHARE, "index-link.html");
  await fs.link(inodePath, hardlinkPath);
  const before = await fs.stat(inodePath);
  const text = await readFileText(agent.target, CONTAINER_ID, file, options);
  const written = await writeFileText(
    agent.target,
    CONTAINER_ID,
    file,
    { content: "<h1>hallo</h1>\n", expectedHash: text.hash },
    options
  );
  assert.equal(written.ok, true);
  const afterWrite = await fs.stat(inodePath);
  assert.deepEqual([afterWrite.dev, afterWrite.ino, afterWrite.uid, afterWrite.gid], [before.dev, before.ino, before.uid, before.gid]);
  assert.equal(await fs.readFile(hardlinkPath, "utf8"), "<h1>hallo</h1>\n");
  await fs.unlink(hardlinkPath);

  // Descriptor saves and daemon-based creation share the fake container filesystem.
  await uploadFile(agent.target, CONTAINER_ID, { ...root, name: "robots.txt" }, new TextEncoder().encode("x"), options);
  const download = await downloadFile(agent.target, CONTAINER_ID, file, options);
  assert.equal(await new Response(download.stream).text(), "<h1>hallo</h1>\n");

  const [createFolder, rename, remove] = FILE_ACTIONS;
  await applyFileAction(agent.target, CONTAINER_ID, SHARE, { action: createFolder, path: "", name: "assets" }, options);
  await applyFileAction(agent.target, CONTAINER_ID, SHARE, { action: rename, path: "index.html", name: "start.html" }, options);
  const renamed = await downloadFile(agent.target, CONTAINER_ID, { ...root, path: "start.html" }, options);
  assert.equal(await new Response(renamed.stream).text(), "<h1>hallo</h1>\n");
  await applyFileAction(agent.target, CONTAINER_ID, SHARE, { action: remove, path: "start.html" }, options);
  await applyFileAction(agent.target, CONTAINER_ID, SHARE, { action: rename, path: "assets", name: "resources" }, options);
  await applyFileAction(agent.target, CONTAINER_ID, SHARE, { action: remove, path: "resources" }, options);
  const after = await listFiles(agent.target, CONTAINER_ID, root, options);
  assert.equal(after.diagnostics?.deletable, true);
  assert.deepEqual(after.entries.map((entry) => entry.name), ["robots.txt"]);

  await assert.rejects(downloadFile(agent.target, CONTAINER_ID, { ...root, path: "missing" }, options), (error: unknown) => {
    assert.equal((error as { status: number }).status, 404); return true;
  });
  assert.deepEqual(schemaRefusals(agent), []);
});
