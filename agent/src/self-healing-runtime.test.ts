import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import test, { after } from "node:test";
import { selfHealingStatusResponseSchema, HUB_RUNTIME_TIMEOUT_MS, RUNTIME_TRANSPORT_RESERVE_MS, SELF_HEALING_SYSTEM_ACTOR, type ExpectedContainer } from "contract";
import { EngineError, type RawInspect } from "./engine.js";
import { truncateField, type AuditEntry } from "./audit.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "healing-runtime-test-"));
process.env.DOCKER_AGENT_SECRET = "s".repeat(64);
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(directory, "registry.json");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(directory, "monitors.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(directory, "audit.jsonl");
process.env.DOCKER_AGENT_BIND_BASE_PATH = "/srv/apps";
const { engine, registry, config, audit, stackLocks, selfHealingState, selfHealingConfig, stopIntents, dockerEvents } = await import("./runtime/state.js");
const { selfHealing } = await import("./runtime/self-healing.js");
const { runContainerAction } = await import("./container-action.js");
const { handleRequest } = await import("./dispatch.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

class Response extends EventEmitter {
  status = 0; headersSent = false; destroyed = false;
  body = ""; headers: Record<string, string> = {};
  writeHead(status: number, headers: Record<string, string> = {}) { this.status = status; this.headersSent = true; Object.assign(this.headers, headers); }
  setHeader(name: string, value: string) { this.headers[name] = value; }
  end(body = "") { this.body = body; }
}
async function call(method: string, url: string, body?: unknown, actor: string | null = "demo-operator", authenticated = true) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]), {
    method, url, headers: { ...(authenticated ? { "x-docker-agent-secret": process.env.DOCKER_AGENT_SECRET } : {}),
      ...(actor === null ? {} : { "x-docker-agent-actor": actor }) }
  });
  const response = new Response();
  await handleRequest(request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse);
  return { status: response.status, body: JSON.parse(response.body), headers: response.headers };
}
const id = "a".repeat(64);
function fixture(t: test.TestContext, options: { project?: boolean; external?: boolean; delegation?: boolean } = {}) {
  let current: RawInspect = { Id: id, Name: "/demo-web", RestartCount: 0,
    Config: { Env: ["PASSWORD=synthetic-password"], Labels: options.project ? {
      "com.docker.compose.project": "demo", "com.docker.compose.service": "web",
      "com.docker.compose.project.working_dir": "/srv/apps/demo", "com.docker.compose.project.config_files": "/srv/apps/demo/compose.yaml"
    } : {} }, HostConfig: { RestartPolicy: { Name: "no" }, ...(options.delegation ? { Privileged: true } : {}) },
    State: { Status: "running", Running: true, StartedAt: new Date().toISOString(), ExitCode: 0 } };
  registry.replaceAll([{ containerId: id, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true, externallyManaged: options.external,
    ...(options.project ? { compose: { projectDir: "/srv/apps/demo", projectName: "demo", serviceName: "web", composeFileName: "compose.yaml", origin: "adopted" } } : {}) }]);
  selfHealingState.change((state) => { state.entries = []; state.maintenance = []; state.incidents = []; });
  selfHealingConfig.write({ enabled: true, attempts: 1, retryDelaysSeconds: [1], stabilityWindowSeconds: 600, maintenanceDurationSeconds: 3600 });
  selfHealing.setObserving(true); selfHealing.reconcile(current);
  const records: AuditEntry[] = [];
  t.mock.method(audit, "write", (entry: AuditEntry) => { records.push(entry); });
  t.mock.method(engine, "inspect", async () => structuredClone(current));
  t.mock.method(engine, "listWithComposeLabels", async () => [{ id, name: "demo-web", image: "example/app:1.0", status: current.State!.Status!, labels: current.Config!.Labels! }]);
  let starts = 0;
  t.mock.method(engine, "start", async () => {
    starts++;
    current = { ...current, State: { ...current.State, Running: true, Status: "running", StartedAt: new Date(Date.now() + starts).toISOString() } };
    selfHealing.observe({ containerId: id, action: "start" }, current, null);
  });
  const crash = () => {
    current.State = { ...current.State, Running: false, Status: "exited", ExitCode: 1, Error: "engine synthetic-password" };
    const event = { containerId: id, action: "die" as const };
    selfHealing.observe(event, current, stopIntents.observe(event, current));
    const entry = selfHealingState.entries()[0]; entry.pending!.dueAt = 0; selfHealingState.put(entry);
  };
  t.after(() => { selfHealing.setObserving(false); });
  return { get current() { return current; }, records, starts: () => starts, crash, expected: (): ExpectedContainer => ({
    containerId: id, status: current.State!.Status!, startedAt: current.State!.StartedAt!
  }) };
}

for (const external of [false, true]) test(`healer runs the shared container mutation path and audits exactly once: external=${external}`, async (t) => {
  const f = fixture(t, { external }); f.crash(); await selfHealing.tick();
  assert.equal(f.starts(), 1); assert.equal(f.records.length, 1);
  assert.equal(f.records[0].action, "start"); assert.equal(f.records[0].actor, "system:self-healing"); assert.equal(f.records[0].outcome, "allowed");
  assert.equal(selfHealingState.entries()[0].attempts.length, 1);
});

for (const gate of ["allowlist", "observe-only", "self-management", "read-only"] as const) test(`actual ${gate} gate heals nothing and creates no incident`, async (t) => {
  const f = fixture(t);
  if (gate === "read-only") t.mock.property(config, "readOnly", true);
  if (gate === "allowlist") registry.replaceAll([]);
  if (gate === "observe-only") registry.replaceAll([{ containerId: id, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true, observeOnly: true }]);
  if (gate === "self-management") {
    f.current.Config!.Labels = { "com.docker.compose.project.working_dir": "/home/docker/dashboard-state" };
  }
  f.crash(); await selfHealing.tick();
  assert.equal(f.starts(), 0); assert.equal(selfHealingState.entries()[0].attempts.length, 0);
  assert.deepEqual(selfHealingState.status(selfHealingConfig.read(), true, Date.now()).incidents, []);
});

test("engine diagnostics stay in one audit with delegation evidence before truncation", async (t) => {
  const f = fixture(t, { delegation: true });
  t.mock.method(engine, "start", async () => { throw new EngineError(`engine responded 503: ${"diagnostic ".repeat(50)}`, 503); });
  f.crash(); await selfHealing.tick();
  assert.equal(f.records.length, 1); assert.equal(f.records[0].outcome, "error");
  assert.match(truncateField(f.records[0].reason!)!, /^engine-action-failed; delegation-lock-allowed:.*; diagnostic/);
  assert.equal(JSON.stringify(selfHealingState.entries()[0].attempts).includes("diagnostic"), false);
  assert.equal(selfHealingState.entries()[0].attempts[0].error, "engine-action-failed");
});

test("queued healing follows a simultaneous manual action and rejects its changed state", async (t) => {
  const f = fixture(t, { project: true }); f.crash();
  let release: () => void = () => {}; let entered: () => void = () => {};
  const inLock = new Promise<void>((resolve) => { entered = resolve; });
  const holding = stackLocks.runExclusive("demo", async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await inLock;
  let queued = 0;
  const run = stackLocks.runExclusive.bind(stackLocks);
  t.mock.method(stackLocks, "runExclusive", (key: string, operation: () => Promise<unknown>, options?: { waitMs: number; signal?: AbortSignal }) => {
    queued++; return run(key, operation, options);
  });
  const manual = runContainerAction(id, "start", f.expected(), "demo-operator");
  const waitForQueue = async (count: number) => {
    const deadline = Date.now() + 2000;
    while (queued < count) {
      if (Date.now() >= deadline) throw new Error("Synthetic action did not enter the shared queue");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  t.after(() => release());
  await waitForQueue(1);
  const pending = selfHealing.tick();
  await waitForQueue(2);
  release(); await holding; assert.equal((await manual).status, 200); await pending;
  assert.equal(f.starts(), 1); assert.equal(selfHealingState.entries()[0].attempts.length, 0);
  assert.equal(f.records.length, 2);
  assert.equal(f.records[0].actor, "demo-operator"); assert.equal(f.records[0].outcome, "allowed");
  assert.equal(f.records[1].actor, "system:self-healing"); assert.equal(f.records[1].outcome, "denied");
  assert.match(f.records[1].reason!, /state-changed/);
});

test("manual container handler and healer share the same expected-state boundary", async (t) => {
  const f = fixture(t); f.crash();
  const result = await runContainerAction(id, "start", { ...f.expected(), startedAt: "stale" }, "demo-operator");
  assert.equal(result.status, 409); assert.equal(result.body.error, "state-changed"); assert.equal(f.starts(), 0);
  assert.equal(f.records.length, 1); assert.equal(f.records[0].outcome, "denied");
});

test("incident logs are gathered and redacted by the production adapter", async (t) => {
  const f = fixture(t);
  t.mock.method(engine, "logs", async (_id: string, tail: number, tty: boolean) => {
    assert.equal(tail, 50); assert.equal(tty, false); return Buffer.from("failure synthetic-password\n");
  });
  f.crash(); await selfHealing.tick(); f.crash(); await selfHealing.tick();
  const incident = selfHealingState.status(selfHealingConfig.read(), true, Date.now()).incidents[0];
  assert.deepEqual(incident.logs, { available: true, lines: ["failure ••••"] });
  assert.equal(incident.cause.engineError, "engine ••••"); assert.equal(f.records.length, 1);
});

test("status is authenticated, uncacheable, schema-complete and returns 503 without observation", async (t) => {
  const f = fixture(t); t.mock.method(dockerEvents, "isObserving", () => false);
  assert.equal((await call("GET", "/self-healing/status", undefined, "demo-operator", false)).status, 401);
  f.records.length = 0;
  const unavailable = await call("GET", "/self-healing/status"); assert.equal(unavailable.status, 503);
  assert.equal(selfHealingStatusResponseSchema.parse(unavailable.body).observing, false);
  assert.equal(unavailable.headers["cache-control"], "no-store"); assert.equal(f.records.length, 1);
  t.mock.method(dockerEvents, "isObserving", () => true);
  const available = await call("GET", "/self-healing/status"); assert.equal(available.status, 200);
  selfHealingStatusResponseSchema.parse(available.body);
});

test("maintenance routes store default and unlimited duration in read-only mode with one audit each", async (t) => {
  const f = fixture(t); t.mock.property(config, "readOnly", true);
  const target = selfHealingState.entries()[0].target;
  let result = await call("PUT", "/self-healing/maintenance", { target }, "system:hub");
  assert.equal(result.status, 200); assert.equal(f.records.length, 1);
  let maintenance = selfHealingState.status(selfHealingConfig.read(), true, Date.now()).maintenance[0];
  assert.equal(Date.parse(maintenance.expiresAt!) - Date.parse(maintenance.startedAt), 3_600_000);
  result = await call("PUT", "/self-healing/maintenance", { target, durationSeconds: null });
  assert.equal(result.status, 200); assert.equal(f.records.length, 2);
  maintenance = selfHealingState.status(selfHealingConfig.read(), true, Date.now()).maintenance[0]; assert.equal(maintenance.expiresAt, null);
  assert.equal((await call("DELETE", "/self-healing/maintenance", { target })).status, 200);
  assert.equal(f.records.length, 3); assert.equal(f.starts(), 0);
  assert.deepEqual(selfHealingState.status(selfHealingConfig.read(), true, Date.now()).maintenance, []);
});

for (const [body, actor, status, error] of [
  ["{broken", "system:hub", 400, "invalid-json"],
  [{ target: { kind: "stack", projectName: "demo" }, durationSeconds: 1 }, "system:hub", 400, "invalid-request"],
  [{ target: { kind: "stack", projectName: "demo" } }, "system:monitor", 403, "actor-not-allowed"],
  [{ target: { kind: "stack", projectName: "demo" } }, null, 403, "actor-not-allowed"]
] as const) test(`maintenance rejects invalid input or actor exactly once: ${error}/${actor}`, async (t) => {
  const f = fixture(t); const result = await call("PUT", "/self-healing/maintenance", body, actor);
  assert.equal(result.status, status); assert.equal(result.body.error, error); assert.equal(f.records.length, 1);
  assert.equal(f.records[0].outcome, "denied"); assert.equal(f.starts(), 0);
});

test("acknowledgement closes an incident, refills and never starts", async (t) => {
  const f = fixture(t); t.mock.method(engine, "logs", async () => Buffer.from("synthetic log"));
  f.crash(); await selfHealing.tick(); f.crash(); await selfHealing.tick();
  f.records.length = 0;
  const target = selfHealingState.entries()[0].target;
  const result = await call("POST", "/self-healing/incidents/acknowledge", { target });
  assert.equal(result.status, 200); assert.equal(f.starts(), 1); assert.equal(f.records.length, 1);
  assert.equal(selfHealingState.entries()[0].attempts.length, 0);
  assert.equal(selfHealingState.status(selfHealingConfig.read(), true, Date.now()).incidents[0].closedReason, "acknowledged");
});

test("control storage failures forward only a stable error and audit the diagnosis once", async (t) => {
  const f = fixture(t);
  t.mock.method(selfHealingState, "setMaintenance", () => { throw new Error("private storage diagnostic"); });
  const result = await call("PUT", "/self-healing/maintenance", { target: { kind: "stack", projectName: "demo" } });
  assert.equal(result.status, 500); assert.deepEqual(result.body, { error: "internal-error" });
  assert.equal(f.records.length, 1); assert.equal(f.records[0].outcome, "error"); assert.match(f.records[0].reason!, /private storage diagnostic/);
});


test("production incident omits logs when the confirmed environment cannot be read", async (t) => {
  const f = fixture(t, { project: true });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === "/srv/apps/demo/.env") throw Object.assign(new Error("synthetic read refused"), { code: "EACCES" });
    return read(...args);
  });
  t.mock.method(engine, "logs", async () => { throw new Error("logs must not be fetched without redaction"); });
  f.crash(); await selfHealing.tick(); f.crash(); await selfHealing.tick();
  const incident = selfHealingState.status(selfHealingConfig.read(), true, Date.now()).incidents[0];
  assert.deepEqual(incident.logs, { available: false, reason: "redaction-unavailable" });
  assert.equal(incident.cause.engineError, null);
});

for (const access of ["not-allowlisted", "observe-only", "read-only"] as const) {
  test(`production healer allocates no budget for initially excluded containers: ${access}`, (t) => {
    const f = fixture(t);
    selfHealingState.change((state) => { state.entries = []; });
    if (access === "read-only") {
      const previous = config.readOnly; config.readOnly = true; t.after(() => { config.readOnly = previous; });
    } else t.mock.method(registry, "checkAccess", () => access);
    selfHealing.reconcile(f.current);
    selfHealing.observe({ containerId: id, action: "die", exitCode: 1 }, f.current, "unexpected");
    assert.deepEqual(selfHealingState.entries(), []); assert.equal(f.starts(), 0);
  });
}

for (const phase of ["gate", "mutation"] as const) test(`autonomous start bounds a stalled ${phase} without a hub caller`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const f = fixture(t); f.crash();
  let signal: AbortSignal | undefined;
  const stall = async (options?: { signal?: AbortSignal; timeoutMs?: number }) => {
    signal = options?.signal;
    assert.equal(options?.timeoutMs, HUB_RUNTIME_TIMEOUT_MS - RUNTIME_TRANSPORT_RESERVE_MS);
    return new Promise<never>(() => {});
  };
  if (phase === "gate") t.mock.method(engine, "inspect", async (_id: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => stall(options));
  else t.mock.method(engine, "start", async (_id: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => stall(options));
  const pending = runContainerAction(id, "start", f.expected(), SELF_HEALING_SYSTEM_ACTOR);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  t.mock.timers.tick(HUB_RUNTIME_TIMEOUT_MS - RUNTIME_TRANSPORT_RESERVE_MS);
  const result = await pending;
  assert.equal(result.status, 504);
  assert.equal(result.body.error, "runtime-deadline-exceeded");
  assert.equal(result.mutationStarted, phase === "mutation");
  assert.equal(signal?.aborted, true);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].outcome, phase === "mutation" ? "error" : "denied");
  assert.equal(f.records[0].actor, SELF_HEALING_SYSTEM_ACTOR);
});
