import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type http from "node:http";
import { EngineError } from "./engine.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-preparation-"));
process.env.DOCKER_AGENT_SECRET = "s".repeat(32);
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(directory, "registry.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(directory, "audit.ndjson");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(directory, "monitor.json");
process.env.DOCKER_AGENT_BIND_BASE_PATH = "/srv/apps";
const { handleSafeAction } = await import("./routes/definition-routes.js");
const { engine, registry, audit } = await import("./runtime/state.js");
const { prepareStack, stackProjectFromRegistry, reanchorStackRegistry, ensureCreateScopeNotExternallyManaged, StackEndpointError } = await import("./runtime/stack.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const projectDir = "/srv/apps/app";
const labels = { "com.docker.compose.project": "app", "com.docker.compose.service": "web",
  "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": `${projectDir}/compose.yaml` };
const entry = { containerId: "old", containerName: "app-web-1", imageRef: "example/app:1.0", allowed: true,
  compose: { projectDir, projectName: "app", serviceName: "web", composeFileName: "compose.yaml", origin: "dashboard" } };
const inspect = (id = "old") => ({ Id: id, Name: "/app-web-1", Config: { Labels: labels, Image: "example/app:1.0", StopTimeout: 90 },
  State: { Status: "exited", StartedAt: "seen", ExitCode: 0, Health: { Status: "unhealthy" } } });
const inventory = (id = "old", extraLabels = {}) => [{ id, name: "app-web-1", image: "example/app:1.0", status: "exited", labels: { ...labels, ...extraLabels } }];

function mockEngine(t: TestContext) {
  t.mock.method(engine, "listWithComposeLabels", async () => inventory());
  t.mock.method(engine, "inspect", async (id: string) => inspect(id));
  t.mock.method(audit, "write", () => {});
  registry.replaceAll([entry]);
}

test("unknown foreign labels lock creation even when the registry has not marked it", async (t) => {
  mockEngine(t);
  t.mock.method(engine, "listWithComposeLabels", async () => inventory("old", { "net.unraid.docker.managed": "other-manager" }));
  const prepared = await prepareStack(stackProjectFromRegistry("old"), { mutating: true, action: "start", actor: null },
    async () => ({ services: { web: { image: "example/app:1.0" }, job: { image: "example/job:1.0" } } }));
  assert.equal(prepared.externallyManaged, true);
  assert.deepEqual(prepared.context.missingServices, ["job"]);
  assert.throws(() => ensureCreateScopeNotExternallyManaged(prepared), (error: unknown) => error instanceof StackEndpointError && error.code === "externally-managed");
});

test("unreadable foreign definitions retain exactly the current service inventory", async (t) => {
  mockEngine(t);
  registry.replaceAll([{ ...entry, externallyManaged: true }]);
  const prepared = await prepareStack(stackProjectFromRegistry("old"), { mutating: true, action: "start", actor: null, tolerateUnreadableDefinition: true },
    async () => { throw new Error("unreadable"); });
  assert.equal(prepared.definitionReadable, false);
  assert.equal(prepared.context.services.length, 1);
  assert.equal(prepared.context.services[0].exitCode, 0);
  assert.equal(prepared.context.services[0].health, "unhealthy");
  assert.equal(prepared.context.services[0].stopTimeoutSeconds, 90);
  assert.deepEqual(prepared.context.missingServices, []);
});

test("an unauthorized project neighbour still blocks the entire runtime action", async (t) => {
  mockEngine(t);
  t.mock.method(engine, "listWithComposeLabels", async () => [
    ...inventory(), { ...inventory("neighbour")[0], name: "app-job-1", labels: { ...labels, "com.docker.compose.service": "job" } }
  ]);
  await assert.rejects(prepareStack(stackProjectFromRegistry("old"), { mutating: true, action: "stop", actor: null },
    async () => ({ services: { web: {}, job: {} } })),
  (error: unknown) => error instanceof StackEndpointError && error.code === "stack-service-not-allowlisted");
});

test("reanchor preserves grants under fresh ids after a failed creating path", async (t) => {
  mockEngine(t);
  const prepared = await prepareStack(stackProjectFromRegistry("old"), { mutating: true, action: "start", actor: null },
    async () => ({ services: { web: { image: "example/app:1.0" } } }));
  t.mock.method(engine, "listWithComposeLabels", async () => inventory("new"));
  await reanchorStackRegistry(prepared);
  assert.equal(registry.isAllowed("old"), false);
  assert.equal(registry.isAllowed("new"), true);
  assert.equal(registry.get("new")?.compose?.serviceName, "web");
});

function containerRequest(action: string, status = "exited") {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ expectedContainer: { containerId: "old", status, startedAt: "seen" } }))]),
    { headers: {}, aborted: false }) as unknown as http.IncomingMessage;
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, status: 0, body: {} as Record<string, unknown>,
    writeHead(code: number) { this.status = code; },
    end(payload: string) { this.body = JSON.parse(payload) as Record<string, unknown>; }
  });
  return { request, response, context: { request, response: response as unknown as http.ServerResponse,
    url: new URL(`http://agent.invalid/containers/old/${action}`), actor: null, containerId: "old", action } };
}

test("foreign container actions use only the engine and return a fresh state", async (t) => {
  mockEngine(t);
  registry.replaceAll([{ ...entry, externallyManaged: true }]);
  let current = inspect();
  t.mock.method(engine, "inspect", async () => current);
  let starts = 0;
  t.mock.method(engine, "start", async () => { starts++; current = { ...current, State: { ...current.State, Status: "running" } }; });
  const req = containerRequest("start");
  await handleSafeAction(req.context);
  assert.equal(starts, 1);
  assert.equal(req.response.status, 200);
  assert.equal((req.response.body.state as { status: string }).status, "running");
});

test("container handler reports fresh failure state even with no readable Compose definition", async (t) => {
  mockEngine(t);
  let current = inspect();
  t.mock.method(engine, "inspect", async () => current);
  t.mock.method(engine, "start", async () => {
    current = { ...current, State: { ...current.State, ExitCode: 2 } };
    throw new EngineError("start refused", 409);
  });
  const req = containerRequest("start");
  await handleSafeAction(req.context);
  assert.equal(req.response.status, 409);
  assert.equal(req.response.body.error, "engine-action-failed");
  assert.equal((req.response.body.state as { exitCode: number }).exitCode, 2);
});

test("revocation during a fresh gate never reaches the container engine mutation", async (t) => {
  mockEngine(t);
  let reads = 0;
  let starts = 0;
  t.mock.method(engine, "inspect", async () => {
    if (++reads === 2) registry.replaceAll([{ ...entry, allowed: false }]);
    return inspect();
  });
  t.mock.method(engine, "start", async () => { starts++; });
  const req = containerRequest("start");
  await handleSafeAction(req.context);
  assert.equal(starts, 0);
  assert.equal(req.response.status, 403);
});
