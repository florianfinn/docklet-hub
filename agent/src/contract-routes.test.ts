import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after, type TestContext } from "node:test";
import { ACTOR_HEADER, SECRET_HEADER, fileSourcesResponseSchema, backupListResponseSchema,
  agentJobStartResponseSchema, agentJobResponseSchema, agentJobCancelResponseSchema,
  shareQuerySchema, fileUploadQuerySchema, updatePreviewRequestSchema, restorePreviewRequestSchema,
  SHARED_HTTP_ERRORS } from "contract";
import { AGENT_CONTRACT, CONTRACT_VERSION } from "./contract.js";
import { DEFINITION_ACTIONS, findRoute } from "./route-policy.js";
import { type RawInspect } from "./engine.js";
import type { gate } from "./runtime/gate.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contract-routes-test-"));
const secret = "s".repeat(64);
process.env.DOCKER_AGENT_SECRET = secret;
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(directory, "registry.json");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(directory, "monitors.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(directory, "audit.jsonl");
process.env.DOCKER_AGENT_BIND_BASE_PATH = "/srv/apps";
const { handleRequest } = await import("./dispatch.js");
const { registry, engine, config, audit } = await import("./runtime/state.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const id = "a".repeat(64);
const otherId = "b".repeat(64);
const target = { kind: "container", containerName: "demo" };
const expectedContainer = { containerId: id, status: "running", startedAt: "seen" };
const service = { target, expectedContainer, startDeadlineSeconds: 120, backup: null,
  offeredDigest: `sha256:${"c".repeat(64)}`, definitionHash: "hash" };
const updateBody = { previewId: "preview", target, services: [service], confirmed: true };
const updatePreviewBody = { target, services: [{ target, expectedContainer, startDeadlineSeconds: 120,
  backup: { mode: "stop", mounts: [{ sourceId: "data", estimatedBytes: 42 }] } }] };
const restorePreviewBody = { target, backupId: "backup", mounts: [{ sourceId: "data" }] };
const restoreBody = { previewId: "preview", target, expectedContainer, backupId: "backup",
  mounts: [{ sourceId: "data" }], startDeadlineSeconds: 120, confirmed: true };

class Response extends EventEmitter {
  headersSent = false;
  status = 0;
  payload = "";
  writeHead(status: number) { this.status = status; this.headersSent = true; }
  end(payload: string) { this.payload = payload; }
  body() { return JSON.parse(this.payload) as Record<string, unknown>; }
}

async function request(method: string, url: string, body?: unknown, authorized = true, raw?: string) {
  const input = Object.assign(Readable.from(raw !== undefined ? [Buffer.from(raw)]
    : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url, headers: { ...(authorized ? { [SECRET_HEADER]: secret } : {}), [ACTOR_HEADER]: "demo-operator" }
  }) as unknown as http.IncomingMessage;
  const response = new Response();
  await handleRequest(input, response as unknown as http.ServerResponse);
  return response;
}

function fixture(t: TestContext, flags: { observeOnly?: boolean; externallyManaged?: boolean } = {}, own = false) {
  registry.replaceAll([{ containerId: id, containerName: "demo", imageRef: "example/app:1.0", allowed: true,
    ...flags, compose: { projectDir: "/srv/apps/demo", projectName: "demo", serviceName: "web",
      composeFileName: "compose.yaml", origin: "dashboard" } }]);
  t.mock.property(config, "readOnly", false);
  t.mock.method(engine, "inspect", async (containerId: string) => ({ Id: containerId, Name: "/demo",
    Config: { Labels: own ? { "com.docker.compose.project.working_dir": "/home/docker/dashboard-repo" } : {} },
    HostConfig: {}, State: { Status: "running", StartedAt: "seen" }
  } satisfies RawInspect));
  const records: Parameters<typeof audit.write>[0][] = [];
  t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
  return records;
}

const routes = [
  ["POST", "/update-previews", false, "update-preview", "update", updatePreviewBody],
  ["POST", "/updates", true, "update", "update", updateBody],
  ["GET", `/containers/${id}/backups`, false, "backups", "backups", undefined],
  ["POST", "/restore-previews", false, "restore-preview", "restore", restorePreviewBody],
  ["POST", "/restores", true, "restore", "restore", restoreBody],
  ["GET", "/jobs", false, "jobs", undefined, undefined],
  ["GET", "/jobs/job", false, "job-progress", undefined, undefined],
  ["POST", "/jobs/job/cancel", true, "job-cancel", "job-cancel", undefined]
] as const;

for (const [method, url, mutating, action, gate, body] of routes) {
  test(`${method} ${url}: policy, authentication, audited 501 stub`, async (t) => {
    const records = fixture(t);
    const policy = findRoute(method, url.split("?")[0]);
    assert.equal(policy?.mutating, mutating);
    assert.equal(policy?.audit, action);
    assert.equal(policy?.gate, gate);
    assert.equal(policy?.public, undefined);
    assert.equal((await request(method, url, body, false)).status, 401);
    const response = await request(method, url, body);
    assert.equal(response.status, 501);
    assert.deepEqual(response.body(), { error: "not-implemented" });
    assert.equal(records.at(-1)?.action, action);
    assert.equal(records.at(-1)?.reason, "not-implemented");
  });
}

for (const [method, url, mutating, , gate, body] of routes.filter((route) => route[4] !== undefined && route[4] !== "job-cancel")) {
  for (const denial of ["not-allowlisted", "externally-managed", "observe-only", "agent-read-only", "self-management-locked"] as const) {
    if (!mutating && ["observe-only", "agent-read-only", "self-management-locked"].includes(denial)) continue;
    if (denial === "externally-managed" && !DEFINITION_ACTIONS.has(gate!)) continue;
    test(`${method} ${url}: ${denial} precedes stub`, async (t) => {
      fixture(t, { observeOnly: denial === "observe-only", externallyManaged: denial === "externally-managed" },
        denial === "self-management-locked");
      if (denial === "agent-read-only") config.readOnly = true;
      if (denial === "not-allowlisted") registry.replaceAll([]);
      const response = await request(method, url, body);
      assert.equal(response.status, denial === "not-allowlisted" ? 404 : denial === "agent-read-only" ? 503 : 403);
      assert.equal(String(response.body().error).split(":")[0], denial);
    });
  }
}

test("job cancellation checks kill switch before unresolved job target", async (t) => {
  fixture(t);
  config.readOnly = true;
  t.mock.method(engine, "inspect", async () => { throw new Error("unresolved job must not inspect Docker"); });
  const response = await request("POST", "/jobs/job/cancel");
  assert.equal(response.status, 503);
  assert.deepEqual(response.body(), { error: "agent-read-only" });
});

test("update preview and start gate every selected service", async (t) => {
  fixture(t);
  const entry = registry.get(id)!;
  registry.replaceAll([entry, { ...entry, containerId: otherId, externallyManaged: true,
    compose: { ...entry.compose!, serviceName: "worker" } }]);
  const secondTarget = { kind: "compose", projectName: "demo", serviceName: "worker" };
  const stackBody = { ...updateBody, target: { kind: "stack", projectName: "demo" }, services: [
    { ...service, target: { ...secondTarget, serviceName: "web" } },
    { ...service, target: secondTarget, expectedContainer: { ...expectedContainer, containerId: otherId } }
  ] };
  const deniedEntry = registry.get(otherId)!;
  registry.replaceAll([entry, { ...deniedEntry, externallyManaged: false }]);
  const inspected: string[] = [];
  t.mock.method(engine, "inspect", async (containerId: string) => {
    inspected.push(containerId);
    return { Id: containerId, Name: "/demo", Config: {}, HostConfig: {} } satisfies RawInspect;
  });
  for (const url of ["/updates", "/update-previews"]) {
    inspected.length = 0;
    assert.equal((await request("POST", url, stackBody)).status, 501);
    assert.deepEqual(inspected, [id, otherId]);
  }
  registry.replaceAll([entry, deniedEntry]);
  for (const [method, url, body] of [["POST", "/updates", stackBody], ["POST", "/update-previews", stackBody]] as const) {
    const response = await request(method, url, body);
    assert.equal(response.status, 403);
    assert.equal(response.body().error, "externally-managed");
  }
});

test("invalid bodies and queries fail validation before stub; jobs target is JSON encoded", async (t) => {
  fixture(t);
  for (const [method, url, body] of [
    ["POST", "/updates", {}], ["POST", "/restores", {}],
    ["POST", "/update-previews", {}], ["POST", "/restore-previews", {}],
    ["GET", "/jobs?kind=backup", undefined], ["GET", "/jobs?target=invalid", undefined],
    ["GET", "/jobs?target=%7B%7D", undefined]
  ] as const) {
    const response = await request(method, url, body);
    assert.equal(response.status, 400);
    assert.equal(response.body().error, "invalid-request");
  }
  for (const url of ["/updates", "/restores", "/update-previews", "/restore-previews"]) {
    assert.equal((await request("POST", url, undefined, true, "{")).body().error, "invalid-json");
  }
  const response = await request("GET", `/jobs?target=${encodeURIComponent(JSON.stringify(target))}&kind=update`);
  assert.equal(response.status, 501);
});

test("contract 13 exposes route response shapes, optional file source selection and shared 501", () => {
  assert.equal(CONTRACT_VERSION, 13);
  assert.equal(AGENT_CONTRACT.fileAccess.queryFields.sourceId, "optional");
  assert.equal(AGENT_CONTRACT.fileAccess.uploadQueryFields.sourceId, "optional");
  for (const schema of [shareQuerySchema, fileUploadQuerySchema]) {
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(schema.parse({ sourceId: "data" }).sourceId, "data");
    assert.equal(schema.safeParse({ sourceId: "" }).success, false);
  }
  assert.deepEqual(Object.keys(fileSourcesResponseSchema.shape), ["sources"]);
  assert.deepEqual(Object.keys(backupListResponseSchema.shape), ["target", "backups"]);
  assert.deepEqual(Object.keys(agentJobResponseSchema.shape), ["progress"]);
  assert.deepEqual(Object.keys(agentJobCancelResponseSchema.shape), ["jobId", "accepted"]);
  assert.deepEqual(agentJobStartResponseSchema.parse({ jobId: "job" }), { jobId: "job" });
  assert.equal(agentJobStartResponseSchema.safeParse({ jobId: "job", result: {} }).success, false);
  assert.ok(AGENT_CONTRACT.errors.sharedHttp.some((error) => error.status === 501 && error.code === "not-implemented"));
});


test("nine coordinated routes replace all three GET preview paths", async (t) => {
  fixture(t);
  assert.equal(routes.length + 1, 9);
  assert.ok(findRoute("GET", `/containers/${id}/file-sources`));
  for (const url of [`/containers/${id}/update-preview`, `/projects/${id}/update-preview`,
    `/containers/${id}/restore-preview?backupId=backup`]) {
    assert.equal(findRoute("GET", url.split("?")[0]), null);
    assert.equal((await request("GET", url)).status, 404);
  }
  for (const url of ["/update-previews", "/restore-previews"]) {
    assert.equal(findRoute("GET", url), null);
    assert.equal((await request("GET", url)).status, 404);
  }
});

for (const [url, schema, body] of [
  ["/update-previews", updatePreviewRequestSchema, updatePreviewBody],
  ["/restore-previews", restorePreviewRequestSchema, restorePreviewBody]
] as const) {
  test(`${url} accepts every body field and remains non-mutating under kill switch`, async (t) => {
    fixture(t, { observeOnly: true }, true);
    config.readOnly = true;
    assert.deepEqual(schema.parse(body), body);
    assert.equal((await request("POST", url, body)).status, 501);
  });
}

for (const [field, body] of [
  ["services", { ...updatePreviewBody, services: [] }],
  ["target", { ...updatePreviewBody, target: { ...target, containerName: "other" } }],
  ["startDeadlineSeconds", { ...updatePreviewBody, services: [{ ...updatePreviewBody.services[0], startDeadlineSeconds: 0 }] }],
  ["backup", { ...updatePreviewBody, services: [{ ...updatePreviewBody.services[0], backup: { mode: "stop", mounts: [] } }] }],
  ["expectedContainer", { ...updatePreviewBody, services: [{ ...updatePreviewBody.services[0], expectedContainer: undefined }] }]
] as const) {
  test(`update preview rejects invalid ${field} before Docker inspection`, async (t) => {
    fixture(t);
    t.mock.method(engine, "inspect", async () => { throw new Error("invalid request must not inspect Docker"); });
    const response = await request("POST", "/update-previews", body);
    assert.equal(response.status, 400);
    assert.equal(response.body().error, "invalid-request");
  });
}

for (const [field, body] of [
  ["mounts missing", { target, backupId: "backup" }],
  ["mounts empty", { ...restorePreviewBody, mounts: [] }],
  ["mounts duplicated", { ...restorePreviewBody, mounts: [{ sourceId: "data" }, { sourceId: "data" }] }],
  ["sourceId", { ...restorePreviewBody, mounts: [{ sourceId: "" }] }],
  ["backupId", { ...restorePreviewBody, backupId: "" }],
  ["target", { ...restorePreviewBody, target: {} }]
] as const) {
  test(`restore preview rejects invalid ${field} before Docker inspection`, async (t) => {
    fixture(t);
    t.mock.method(engine, "inspect", async () => { throw new Error("invalid request must not inspect Docker"); });
    const response = await request("POST", "/restore-previews", body);
    assert.equal(response.status, 400);
    assert.equal(response.body().error, "invalid-request");
  });
}

test("restore preview resolves compose service and rejects unknown stable targets", async (t) => {
  fixture(t);
  const entry = registry.get(id)!;
  registry.replaceAll([{ ...entry, containerId: otherId }]);
  const inspected: string[] = [];
  t.mock.method(engine, "inspect", async (containerId: string) => {
    inspected.push(containerId);
    return { Id: containerId, Name: "/demo", Config: {}, HostConfig: {} } satisfies RawInspect;
  });
  const compose = { kind: "compose", projectName: "demo", serviceName: "web" };
  assert.equal((await request("POST", "/restore-previews", { ...restorePreviewBody, target: compose })).status, 501);
  assert.deepEqual(inspected, [otherId]);
  for (const unknown of [{ ...compose, serviceName: "missing" }, { ...compose, projectName: "missing" },
    { ...target, containerName: "missing" }]) {
    const response = await request("POST", "/restore-previews", { ...restorePreviewBody, target: unknown });
    assert.equal(response.status, 404);
    assert.equal(response.body().error, "not-allowlisted");
  }
  assert.deepEqual(inspected, [otherId]);
});

for (const mixed of [false, true]) {
  test(`cancel stub fails closed on observer class, mixed registry=${mixed}`, async (t) => {
    fixture(t, { observeOnly: true });
    if (mixed) registry.replaceAll([registry.get(id)!, { ...registry.get(id)!, containerId: otherId, observeOnly: false }]);
    t.mock.method(engine, "inspect", async () => { throw new Error("cancel stub must not inspect Docker"); });
    const response = await request("POST", "/jobs/job/cancel");
    assert.equal(response.status, 403);
    assert.deepEqual(response.body(), { error: "observe-only" });
    config.readOnly = true;
    assert.deepEqual((await request("POST", "/jobs/job/cancel")).body(), { error: "agent-read-only" });
  });
}

test("unresolved jobs reveal no list or progress payload", async (t) => {
  fixture(t);
  registry.replaceAll([]);
  for (const url of ["/jobs", "/jobs/job"]) {
    const response = await request("GET", url);
    assert.equal(response.status, 501);
    assert.deepEqual(response.body(), { error: "not-implemented" });
  }
});

test("preview request shapes are exact contract values and gate requires a container ID", async () => {
  const requiresContainerId: Parameters<typeof gate>[0] extends string ? true : false = true;
  assert.equal(requiresContainerId, true);
  assert.deepEqual(AGENT_CONTRACT.updates.previewRequestFields, { target: "required", services: "required" });
  assert.deepEqual(AGENT_CONTRACT.updates.selectionFields,
    { target: "required", expectedContainer: "required", startDeadlineSeconds: "required", backup: "required" });
  assert.deepEqual(AGENT_CONTRACT.backups.restorePreviewFields,
    { target: "required", backupId: "required", mounts: "required" });
  assert.equal("restorePreviewQueryFields" in AGENT_CONTRACT.backups, false);
  const contract = await import("contract");
  assert.equal("restorePreviewQuerySchema" in contract, false);
});

test("not-implemented follows the unchanged shared HTTP error sequence", () => {
  assert.deepEqual(SHARED_HTTP_ERRORS.at(-1), { status: 501, code: "not-implemented" });
  assert.deepEqual(SHARED_HTTP_ERRORS.slice(0, -1).map((entry) => entry.code),
    ["invalid-request", "invalid-json", "unauthorized", "actor-not-allowed", "observe-only", "externally-managed",
      "too-many-streams", "too-many-sessions"]);
});

test("file source discovery authenticates, checks the allowlist and returns contract 13", async (t) => {
  fixture(t);
  t.mock.method(engine, "listContainerIds", async () => [id]);
  const url = `/containers/${id}/file-sources`;
  assert.equal((await request("GET", url, undefined, false)).status, 401);
  const allowed = await request("GET", url);
  assert.equal(allowed.status, 200);
  assert.equal(fileSourcesResponseSchema.safeParse(allowed.body()).success, true);
  registry.replaceAll([]);
  assert.equal((await request("GET", url)).status, 404);
});

test("every file mutation immediately rejects a held Compose project lock", async (t) => {
  fixture(t);
  const { stackLocks } = await import("./runtime/state.js");
  let release!: () => void;
  const active = stackLocks.runExclusive("demo", () => new Promise<void>((resolve) => { release = resolve; }));
  try {
    for (const [method, endpoint] of [["PUT", "file"], ["PUT", "file-text"], ["POST", "files"], ["PUT", "env"]]) {
      const response = await request(method, `/containers/${id}/${endpoint}`, {});
      assert.equal(response.status, 409, endpoint);
      assert.equal(response.body().error, "busy", endpoint);
    }
  } finally { release(); await active; }
});
