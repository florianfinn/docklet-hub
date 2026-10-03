import test from "node:test";
import assert from "node:assert/strict";

import {
  containerShareLookupSchema,
  containerShareResponseSchema,
  fileActionResponseSchema,
  fileListingResponseSchema,
  fileTextResponseSchema,
  fileTextSavedSchema,
  fileUploadResponseSchema,
  shareCandidatesSchema
} from "contract";

import { call, CONTAINER_NAME, SHARE, startAgent, startHub, url, withContainer } from "./file-routes-test-support.js";

// The answers of the file surface against their schemas (#248). The web
// parses every one of them against the contract and fails on a mismatch;
// these are the same checks on the side that builds them, through the real
// router with a small agent on 127.0.0.1.
//
// Every case compares the parse result with the body as well: a field the
// server sends and the schema does not know is stripped by the parse and
// fails there.

type Schema = {
  safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
};

async function assertMatches(response: globalThis.Response, schema: Schema, where: string): Promise<void> {
  assert.equal(response.status, 200, `${where}: status`);
  const body: unknown = await response.json();
  const parsed = schema.safeParse(body);
  assert.ok(parsed.success, `${where} does not match its schema: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`);
  assert.deepEqual(parsed.data, body);
}

test("Antworten der Freigabe-Routen erfüllen ihre Schemas", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/share-candidates", {
    status: 200,
    body: { candidates: [{ relative: SHARE, destination: "/usr/src/app/upload", writable: true }] }
  });
  const hub = await startHub({ agent });
  try {
    await assertMatches(await call(url(hub, "share-candidates")), shareCandidatesSchema, "GET …/share-candidates");
    // Before the choice: `share: null`, the answer "nobody has chosen".
    await assertMatches(await call(url(hub, "share")), containerShareLookupSchema, "GET …/share (none)");
    await assertMatches(
      await call(url(hub, "share"), { method: "PUT", body: { path: SHARE } }),
      containerShareResponseSchema,
      "PUT …/share"
    );
    // After the choice: the stored share, not `null`.
    const chosen = await call(url(hub, "share"));
    assert.equal(chosen.status, 200);
    const body: unknown = await chosen.json();
    assert.deepEqual(containerShareLookupSchema.parse(body), { share: { containerName: CONTAINER_NAME, path: SHARE } });
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("Antworten der Datei-Routen erfüllen ihre Schemas", async () => {
  const agent = await startAgent();
  withContainer(agent);
  agent.replies.set("GET /containers/c0ffee/files", {
    status: 200,
    body: {
      share: SHARE,
      path: "fotos",
      entries: [{ name: "a.jpg", kind: "file", size: 12, changedAt: 1_757_240_000, uid: 99, gid: 100 }],
      truncated: true,
      diagnostics: { readable: true, deletable: false, uid: 99, gid: 100, uploadable: true }
    }
  });
  agent.replies.set("GET /containers/c0ffee/file-text", {
    status: 200,
    body: { path: "a.yml", content: "schlüssel: wert\n", hash: "sha256:damals" }
  });
  agent.replies.set("PUT /containers/c0ffee/file-text", { status: 200, body: { hash: "sha256:neu" } });
  agent.replies.set("PUT /containers/c0ffee/file", { status: 200, body: { name: "neu.bin", size: 5 } });
  agent.replies.set("POST /containers/c0ffee/files", { status: 200, body: { name: "neu", kind: null } });
  const hub = await startHub({ agent, share: SHARE });
  try {
    await assertMatches(await call(url(hub, "files?path=fotos")), fileListingResponseSchema, "GET …/files");
    await assertMatches(await call(url(hub, "file-text?path=a.yml")), fileTextResponseSchema, "GET …/file-text");
    await assertMatches(
      await call(url(hub, "file-text?path=a.yml&expectedHash=sha256:damals"), { method: "PUT", text: "neu\n" }),
      fileTextSavedSchema,
      "PUT …/file-text"
    );
    await assertMatches(
      await call(url(hub, "file?path=fotos&name=neu.bin"), { method: "PUT", raw: "abcde" }),
      fileUploadResponseSchema,
      "PUT …/file"
    );
    await assertMatches(
      await call(url(hub, "files"), { method: "POST", body: { action: "create-directory", path: "fotos", name: "neu" } }),
      fileActionResponseSchema,
      "POST …/files"
    );
  } finally {
    await hub.close();
    await agent.close();
  }
});
