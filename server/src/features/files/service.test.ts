import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOST_THEME, type ContainerShare } from "contract";
import type { ContainerAccessResult, HostRecord, RouteWriting } from "../../domain/hosts/index.js";
import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import { respondWithFailure, type RouteFailure } from "../../platform/http/route-failure.js";
import { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES } from "./agent-client.js";
import { createFilesService, type FilesAgent, type ShareStore } from "./service.js";

// The service of the feature `files` without Express, without Postgres and
// without an agent (#262): a fake chain, a store in memory and a fake agent
// that records what it was asked. What is checked is what the service decides:
// the order of the checks, the share from the store, the refusals of the hub,
// and the refusals of the agent as data that keep their reason.

const TARGET: AgentTarget = { baseUrl: "http://agent.test", secret: "s".repeat(32) };
const REF = { hostId: "h1", containerId: "c0ffee", userId: "admin-1" };
const SHARE = "immich/library";

const HOST: HostRecord = {
  id: "h1",
  name: "unraid",
  agentUrl: "http://127.0.0.1:0",
  kind: "external",
  state: "registered",
  tunnelAddress: null,
  wireguardPublicKey: null,
  endpointOverride: null,
  failedAttempts: 0,
  dockerGid: null,
  bindBasePath: null,
  createdAt: new Date("2026-09-08T10:00:00.000Z"),
  registeredAt: null,
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

type Call = { method: string; args: unknown[] };

function fixture(
  options: {
    share?: string | null;
    candidates?: string[];
    chain?: RouteFailure;
    fail?: (method: string) => unknown;
    saved?: { ok: true; hash: string } | { ok: false; reason: string; hash: string };
  } = {}
) {
  const opened: RouteWriting[] = [];
  const calls: Call[] = [];
  const store: { share: string | null; writes: string[] } = {
    share: options.share === undefined ? null : options.share,
    writes: []
  };

  const shares: ShareStore = {
    read: async () => store.share,
    set: async (_host, containerName, path): Promise<ContainerShare> => {
      store.share = path;
      store.writes.push(`set:${containerName}=${path}`);
      return { containerName, path };
    },
    remove: async (_host, containerName) => {
      store.share = null;
      store.writes.push(`remove:${containerName}`);
    }
  };

  const record = <T>(method: string, args: unknown[], value: T): T => {
    calls.push({ method, args });
    const error = options.fail?.(method);
    if (error !== undefined && error !== null) throw error;
    return value;
  };

  const agent: FilesAgent = {
    listShareCandidates: async (...args) =>
      record(
        "listShareCandidates",
        args,
        (options.candidates ?? [SHARE]).map((relative) => ({ relative, destination: "/data", writable: true }))
      ),
    listFiles: async (...args) =>
      record("listFiles", args, { share: SHARE, path: "", entries: [], truncated: false, diagnostics: null }),
    downloadFile: async (...args) =>
      record("downloadFile", args, { size: 3, stream: new Response("abc").body as ReadableStream<Uint8Array> }),
    uploadFile: async (...args) => record("uploadFile", args, { ok: true as const, name: "neu.bin", size: 0 }),
    readFileText: async (...args) => record("readFileText", args, { path: "a.txt", content: "x", hash: "h-1" }),
    writeFileText: async (...args) => record("writeFileText", args, options.saved ?? { ok: true as const, hash: "h-2" }),
    applyFileAction: async (...args) => record("applyFileAction", args, { name: "assets", kind: "directory" })
  };

  const service = createFilesService({
    openContainer: async (request, writing): Promise<ContainerAccessResult> => {
      opened.push(writing);
      if (options.chain) return { ok: false, failure: options.chain };
      return {
        ok: true,
        access: {
          host: HOST,
          target: TARGET,
          container: { id: request.containerId, name: "immich" } as never,
          options: { actor: { kind: "user", id: request.userId } },
          containers: [],
          writable: true
        }
      };
    },
    shares,
    agent
  });
  return { service, opened, calls, store };
}

/** What the route would write for a failure, with the one table for the agent's refusals. */
function answerFor(failure: RouteFailure): { status: number; body: Record<string, unknown> } {
  const answer = { status: 0, body: {} as Record<string, unknown> };
  const response = {
    status(code: number) {
      answer.status = code;
      return response;
    },
    json(body: Record<string, unknown>) {
      answer.body = body;
      return response;
    }
  };
  respondWithFailure(response as never, failure);
  return answer;
}

function failureOf(result: { ok: boolean } & Record<string, unknown>): RouteFailure {
  assert.equal(result.ok, false, "ein Fehlschlag wurde erwartet");
  return result.failure as RouteFailure;
}

// ── 1. Die Freigabe: anlegen, lesen, löschen ────────────────────────────────

test("eine Freigabe lässt sich über den Service anlegen, lesen und löschen", async () => {
  const f = fixture();

  assert.deepEqual(await f.service.readShare(REF), { ok: true, share: null }, "„keine“ ist eine Antwort");

  const chosen = await f.service.chooseShare(REF, { path: SHARE });
  assert.deepEqual(chosen, { ok: true, share: { containerName: "immich", path: SHARE } });

  assert.deepEqual(await f.service.readShare(REF), {
    ok: true,
    share: { containerName: "immich", path: SHARE }
  });

  assert.deepEqual(await f.service.removeShare(REF), { ok: true });
  assert.deepEqual(await f.service.readShare(REF), { ok: true, share: null });
  // Idempotent: taking back what is not there is no failure.
  assert.deepEqual(await f.service.removeShare(REF), { ok: true });

  assert.deepEqual(f.store.writes, ["set:immich=immich/library", "remove:immich", "remove:immich"]);
  // Reading leaves the write lock open, choosing and removing take it.
  assert.deepEqual(f.opened, ["reads", "writes", "reads", "writes", "reads", "writes"]);
});

test("ein Pfad, den die Kandidatenliste nicht führt, wird nicht gespeichert", async () => {
  const f = fixture({ candidates: ["immich/library"] });
  const result = await f.service.chooseShare(REF, { path: "immich/lib" });

  const failure = failureOf(result);
  assert.equal(failure.kind, "problem");
  assert.equal(answerFor(failure).status, 409);
  assert.equal(answerFor(failure).body.error, "share-unknown");
  assert.deepEqual(f.store.writes, [], "die Ablage darf nicht berührt werden");
});

test("ein Formfehler bei der Wahl kostet weder die Kette noch den Agenten", async () => {
  const f = fixture();
  for (const body of [null, {}, { path: "" }, { path: 7 }]) {
    const failure = failureOf(await f.service.chooseShare(REF, body));
    assert.equal(answerFor(failure).status, 400);
    assert.equal(answerFor(failure).body.error, "invalid-input");
  }
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.calls, []);
});

test("ohne gewählte Freigabe antwortet der Service selbst, ohne den Agenten zu fragen", async () => {
  const f = fixture({ share: null });
  const failure = failureOf(await f.service.list(REF, { path: "" }));
  assert.equal(answerFor(failure).status, 409);
  assert.equal(answerFor(failure).body.error, "share-unset");
  assert.deepEqual(f.calls, []);
});

// ── 2. Die Kette und die Form der Parameter ─────────────────────────────────

test("scheitert die Kette, geht ihre Antwort durch und der Agent wird nicht gefragt", async () => {
  const chain: RouteFailure = { kind: "problem", status: 503, error: "host-unreachable", message: "aus" };
  const f = fixture({ chain });
  assert.equal(failureOf(await f.service.list(REF, { path: "" })), chain);
  assert.equal(failureOf(await f.service.removeShare(REF)), chain);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.store.writes, []);
});

test("ein Pfad, der kein Text ist, wird vor der Kette abgewiesen", async () => {
  const f = fixture({ share: SHARE });
  for (const path of [["a", "b"], { x: 1 }, 5]) {
    const failure = failureOf(await f.service.list(REF, { path }));
    assert.equal(answerFor(failure).status, 400);
  }
  assert.deepEqual(f.opened, [], "die Formprüfung kostet keine Sonde");
  // A missing path is the root of the share, not a failure.
  assert.equal((await f.service.list(REF, { path: undefined })).ok, true);
});

test("die Liste trägt die Obergrenze des Uploads im Umschlag", async () => {
  const f = fixture({ share: SHARE });
  const result = await f.service.list(REF, { path: "fotos" });
  assert.equal(result.ok, true);
  assert.ok("maxUploadBytes" in result && result.maxUploadBytes === MAX_UPLOAD_BYTES);
  const asked = f.calls[0];
  assert.equal(asked?.method, "listFiles");
  // The share comes from the store, the caller from the session.
  assert.deepEqual(asked?.args[2], { share: SHARE, path: "fotos" });
  assert.deepEqual((asked?.args[3] as { actor: unknown }).actor, { kind: "user", id: "admin-1" });
});

// ── 3. Die benannten Antworten des Agenten behalten ihren Grund ─────────────

test("benannte Antworten des Agenten bleiben Daten und behalten Status und Grund", async () => {
  const named: { error: AgentError; status: number; code: string; reason: string | null }[] = [
    { error: new AgentError("zu viele", 429), status: 429, code: "too-many-streams", reason: null },
    {
      error: new AgentError("nur lesen", 503, { detail: { error: "agent-read-only" } }),
      status: 503,
      code: "agent-read-only",
      reason: "agent-read-only"
    },
    {
      error: new AgentError("nicht geführt", 404, { detail: { error: "not-allowlisted" } }),
      status: 403,
      code: "agent-forbidden",
      reason: "not-allowlisted"
    },
    {
      error: new AgentError("abgelehnt", 400, { detail: { error: "path-traversal" } }),
      status: 400,
      code: "agent-rejected",
      reason: "path-traversal"
    }
  ];
  for (const { error, status, code, reason } of named) {
    const f = fixture({ share: SHARE, fail: () => error });
    const result = await f.service.list(REF, { path: "" });
    const failure = failureOf(result);
    // The error itself travels on; the table that reads it is the one of
    // `platform/http/agent-error-translation.ts`.
    assert.deepEqual(failure, { kind: "agent-error", error });
    const answer = answerFor(failure);
    assert.equal(answer.status, status, `${error.message}: Status`);
    assert.equal(answer.body.error, code, `${error.message}: Kennung`);
    assert.equal(answer.body.reason ?? null, reason, `${error.message}: Grund des Agenten`);
  }
});

test("die Ablehnung wegen Pfad-Traversal wird kein 502", async () => {
  const f = fixture({
    share: SHARE,
    fail: (method) => (method === "readFileText" ? new AgentError("abgelehnt", 400, { detail: { error: "path-traversal" } }) : null)
  });
  const answer = answerFor(failureOf(await f.service.readText(REF, { path: "../etc/passwd" })));
  assert.equal(answer.status, 400);
  assert.notEqual(answer.body.error, "agent-unreachable");
  assert.equal(answer.body.reason, "path-traversal");
});

test("was kein Fehler des Agenten ist, wird nicht verschluckt", async () => {
  const f = fixture({ share: SHARE, fail: () => new TypeError("ein Fehler des Hubs") });
  await assert.rejects(f.service.list(REF, { path: "" }), TypeError);
});

// ── 4. Der Download ─────────────────────────────────────────────────────────

test("ein Download ohne Pfad ist ein Fehler des Aufrufers und fragt den Agenten nicht", async () => {
  const f = fixture({ share: SHARE });
  const failure = failureOf(await f.service.planDownload(REF, { path: "" }));
  assert.equal(answerFor(failure).status, 400);
  assert.deepEqual(f.calls, []);
});

test("der Download öffnet den Agentenstrom erst beim Start und reicht das Signal weiter", async () => {
  const f = fixture({ share: SHARE });
  const plan = await f.service.planDownload(REF, { path: "fotos/a.txt" });
  assert.ok(plan.ok);
  assert.equal(plan.path, "fotos/a.txt");
  assert.equal(f.calls.length, 0, "vor dem Start wurde der Agent nicht gefragt");

  const controller = new AbortController();
  const download = await plan.start(controller.signal);
  assert.equal(download.size, 3);
  const options = f.calls[0]?.args[3] as { signal?: AbortSignal };
  assert.equal(options.signal, controller.signal);
});

// ── 5. Upload und Speichern ─────────────────────────────────────────────────

test("ein Upload ohne Namen oder als JSON wird abgewiesen, bevor die Kette läuft", async () => {
  const f = fixture({ share: SHARE });
  for (const name of [undefined, "", ["a"]]) {
    const failure = failureOf(await f.service.planUpload(REF, { path: "", name, jsonBody: false }));
    assert.equal(answerFor(failure).status, 400);
  }
  const json = failureOf(await f.service.planUpload(REF, { path: "", name: "neu.bin", jsonBody: true }));
  assert.equal(answerFor(json).status, 415);
  assert.equal(answerFor(json).body.error, "invalid-content-type");
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.calls, []);
});

test("ein Upload mit leerem Rumpf ist eine leere Datei und geht durch", async () => {
  const f = fixture({ share: SHARE });
  const plan = await f.service.planUpload(REF, { path: "fotos", name: "leer.bin", jsonBody: false });
  assert.ok(plan.ok);
  assert.equal(plan.maxBytes, MAX_UPLOAD_BYTES);
  assert.equal(plan.tooLarge.kind === "problem" && plan.tooLarge.status, 413);

  const result = await plan.send(Buffer.alloc(0));
  assert.equal(result.ok, true);
  const asked = f.calls[0];
  assert.equal(asked?.method, "uploadFile");
  // Directory and name go out separately.
  assert.deepEqual(asked?.args[2], { share: SHARE, path: "fotos", name: "leer.bin" });
  assert.equal((asked?.args[3] as Uint8Array).length, 0);
});

test("das Speichern verlangt den Hash, lehnt JSON ab und trägt die Obergrenze des Textes", async () => {
  const f = fixture({ share: SHARE });
  for (const expectedHash of [undefined, "", 5]) {
    const failure = failureOf(await f.service.planTextSave(REF, { path: "a.txt", expectedHash, jsonBody: false }));
    assert.equal(answerFor(failure).status, 400);
  }
  const json = failureOf(await f.service.planTextSave(REF, { path: "a.txt", expectedHash: "h-1", jsonBody: true }));
  assert.equal(answerFor(json).status, 415);
  assert.deepEqual(f.opened, []);

  const plan = await f.service.planTextSave(REF, { path: "a.txt", expectedHash: "h-1", jsonBody: false });
  assert.ok(plan.ok);
  assert.equal(plan.maxBytes, MAX_TEXT_BYTES);
  assert.notEqual(plan.maxBytes, MAX_UPLOAD_BYTES);
});

test("ein leerer Text wird gespeichert und nicht mit einem fehlenden Rumpf verwechselt", async () => {
  const f = fixture({ share: SHARE });
  const plan = await f.service.planTextSave(REF, { path: "a.txt", expectedHash: "h-1", jsonBody: false });
  assert.ok(plan.ok);
  const result = await plan.send(Buffer.alloc(0));
  assert.deepEqual(result, { ok: true, hash: "h-2" });
  const edit = f.calls[0]?.args[3] as { content: string; expectedHash: string };
  assert.deepEqual(edit, { content: "", expectedHash: "h-1" });
});

test("ungültiges UTF-8 wird abgelehnt und nicht still ersetzt", async () => {
  const f = fixture({ share: SHARE });
  const plan = await f.service.planTextSave(REF, { path: "a.txt", expectedHash: "h-1", jsonBody: false });
  assert.ok(plan.ok);
  const result = await plan.send(Buffer.from([0x68, 0xff, 0xfe, 0x69]));
  const failure = failureOf(result);
  assert.equal(answerFor(failure).status, 400);
  assert.equal(answerFor(failure).body.error, "invalid-encoding");
  assert.deepEqual(f.calls, [], "die kaputten Bytes dürfen den Agenten nicht erreichen");
});

test("der Konflikt kommt mit Grund und jetzigem Hash zurück und ist kein Fehlschlag", async () => {
  const f = fixture({ share: SHARE, saved: { ok: false, reason: "file-changed-externally", hash: "h-jetzt" } });
  const plan = await f.service.planTextSave(REF, { path: "a.txt", expectedHash: "h-1", jsonBody: false });
  assert.ok(plan.ok);
  const result = await plan.send(Buffer.from("neu"));
  assert.deepEqual(result, { ok: false, conflict: { reason: "file-changed-externally", hash: "h-jetzt" } });
});

// ── 6. Anlegen, umbenennen, entfernen ───────────────────────────────────────

test("die eigenen Aktionsnamen werden auf die Werte des Agenten übersetzt", async () => {
  const f = fixture({ share: SHARE });
  const result = await f.service.applyAction(REF, { action: "create-directory", path: "fotos", name: "assets" });
  assert.deepEqual(result, { ok: true, done: { name: "assets", kind: "directory" } });
  const asked = f.calls[0];
  assert.equal(asked?.method, "applyFileAction");
  assert.equal(asked?.args[2], SHARE);
  assert.deepEqual(asked?.args[3], { action: "create-folder", path: "fotos", name: "assets" });
  // `delete` carries no name, and none is invented.
  await f.service.applyAction(REF, { action: "delete", path: "fotos/a.txt" });
  assert.deepEqual(f.calls[1]?.args[3], { action: "delete", path: "fotos/a.txt" });
  assert.deepEqual(f.opened, ["writes", "writes"]);
});

test("eine Aktion mit falscher Form kostet weder die Kette noch den Agenten", async () => {
  const f = fixture({ share: SHARE });
  const bodies: unknown[] = [
    null,
    {},
    { action: "create-folder", path: "" },
    { action: "create-directory" },
    { action: "rename", path: "a", name: "" },
    { action: "rename", path: "a", name: 3 }
  ];
  for (const body of bodies) {
    const failure = failureOf(await f.service.applyAction(REF, body));
    assert.equal(answerFor(failure).status, 400);
  }
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.calls, []);
});

test("source IDs reuse existing CRUD forwarding without requiring a project share", async () => {
  const f = fixture();
  const query = { sourceId: "source-opaque", path: "file.txt" };
  assert.equal((await f.service.list(REF, query)).ok, true);
  assert.equal((await f.service.readText(REF, query)).ok, true);
  const download = await f.service.planDownload(REF, query);
  assert.equal(download.ok, true);
  if (download.ok) await download.start(new AbortController().signal);
  const write = await f.service.planTextSave(REF, { ...query, expectedHash: "hash", jsonBody: false });
  assert.equal(write.ok, true);
  if (write.ok) await write.send(Buffer.from("content"));
  assert.equal((await f.service.applyAction(REF, { ...query, action: "rename", name: "renamed.txt" })).ok, true);
  assert.equal(f.calls.every((call) => JSON.stringify(call.args).includes("source-opaque")), true);
  assert.equal(f.store.share, null);
  assert.equal((await f.service.list(REF, { sourceId: "", path: "" })).ok, false);
});
