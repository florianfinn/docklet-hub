import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { RuntimeActionFailure } from "./action-failure.js";
import { ActionQueueError } from "./concurrency.js";
import { stackActionStreamLineSchema, type RuntimeAction, type RuntimeServiceResult } from "contract";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type http from "node:http";
import { EngineError } from "./engine.js";
import { ComposeError } from "./compose-cli.js";
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
const { handleStackAction, handleStackContext } = await import("./routes/stack-routes.js");
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

function mockCompose(t: TestContext, execute: (args: string[], done: (error?: Error) => void) => void = (_args, done) => done()) {
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    execute(args, (error) => callback(error ?? null, args.includes("config") ? JSON.stringify({ services: { web: { image: "example/app:1.0" } } }) : "", error?.message ?? ""));
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

for (const stale of [false, true]) test(`queued stack route emits waiting before ${stale ? "a preflight refusal" : "starting"}`, { timeout: 5000 }, async (t) => {
  mockEngine(t);
  mockCompose(t);
  let release!: () => void;
  const active = stackLocks.runExclusive("app", () => new Promise<void>((resolve) => { release = resolve; }));
  t.after(async () => { release(); await active; });
  const stack = expectedStack();
  if (stale) stack.services[0].status = "running";
  const req = stackRequest("stop-stream", { expectedStack: stack });
  let queued!: () => void;
  const waiting = new Promise<void>((resolve) => { queued = resolve; });
  const lines: unknown[] = [];
  const response = Object.assign(req.response, {
    headersSent: false, writableEnded: false, writableLength: 0, status: 0, headers: {} as Record<string, string>,
    writeHead(code: number, headers: Record<string, string>) {
      assert.equal(this.headersSent, false);
      this.status = code; this.headers = headers; this.headersSent = true;
    },
    write(chunk: string) {
      const line = stackActionStreamLineSchema.parse(JSON.parse(chunk));
      lines.push(line);
      if (line.kind === "queued") queued();
      return true;
    },
    end() { this.writableEnded = true; }
  });
  req.context.response = response as unknown as http.ServerResponse;
  const pending = handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
  await waiting;
  assert.deepEqual(lines, [{ kind: "queued" }]);
  release();
  await Promise.all([active, pending]);
  const terminal = stackActionStreamLineSchema.parse(lines.at(-1));
  if (stale) {
    assert.equal(terminal.kind, "error");
    assert.equal(terminal.kind === "error" && terminal.reason, "state-changed");
    assert.equal(terminal.kind === "error" && terminal.status, 409);
  } else {
    assert.equal(lines.some((line) => stackActionStreamLineSchema.parse(line).kind === "start"), true);
    assert.equal(terminal.kind, "result");
  }
});

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

function recordAudit(t: TestContext) {
  const records: Array<Parameters<typeof audit.write>[0]> = [];
  t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
  return records;
}

for (const source of ["inventory", "inspect", "unknown"] as const) {
  test(`container preflight ${source} failure is audited before the response without mutation`, async (t) => {
    mockEngine(t);
    const records = recordAudit(t);
    const failure = source === "unknown" ? new Error("inventory unavailable") :
      new EngineError('engine responded 500: {"message":"inventory unavailable"}', 500);
    if (source === "inspect") {
      let reads = 0;
      t.mock.method(engine, "inspect", async () => { if (++reads === 3) throw failure; return inspect(); });
    } else t.mock.method(engine, "listWithComposeLabels", async () => { throw failure; });
    let mutations = 0;
    t.mock.method(engine, "start", async () => { mutations++; });
    const req = containerRequest("start");
    const end = req.response.end.bind(req.response);
    t.mock.method(req.response, "end", (payload: string) => { assert.equal(records.length, 1); end(payload); });
    await handleSafeAction(req.context);
    assert.equal(mutations, 0);
    assert.equal(req.response.status, 500);
    assert.equal(req.response.body.error, source === "unknown" ? "internal-error" : "engine-action-failed");
    assert.deepEqual(records.map(({ outcome, reason }) => ({ outcome, reason })), [{ outcome: "denied",
      reason: source === "unknown" ? "internal-error; Error: inventory unavailable" : "engine-action-failed; inventory unavailable" }]);
  });
}

for (const failure of ["name-mismatch", "project-mismatch", "registry-reanchor-failed"] as const) {
  test(`container preflight ${failure} returns an audited anchor conflict`, async (t) => {
    mockEngine(t);
    const records = recordAudit(t);
    t.mock.method(engine, "listWithComposeLabels", async () => inventory("new"));
    t.mock.method(engine, "inspect", async (id: string) => ({ ...inspect(id),
      ...(id === "new" && failure === "name-mismatch" ? { Name: "/other-web-1" } : {}),
      ...(id === "new" && failure === "project-mismatch" ? { Config: { ...inspect(id).Config,
        Labels: { ...labels, "com.docker.compose.project": "other" } } } : {}) }));
    if (failure === "registry-reanchor-failed") t.mock.method(registry, "replaceContainerId", () => false);
    let mutations = 0;
    t.mock.method(engine, "start", async () => { mutations++; });
    const req = containerRequest("start");
    await handleSafeAction(req.context);
    const code = failure === "registry-reanchor-failed" ? failure : "container-anchor-mismatch";
    assert.equal(mutations, 0);
    assert.equal(req.response.status, 409);
    assert.equal(req.response.body.error, code);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "denied");
    assert.equal(records[0].reason, code);
  });
}

for (const failure of [new EngineError("start refused by engine", 409), new ComposeError("start refused by Compose", "private tool output", 7)]) {
  test(`container ${failure.name} keeps the full audit reason after mutation begins`, async (t) => {
    mockEngine(t);
    const records = recordAudit(t);
    let mutations = 0;
    t.mock.method(engine, "start", async () => { mutations++; throw failure; });
    const req = containerRequest("start");
    await handleSafeAction(req.context);
    const compose = failure instanceof ComposeError;
    assert.equal(mutations, 1);
    assert.equal(req.response.status, compose ? 502 : 409);
    assert.equal(req.response.body.error, compose ? "compose-action-failed" : "engine-action-failed");
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "error");
    assert.equal(records[0].reason, compose ? "compose-action-failed; (exit 7): start refused by Compose; stderr: private tool output" : "engine-action-failed; start refused by engine");
    assert.equal("auditReason" in req.response.body, false);
    assert.equal(JSON.stringify(req.response.body).includes("private tool output"), false);
  });
}

for (const action of ["apply-stream", "down-stream"]) {
  test(`stack ${action} is rejected before any project or Compose access`, async (t) => {
    mockEngine(t);
    let calls = 0;
    t.mock.method(engine, "listWithComposeLabels", async () => { calls++; return inventory(); });
    mockCompose(t, (_args, done) => { calls++; done(); });
    const req = stackRequest(action, { expectedStack: expectedStack(), confirmation: "app" });
    await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    assert.equal(req.response.status, 400);
    assert.equal(req.response.body.error, "invalid-stack-action");
    assert.equal(calls, 0);
  });
}

for (const reason of ["state-changed", "compose-config-failed", "runtime-image-missing", "stack-service-gate-denied", "stack-service-not-allowlisted", "externally-managed", "action-queue-timeout", "action-caller-disconnected"] as const) {
  test(`stack runtime preflight ${reason} is audited as denied without mutation`, async (t) => {
    mockEngine(t);
    const records = recordAudit(t);
    const commands: string[][] = [];
    if (reason === "stack-service-not-allowlisted") t.mock.method(engine, "listWithComposeLabels", async () => [
      ...inventory(), { ...inventory("neighbour")[0], labels: { ...labels, "com.docker.compose.service": "job" } }
    ]);
    mockCompose(t, (args, done) => {
      commands.push(args);
      done(reason === "compose-config-failed" && args.includes("config") ? new Error("definition unreadable") : undefined);
    });
    t.mock.method(engine, "imageId", async () => {
      if (reason === "externally-managed") registry.replaceAll([{ ...entry, externallyManaged: true }]);
      if (reason === "stack-service-gate-denied") registry.replaceAll([{ ...entry, observeOnly: true }]);
      return reason === "runtime-image-missing" ? null : "local-image";
    });
    if (reason === "action-queue-timeout" || reason === "action-caller-disconnected") {
      t.mock.method(stackLocks, "runExclusive", async () => { throw new ActionQueueError(reason); });
    }
    const stack = expectedStack();
    if (reason === "state-changed") stack.services[0].status = "running";
    const req = stackRequest("start", { expectedStack: stack, applyDefinition: false });
    await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    assert.equal(req.response.status, reason === "compose-config-failed" ? 502 : reason.startsWith("stack-service-") || reason === "externally-managed" ? 403 : 409);
    assert.equal(req.response.body.error, reason === "compose-config-failed" ? "compose-action-failed" : reason);
    assert.equal(commands.some((args) => args.includes("up") || args.includes("start") || args.includes("stop")), false);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "denied");
    if (reason === "compose-config-failed") assert.match(String(records[0].reason), /stderr: definition unreadable/);
    else assert.equal(records[0].reason, reason);
    assert.equal("mutationStarted" in req.response.body, false);
  });
}

test("stack runtime unreadable state after a successful command is audited as error", async (t) => {
  mockEngine(t);
  const records = recordAudit(t);
  t.mock.method(engine, "imageId", async () => "local-image");
  let mutations = 0;
  mockCompose(t, (args, done) => { if (args.includes("up")) mutations++; done(); });
  t.mock.method(engine, "listWithComposeLabels", async () => {
    if (mutations) throw new EngineError("inventory unavailable", 500);
    return inventory();
  });
  const req = stackRequest("start", { expectedStack: expectedStack(), applyDefinition: false });
  await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
  assert.equal(mutations, 1);
  assert.equal(req.response.status, 500);
  assert.equal(req.response.body.error, "engine-action-failed");
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "error");
  assert.equal(records[0].reason, "engine-action-failed; inventory unavailable");
});

for (const action of ["start", "stop", "restart"] as const) {
  test(`stack runtime ${action} CLI failure after mutation begins is audited as error`, async (t) => {
    mockEngine(t);
    const records = recordAudit(t);
    t.mock.method(engine, "imageId", async () => "local-image");
    let mutations = 0;
    mockCompose(t, (args, done) => {
      if (args.includes("config")) done();
      else { mutations++; done(new Error("mutation failed")); }
    });
    const req = stackRequest(action, { expectedStack: expectedStack(), ...(action === "stop" ? {} : { applyDefinition: true }) });
    await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    assert.equal(mutations, 1);
    assert.equal(req.response.status, 502);
    assert.equal(req.response.body.error, "compose-action-failed");
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, "error");
    assert.match(String(records[0].reason), /compose-action-failed; \(exit \?\).*stderr: mutation failed/);
    assert.equal("mutationStarted" in req.response.body, false);
  });
}

for (const status of [404, 500]) test(`stack restart annotation handles disappearing container inspect ${status}`, async (t) => {
  mockEngine(t);
  registry.replaceAll([{ ...entry, externallyManaged: true }]);
  const commands: string[][] = [];
  mockCompose(t, (args, done) => { commands.push(args); done(); });
  const operation = runStackRuntimeAction(stackProjectFromRegistry("old"), "old", "restart",
    { expectedStack: expectedStack(), applyDefinition: false }, null, new AbortController().signal,
    { onStart: () => {
      let first = true;
      t.mock.method(engine, "inspect", async () => {
        if (first) { first = false; throw new EngineError("synthetic vanished container", status); }
        return { ...inspect(), State: { ...inspect().State, Running: true, Status: "running" } };
      });
    } });
  if (status === 404) assert.equal((await operation).status, 200);
  else await assert.rejects(operation, (error: unknown) => error instanceof RuntimeActionFailure
    && error.failure.body.error === "engine-action-failed" && error.failure.status === 500);
  const mutations = commands.filter((args) => args.includes("stop") || args.includes("start"));
  assert.equal(mutations.length, status === 404 ? 2 : 0);
});

for (const action of ["apply", "down", "context"]) {
  test(`non-runtime ${action} maps unreadable Compose config to 409 without mutation`, async (t) => {
    mockEngine(t);
    const commands: string[][] = [];
    mockCompose(t, (args, done) => { commands.push(args); done(new Error("synthetic config failure")); });
    const req = stackRequest(action, { expectedStack: expectedStack(), confirmation: "app" });
    if (action === "context") {
      req.context.url = new URL("http://agent.invalid/stacks/old/context");
      await handleStackContext(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/context$/)!);
    } else {
      await handleStackAction(req.context, req.context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
    }
    assert.equal(req.response.status, 409);
    assert.deepEqual(req.response.body, { error: "compose-config-failed" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].includes("config"), true);
  });
}
