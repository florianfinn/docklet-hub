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
  shareQuerySchema, fileUploadQuerySchema } from "contract";
import { AGENT_CONTRACT, CONTRACT_VERSION } from "./contract.js";
import { DEFINITION_ACTIONS, findRoute } from "./route-policy.js";
import { type RawInspect } from "./engine.js";

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
  ["GET", `/containers/${id}/file-sources`, false, "file-sources", "file-sources", undefined],
  ["GET", `/containers/${id}/update-preview`, false, "update-preview", "update", undefined],
  ["GET", `/projects/${id}/update-preview`, false, "update-preview", "update", undefined],
  ["POST", "/updates", true, "update", "update", updateBody],
  ["GET", `/containers/${id}/backups`, false, "backups", "backups", undefined],
  ["GET", `/containers/${id}/restore-preview?backupId=backup`, false, "restore-preview", "restore", undefined],
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

for (const [method, url, , , gate, body] of routes.filter((route) => route[4] !== undefined && route[4] !== "job-cancel")) {
  for (const denial of ["not-allowlisted", "externally-managed", "observe-only", "agent-read-only", "self-management-locked"] as const) {
    const mutating = method === "POST";
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

test("update start gates every selected service and project preview gates every registry member", async (t) => {
  fixture(t);
  const entry = registry.get(id)!;
  registry.replaceAll([entry, { ...entry, containerId: otherId, externallyManaged: true,
    compose: { ...entry.compose!, serviceName: "worker" } }]);
  const secondTarget = { kind: "compose", projectName: "demo", serviceName: "worker" };
  const stackBody = { ...updateBody, target: { kind: "stack", projectName: "demo" }, services: [
    { ...service, target: { ...secondTarget, serviceName: "web" } },
    { ...service, target: secondTarget, expectedContainer: { ...expectedContainer, containerId: otherId } }
  ] };
  for (const [method, url, body] of [["POST", "/updates", stackBody], ["GET", `/projects/${id}/update-preview`, undefined]] as const) {
    const response = await request(method, url, body);
    assert.equal(response.status, 403);
    assert.equal(response.body().error, "externally-managed");
  }
});

test("invalid bodies and queries fail validation before stub; jobs target is JSON encoded", async (t) => {
  fixture(t);
  for (const [method, url, body] of [
    ["POST", "/updates", {}], ["POST", "/restores", {}],
    ["GET", `/containers/${id}/restore-preview`, undefined],
    ["GET", `/containers/${id}/restore-preview?backupId=`, undefined],
    ["GET", "/jobs?kind=backup", undefined], ["GET", "/jobs?target=invalid", undefined],
    ["GET", "/jobs?target=%7B%7D", undefined]
  ] as const) {
    const response = await request(method, url, body);
    assert.equal(response.status, 400);
    assert.equal(response.body().error, "invalid-request");
  }
  for (const url of ["/updates", "/restores"]) {
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
