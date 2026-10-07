import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import test, { after, type TestContext } from "node:test";
import { HUB_RUNTIME_TIMEOUT_MS, RUNTIME_TRANSPORT_RESERVE_MS, type RuntimeAction } from "contract";
import { loadAgentModule } from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { runContainer, runStack } from "./agent-client.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-budget-"));
Object.assign(process.env, {
  DOCKER_AGENT_SECRET: "s".repeat(32),
  DOCKER_AGENT_REGISTRY_FILE: path.join(directory, "registry.json"),
  DOCKER_AGENT_AUDIT_FILE: path.join(directory, "audit.ndjson"),
  DOCKER_AGENT_MONITOR_FILE: path.join(directory, "monitor.json"),
  DOCKER_AGENT_BIND_BASE_PATH: "/srv/apps"
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

type CallOptions = { timeoutMs?: number; signal?: AbortSignal };
type Raw = { Id: string; Name: string; Config: { Labels: Record<string, string>; Image: string; StopTimeout: number };
  Mounts: Array<{ Type: string; Name: string; Destination: string }>; State: { Status: string; Running: boolean; StartedAt: string; ExitCode: number } };
type Context = { request: http.IncomingMessage; response: http.ServerResponse; actor: null;
  containerId: string; action: RuntimeAction; url: URL };
type RecordEntry = { containerId: string; containerName: string; imageRef: string; allowed: boolean;
  externallyManaged: boolean; compose: { projectDir: string; projectName: string; serviceName: string; composeFileName: string; origin: string } };
type Audit = { outcome: string; reason?: string };
const { engine, registry, audit, stackLocks } = await loadAgentModule<{
  engine: { inspect: (id: string, options?: CallOptions) => Promise<Raw>; inspectVolume: (name: string, options?: CallOptions) => Promise<unknown>;
    listWithComposeLabels: (options?: CallOptions) => Promise<unknown>; imageId: (ref: string, options?: CallOptions) => Promise<string | null>;
    start: (id: string, options?: CallOptions) => Promise<void>;
    stop: (id: string, grace?: number | null, options?: CallOptions) => Promise<void>;
    restart: (id: string, grace?: number | null, options?: CallOptions) => Promise<void> };
  registry: { replaceAll: (entries: RecordEntry[]) => void };
  audit: { write: (record: Audit) => void };
  stackLocks: { runExclusive: (key: string, operation: () => Promise<unknown>, options?: { waitMs: number; onQueued?: () => void }) => Promise<unknown> };
}>("runtime/state.ts");
const { handleSafeAction } = await loadAgentModule<{ handleSafeAction: (ctx: Context) => Promise<void> }>("routes/definition-routes.ts");
const { handleStackAction } = await loadAgentModule<{ handleStackAction: (ctx: Context, match: RegExpMatchArray) => Promise<void> }>("routes/stack-routes.ts");

const envelope = HUB_RUNTIME_TIMEOUT_MS - RUNTIME_TRANSPORT_RESERVE_MS;
const actions: RuntimeAction[] = ["start", "stop", "restart"];
const phases = ["gate", "volumes", "queue", "inventory", "config", "image", "mutation", "reanchor", "readback", "observation", "restart-inspect", "cumulative"] as const;
type Phase = typeof phases[number];
type Cell = { scope: "container" | "own-stack" | "foreign-stack"; transport: "sync" | "stream";
  action: RuntimeAction; phase: Phase; services?: number; engineMs?: number; mutationMs?: number; volumes?: number; readbackAt?: "config" | "gate" | "volumes" };
const matrix: Cell[] = (["container", "own-stack", "foreign-stack"] as const).flatMap((scope) =>
  (["sync", "stream"] as const).flatMap((transport) => actions.flatMap((action) => phases.flatMap((phase): Cell[] => {
    if (scope === "container" && (transport === "stream" || ["config", "image", "reanchor", "observation", "restart-inspect"].includes(phase))) return [];
    if (phase === "image" && (scope === "foreign-stack" || action === "stop")) return [];
    if (phase === "observation" && transport === "sync") return [];
    if (phase === "restart-inspect" && action !== "restart") return [];
    return [{ scope, transport, action, phase }];
  }))));

class ResponseSink extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; this.headersSent = true; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
}

function fixture(t: TestContext, cell: Cell) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  t.mock.method(performance, "now", () => Date.now());
  const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  const records: Audit[] = [];
  t.mock.method(audit, "write", (record: Audit) => { records.push(record); });
  const projectDir = "/srv/apps/app";
  const services = Array.from({ length: cell.services ?? 4 }, (_, i) => `service${i}`);
  const labels = (serviceName: string) => ({ "com.docker.compose.project": "app", "com.docker.compose.service": serviceName,
    "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": `${projectDir}/compose.yaml` });
  registry.replaceAll(services.map((serviceName) => ({ containerId: serviceName, containerName: `app-${serviceName}-1`,
    imageRef: "example/app:1.0", allowed: true, externallyManaged: cell.scope === "foreign-stack",
    compose: { projectDir, projectName: "app", serviceName, composeFileName: "compose.yaml", origin: "adopted" } })));
  let mutated = false;
  let mutations = 0;
  let reads = 0;
  let hits = 0;
  let finalReading = false;
  let postMutationLists = 0;
  const slow = async (phase: Phase, options?: CallOptions, readbackAt?: string) => {
    assert.ok(options?.signal, `${phase}: abort signal forwarded`);
    assert.ok(options.timeoutMs! > 0 && options.timeoutMs! <= envelope - Date.now(), `${phase}: remaining budget forwarded`);
    if (cell.phase === phase && (!cell.readbackAt || cell.readbackAt === readbackAt)) { hits++; await wait(HUB_RUNTIME_TIMEOUT_MS + 100_000); }
    else await wait(cell.engineMs ?? (cell.phase === "cumulative" ? 14_000 : 1000));
  };
  const raw = (id: string): Raw => ({ Id: id, Name: `/app-${id}-1`,
    Config: { Labels: labels(id), Image: "example/app:1.0", StopTimeout: -1 },
    Mounts: Array.from({ length: cell.volumes ?? (cell.scope === "container" || cell.phase === "volumes" ? 4 : 0) }, (_, i) => ({ Type: "volume", Name: `data${i}`, Destination: `/data${i}` })),
    State: { Status: mutated ? cell.action === "stop" ? "exited" : "running" : cell.action === "start" ? "exited" : "running",
      Running: mutated ? cell.action !== "stop" : cell.action !== "start", StartedAt: "seen", ExitCode: 0 } });
  t.mock.method(engine, "inspect", async (id: string, options?: CallOptions) => {
    reads++;
    await slow(finalReading ? "readback" : mutated ? "observation" : cell.scope !== "container" && cell.action === "restart" && reads > services.length ? "restart-inspect" : "gate", options, "gate");
    return raw(id);
  });
  t.mock.method(engine, "inspectVolume", async (_name: string, options?: CallOptions) => {
    await slow(finalReading ? "readback" : "volumes", options, "volumes");
    return { Driver: "local", Options: {} };
  });
  t.mock.method(engine, "listWithComposeLabels", async (options?: CallOptions) => {
    if (mutated && cell.transport === "sync") finalReading = true;
    if (finalReading) postMutationLists++;
    await slow(finalReading ? cell.scope !== "container" && postMutationLists === 1 ? "reanchor" : "readback" : mutated ? "observation" : "inventory", options);
    return services.map((id) => ({ id, name: `app-${id}-1`, image: "example/app:1.0", status: raw(id).State.Status, labels: labels(id) }));
  });
  t.mock.method(engine, "imageId", async (_ref: string, options?: CallOptions) => { await slow("image", options); return "local-image"; });
  const mutate = async (options?: CallOptions) => {
    mutations++;
    assert.ok(options?.signal, "mutation signal forwarded");
    assert.ok(options.timeoutMs! <= envelope - Date.now(), "mutation deadline capped by remaining budget");
    if (cell.phase === "mutation") { hits++; await wait(HUB_RUNTIME_TIMEOUT_MS + 100_000); }
    else await wait(cell.mutationMs ?? (cell.phase === "cumulative" ? 598_000 : 1000));
    mutated = true;
    finalReading = true;
  };
  t.mock.method(engine, "start", async (_id: string, options?: CallOptions) => mutate(options));
  for (const action of ["stop", "restart"] as const) t.mock.method(engine, action, async (_id: string, _grace?: number | null, options?: CallOptions) => mutate(options));
  t.mock.method(childProcess, "execFile", (_binary: string, args: string[], options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const call = { timeoutMs: Number(options.timeout), signal: options.signal };
    void (async () => {
      if (args.includes("config")) {
        await slow(finalReading ? "readback" : "config", call, "config");
        callback(null, JSON.stringify({ services: Object.fromEntries(services.map((name) => [name, { image: "example/app:1.0", stop_grace_period: "10m" }])) }), "");
      } else {
        // Observe a running command; background observation may consume the
        // deadline even when the mutation itself has not answered yet.
        mutated = true;
        if (cell.phase === "observation") await wait(20_000);
        await mutate(call);
        callback(null, "", "");
      }
    })().catch((error: Error) => callback(error, "", ""));
    return new EventEmitter() as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.timers.tick(2 * HUB_RUNTIME_TIMEOUT_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const originalExclusive = stackLocks.runExclusive.bind(stackLocks);
  t.mock.method(stackLocks, "runExclusive", async (key: string, operation: () => Promise<unknown>, options?: { waitMs: number; onQueued?: () => void }) => {
    if (cell.phase === "queue") {
      hits++;
      assert.ok(options!.waitMs <= envelope - Date.now());
      // Keep the real FIFO timeout and cancellation, rather than stubbing it.
      void originalExclusive(key, () => wait(HUB_RUNTIME_TIMEOUT_MS + 100_000));
    } else if (cell.phase === "cumulative") {
      void originalExclusive(key, () => wait(59_000));
    }
    const result = await originalExclusive(key, operation, options);
    return result;
  });
  const body = cell.scope === "container" ? { expectedContainer: { containerId: services[0], status: raw(services[0]).State.Status, startedAt: "seen" } }
    : { expectedStack: { projectName: "app", projectDir, composeFileName: "compose.yaml",
      services: services.map((id) => ({ serviceName: id, containerId: id, status: raw(id).State.Status, startedAt: "seen" })) }, applyDefinition: false };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (cell.scope !== "container" && cell.transport === "sync" && url.pathname.endsWith("-stream")) return Response.json({ error: "not-found" }, { status: 404 });
    const request = Object.assign(Readable.from([Buffer.from(String(init!.body))]), { headers: {}, aborted: false }) as unknown as http.IncomingMessage;
    const response = new ResponseSink();
    const ctx: Context = { request, response: response as unknown as http.ServerResponse, actor: null,
      containerId: services[0], action: cell.action, url };
    let abort = () => {};
    const disconnected = new Promise<never>((_resolve, reject) => {
      abort = () => { request.emit("aborted"); reject(new DOMException("hub deadline", "AbortError")); };
      init!.signal!.addEventListener("abort", abort, { once: true });
    });
    const responseTask = (async () => {
      await (cell.scope === "container" ? handleSafeAction(ctx) : handleStackAction(ctx, url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!));
      await wait(RUNTIME_TRANSPORT_RESERVE_MS - 1000);
      return new Response(response.chunks.join(""), { status: response.status, headers: response.headers });
    })();
    try { return await Promise.race([responseTask, disconnected]); }
    finally { init!.signal!.removeEventListener("abort", abort); }
  };
  return { body, fetchImpl, records, mutations: () => mutations, reads: () => reads, hits: () => hits };
}

async function check(t: TestContext, cell: Cell) {
  const f = fixture(t, cell);
  const delivered: Array<Record<string, unknown>> = [];
  const target = { baseUrl: "http://agent.example.org", secret: "synthetic" };
  const options = { actor: { kind: "user" as const, id: "demo-human" }, fetchImpl: f.fetchImpl };
  let settled = false;
  let receivedAt = Infinity;
  let failure: unknown;
  const pending = (cell.scope === "container" ? runContainer(target, "service0", cell.action, f.body, options).then((result) => { delivered.push(result); })
    : runStack(target, "service0", cell.action, f.body, options, { signal: new AbortController().signal,
      open: () => {}, write: async (line) => { delivered.push(line as Record<string, unknown>); } }))
    .catch((error: unknown) => { failure = error; }).finally(() => { settled = true; receivedAt = Date.now(); });
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  await flush();
  for (let i = 0; i < 900 && !settled; i++) { t.mock.timers.tick(1000); await flush(); }
  assert.equal(settled, true, "request must settle under virtual time");
  await pending;
  assert.ok(receivedAt < HUB_RUNTIME_TIMEOUT_MS, `hub receives agent answer at ${receivedAt}, before ${HUB_RUNTIME_TIMEOUT_MS}`);
  const result = failure instanceof AgentError ? failure.detail as Record<string, unknown> : delivered.at(-1);
  assert.ok(result, "agent response survives the hub schema");
  const payload = result.body as Record<string, unknown> | undefined ?? result;
  assert.notEqual(payload.error ?? result.reason, "runtime-outcome-unknown");
  assert.equal(f.records.length, 1, "exactly one action audit");
  if (cell.phase !== "cumulative") assert.ok(f.hits() > 0, `slow ${cell.phase} phase was reached`);
  if (cell.phase === "queue") assert.ok(["action-queue-timeout", "runtime-deadline-exceeded"].includes(String(payload.error ?? result.reason)));
  else assert.equal(payload.error ?? result.reason, "runtime-deadline-exceeded");
  assert.equal(f.records[0].outcome, f.mutations() ? "error" : "denied");
  if (cell.phase === "mutation" || cell.phase === "readback") {
    if (cell.scope === "container") assert.equal((payload.state as { containerId: string }).containerId, "service0");
    else assert.ok((payload.services as unknown[]).length > 0, "last read service states retained");
  }
}

for (const cell of matrix) test(`end-to-end budget: ${cell.scope} / ${cell.action} / ${cell.transport} / ${cell.phase}`, async (t) => { await check(t, cell); });
test("R10 container restart: four volumes, 14 s reads, 59 s queue, 638 s mutation", async (t) => {
  await check(t, { scope: "container", action: "restart", transport: "sync", phase: "cumulative", engineMs: 14_000, mutationMs: 638_000 });
});
test("R10 synchronous stack stop: ten services, 14 s reads, 59 s queue, 598 s mutation", async (t) => {
  await check(t, { scope: "own-stack", action: "stop", transport: "sync", phase: "cumulative", services: 10, engineMs: 14_000, mutationMs: 598_000 });
});

test("queue receives only the 30 s remaining after 49 slow volume inspects", async (t) => {
  await check(t, { scope: "container", action: "restart", transport: "sync", phase: "queue", engineMs: 14_000, volumes: 49 });
});

for (const readbackAt of ["config", "gate", "volumes"] as const) test(`readback bounds its ${readbackAt} after reanchor`, async (t) => {
  await check(t, { scope: "own-stack", action: "stop", transport: "sync", phase: "readback", readbackAt, volumes: 4 });
});
