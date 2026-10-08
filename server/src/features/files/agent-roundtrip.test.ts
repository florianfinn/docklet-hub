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
  const text = await readFileText(agent.target, CONTAINER_ID, file, options);
  const written = await writeFileText(
    agent.target,
    CONTAINER_ID,
    file,
    { content: "<h1>hallo</h1>\n", expectedHash: text.hash },
    options
  );
  assert.equal(written.ok, true);

  // Descriptor writes change the local fixture; downloads return those bytes.
  await uploadFile(agent.target, CONTAINER_ID, { ...root, name: "robots.txt" }, new TextEncoder().encode("x"), options);
  const download = await downloadFile(agent.target, CONTAINER_ID, file, options);
  assert.equal(await new Response(download.stream).text(), "<h1>hallo</h1>\n");

  // The three actions, each with the fields it takes. Whether the agent can
  // carry them out against the fake is not the question here; that it reads
  // them is (`schemaRefusals` below).
  // Taken from the contract by position (create a folder, rename, delete).
  const [createFolder, rename, remove] = FILE_ACTIONS;
  for (const command of [
    { action: createFolder, path: "", name: "assets" },
    { action: rename, path: "index.html", name: "start.html" },
    { action: remove, path: "start.html" }
  ]) {
    await applyFileAction(agent.target, CONTAINER_ID, SHARE, command, options);
  }

  assert.deepEqual(schemaRefusals(agent), []);
});
