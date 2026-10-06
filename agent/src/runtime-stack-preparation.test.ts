import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ActionQueueError } from "./concurrency.js";
import type { RuntimeAction, RuntimeServiceResult } from "contract";
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
const { config, engine, registry, audit, stackLocks } = await import("./runtime/state.js");
const { runStackRuntimeAction } = await import("./runtime/stack-action.js");
const { handleStackAction } = await import("./routes/stack-routes.js");
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
    destroyed: false, status: 0, headers: {} as Record<string, string>, body: {} as Record<string, unknown>,
    writeHead(code: number, headers: Record<string, string>) { this.status = code; this.headers = headers; },
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

for (const reason of ["agent-read-only", "self-management-locked", "observe-only", "not-allowlisted"]) {
  test(`container gate denial ${reason} is audited`, async (t) => {
    mockEngine(t);
    if (reason === "agent-read-only") {
      config.readOnly = true;
      t.after(() => { config.readOnly = false; });
    } else if (reason === "self-management-locked") {
      t.mock.method(engine, "inspect", async () => ({ ...inspect(), Config: {
        ...inspect().Config, Labels: { ...labels, "com.docker.compose.project.working_dir": "/home/docker/dashboard-repo" }
      } }));
    } else registry.replaceAll([{ ...entry, observeOnly: reason === "observe-only", allowed: reason !== "not-allowlisted" }]);
    const records: Array<Record<string, unknown>> = [];
    t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
    let starts = 0;
    t.mock.method(engine, "start", async () => { starts++; });
    const req = containerRequest("start");
    await handleSafeAction(req.context);
    assert.equal(starts, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, "start");
    assert.equal(records[0].containerId, "old");
    assert.equal(records[0].outcome, "denied");
    assert.equal(String(records[0].reason).startsWith(reason), true);
  });
}

for (const reason of ["action-queue-timeout", "action-caller-disconnected"] as const) {
  test(`container queue rejection ${reason} is audited even after disconnect`, async (t) => {
    mockEngine(t);
    const records: Array<Record<string, unknown>> = [];
    t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
    const req = containerRequest("start");
    t.mock.method(stackLocks, "runExclusive", async () => {
      req.response.destroyed = reason === "action-caller-disconnected";
      throw new ActionQueueError(reason);
    });
    await handleSafeAction(req.context);
    assert.deepEqual(records.map(({ outcome, reason }) => ({ outcome, reason })), [{ outcome: "denied", reason }]);
    assert.equal(req.response.status, reason === "action-caller-disconnected" ? 0 : 409);
  });
}

test("a gate denied after queueing is audited as denied", async (t) => {
  mockEngine(t);
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
  let reads = 0;
  t.mock.method(engine, "inspect", async () => {
    if (++reads === 1) registry.replaceAll([{ ...entry, observeOnly: true }]);
    return inspect();
  });
  const req = containerRequest("start");
  await handleSafeAction(req.context);
  assert.equal(req.response.body.error, "observe-only");
  assert.equal(records.at(-1)?.outcome, "denied");
  assert.equal(records.at(-1)?.reason, "observe-only");
});

for (const action of ["start", "stop", "restart"]) {
  test(`scaled service rejects container ${action} before mutation and audits the endpoint error`, async (t) => {
    mockEngine(t);
    t.mock.method(engine, "listWithComposeLabels", async () => [...inventory(), ...inventory("replica")]);
    let mutations = 0;
    for (const name of ["start", "stop", "restart"] as const) t.mock.method(engine, name, async () => { mutations++; });
    const records: Array<Record<string, unknown>> = [];
    t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
    const req = containerRequest(action);
    await handleSafeAction(req.context);
    assert.equal(mutations, 0);
    assert.equal(req.response.status, 409);
    assert.equal(req.response.body.error, "scaled-service-unsupported");
    assert.equal(records.at(-1)?.outcome, "denied");
    assert.equal(records.at(-1)?.reason, "scaled-service-unsupported");
  });
}

function mockCompose(t: TestContext, execute: (args: string[], done: () => void) => void = (_args, done) => done()) {
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    execute(args, () => callback(null, args.includes("config") ? JSON.stringify({ services: { web: { image: "example/app:1.0" } } }) : "", ""));
    return {} as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function expectedStack() {
  return { projectName: "app", projectDir, composeFileName: "compose.yaml",
    services: [{ serviceName: "web", containerId: "old", status: "exited", startedAt: "seen" }] };
}

for (const action of ["start", "restart"] as RuntimeAction[]) for (const applyDefinition of [false, true]) {
  test(`runtime wiring emits the actual safe up arguments for ${action}, definition ${applyDefinition}`, async (t) => {
    mockEngine(t);
    t.mock.method(engine, "imageId", async () => "local-image");
    const commands: string[][] = [];
    mockCompose(t, (args, done) => { commands.push(args); done(); });
    await runStackRuntimeAction(stackProjectFromRegistry("old"), "old", action,
      { expectedStack: expectedStack(), applyDefinition }, null, new AbortController().signal);
    const up = commands.filter((args) => args.includes("up"));
    assert.equal(up.length, 1);
    assert.deepEqual(up[0], ["compose", "--project-directory", projectDir, "--file", `${projectDir}/compose.yaml`,
      "--project-name", "app", "up", "--detach", "--no-build", ...(!applyDefinition ? ["--no-recreate"] : []),
      "--pull", "never", ...(applyDefinition && action === "restart" ? ["--force-recreate"] : [])]);
    const mutations = commands.filter((args) => args.includes("stop") || args.includes("up") || args.includes("start"));
    assert.equal(mutations.length, action === "restart" && !applyDefinition ? 2 : 1);
    if (mutations.length === 2) assert.equal(mutations[0].at(-1), "stop");
  });
}

test("runtime polling reports Restarting consistently with the final read", { timeout: 5000 }, async (t) => {
  mockEngine(t);
  registry.replaceAll([{ ...entry, externallyManaged: true }]);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let starting!: () => void;
  const started = new Promise<void>((resolve) => { starting = resolve; });
  let done!: () => void;
  let restarting = false;
  mockCompose(t, (args, complete) => {
    if (args.at(-1) === "start") { done = complete; restarting = true; starting(); }
    else complete();
  });
  t.mock.method(engine, "inspect", async () => ({ ...inspect(), State: {
    ...inspect().State, Status: restarting ? "running" : "exited", Restarting: restarting
  } }));
  let observed!: () => void;
  const progressSeen = new Promise<void>((resolve) => { observed = resolve; });
  const progress: RuntimeServiceResult[] = [];
  const run = runStackRuntimeAction(stackProjectFromRegistry("old"), "old", "start",
    { expectedStack: expectedStack(), applyDefinition: false }, null, new AbortController().signal,
    { onProgress: (service) => { progress.push(service); if (service.status === "restarting") observed(); } });
  await started;
  t.mock.timers.tick(1000);
  await progressSeen;
  restarting = false;
  done();
  await run;
  assert.equal(progress.some((service) => service.status === "restarting" && service.outcome === "failed"), true);
});

function stackRequest(action: string, body: Record<string, unknown>, accept?: string) {
  const req = containerRequest(action);
  req.context.request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),
    { headers: { accept }, aborted: false }) as unknown as http.IncomingMessage;
  req.context.url = new URL(`http://agent.invalid/stacks/old/actions/${action}`);
  return req;
}

for (const action of ["apply", "down", "stop"]) {
  test(`stack ${action} accepts a request without applyDefinition and responds synchronously to NDJSON accept`, async (t) => {
    mockEngine(t);
    mockCompose(t);
    const req = stackRequest(action, { expectedStack: expectedStack(), confirmation: "app" }, "application/x-ndjson");
    if (action === "stop") req.context.request.headers.accept = undefined;
    await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    assert.equal(req.response.status, 200);
    assert.equal(req.response.body.ok, true);
    assert.equal(req.response.headers["content-type"], "application/json; charset=utf-8");
  });
}

for (const action of ["start", "restart"]) {
  test(`stack ${action} still requires applyDefinition`, async (t) => {
    mockEngine(t);
    const req = stackRequest(action, { expectedStack: expectedStack() });
    await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    assert.equal(req.response.status, 400);
    assert.equal(req.response.body.field, "applyDefinition");
  });
}

for (const action of ["apply", "down"]) {
  test(`stack ${action} keeps stack-expectation-mismatch for changed runtime state`, async (t) => {
    mockEngine(t);
    mockCompose(t);
    const stack = expectedStack();
    stack.services[0].status = "running";
    const req = stackRequest(action, { expectedStack: stack, confirmation: "app" });
    await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    assert.equal(req.response.status, 409);
    assert.equal(req.response.body.error, "stack-expectation-mismatch");
  });
}
