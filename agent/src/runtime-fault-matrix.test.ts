import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import test, { after, type TestContext } from "node:test";
import { stackActionStreamLineSchema, type RuntimeAction } from "contract";
import { ComposeError } from "./compose-cli.js";
import { EngineError, type RawInspect } from "./engine.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-fault-matrix-"));
process.env.DOCKER_AGENT_SECRET = "s".repeat(32);
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(directory, "registry.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(directory, "audit.ndjson");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(directory, "monitor.json");
process.env.DOCKER_AGENT_BIND_BASE_PATH = "/srv/apps";
const { handleSafeAction } = await import("./routes/definition-routes.js");
const { handleStackAction } = await import("./routes/stack-routes.js");
const { engine, registry, audit, stackLocks } = await import("./runtime/state.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const scopes = ["container", "own-stack", "foreign-stack"] as const;
const actions: RuntimeAction[] = ["start", "stop", "restart"];
const transports = ["sync", "stream"] as const;
const kinds = ["engine", "plain", "compose"] as const;
const stages = ["first-gate", "state-read", "inventory", "gate-inspect", "image-lookup", "compose-config",
  "compose-command", "read-back", "re-anchor", "queue", "engine-command"] as const;
type Cell = { scope: typeof scopes[number]; action: RuntimeAction; transport: typeof transports[number];
  kind: typeof kinds[number]; stage: typeof stages[number]; applyDefinition?: boolean; commandPart?: "stop" | "start" | "both"; delegation?: boolean; holdCommand?: boolean };
const matrix: Cell[] = scopes.flatMap((scope) => actions.flatMap((action) => transports.flatMap((transport) =>
  kinds.flatMap((kind) => stages.map((stage) => ({ scope, action, transport, kind, stage }))))));

const recoveryCases: Cell[] = (["own-stack", "foreign-stack"] as const).flatMap((scope) =>
  transports.flatMap((transport) => kinds.flatMap((kind) =>
    (scope === "own-stack" ? ["stop", "start", "both"] as const : ["stop", "start"] as const)
      .map((commandPart) => ({ scope, action: "restart", transport, kind, stage: "compose-command", applyDefinition: false, commandPart })))));

function notApplicable(cell: Cell): string | undefined {
  if (cell.scope === "container") {
    if (cell.transport === "stream") return "Container runtime actions have no stream route or NDJSON negotiation.";
    if (["image-lookup", "compose-config", "compose-command"].includes(cell.stage)) return "Container actions use the engine without image lookup or Compose.";
  } else {
    if (cell.stage === "engine-command") return "Stack mutations use Compose commands.";
    if (cell.stage === "image-lookup" && (cell.action === "stop" || cell.scope === "foreign-stack")) return "Stop and externally managed actions do not create services or look up images.";
  }
}

const projectDir = "/srv/apps/app";
const labels = { "com.docker.compose.project": "app", "com.docker.compose.service": "web",
  "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": `${projectDir}/compose.yaml` };
const entry = { containerId: "old", containerName: "app-web-1", imageRef: "example/app:1.0", allowed: true,
  compose: { projectDir, projectName: "app", serviceName: "web", composeFileName: "compose.yaml", origin: "dashboard" } };

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  writableLength = 0;
  status = 0;
  chunks: string[] = [];
  writeHead(status: number) { this.status = status; this.headersSent = true; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
}

function fixture(t: TestContext, cell: Cell) {
  registry.replaceAll([{ ...entry, externallyManaged: cell.scope === "foreign-stack" }]);
  const diagnostic = `fault-${cell.scope}-${cell.action}-${cell.transport}-${cell.stage}-${cell.kind}`;
  const stderr = `stderr-${diagnostic}`;
  const failure = cell.kind === "engine" ? new EngineError(`engine responded 503: ${JSON.stringify({ message: diagnostic })}`, 503) :
    cell.kind === "compose" ? new ComposeError(diagnostic, stderr, 17) : new Error(diagnostic);
  let hits = 0;
  const inject = () => { hits++; throw failure; };
  let mutations = 0;
  let reads = 0;
  let id = "old";
  let release = () => {};
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => { commandStarted = resolve; });
  const inspect = (containerId: string): RawInspect => ({ Id: containerId, Name: "/app-web-1",
    Config: { Labels: labels, Image: "example/app:1.0" },
    ...(cell.delegation ? { HostConfig: { Privileged: true } } : {}),
    State: { Status: mutations && cell.action !== "stop" ? "running" : "exited", StartedAt: "seen", ExitCode: 0 } });
  const records: Parameters<typeof audit.write>[0][] = [];
  t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
  t.mock.method(engine, "inspect", async (containerId: string) => {
    reads++;
    if (cell.stage === "first-gate" && cell.scope === "container" && reads === 1) inject();
    if (cell.stage === "gate-inspect" && !mutations && reads === (cell.scope === "container" ? 2 : 1)) inject();
    if (cell.stage === "read-back" && mutations) inject();
    const raw = inspect(containerId);
    if (cell.stage === "state-read" && !mutations && reads === (cell.scope === "container" ? 3 : 1)) {
      Object.defineProperty(raw.State, "Status", { get: inject });
    }
    return raw;
  });
  t.mock.method(engine, "listWithComposeLabels", async () => {
    if (cell.stage === "inventory" && !mutations) inject();
    return [{ id, name: "app-web-1", image: "example/app:1.0", status: "exited", labels }];
  });
  t.mock.method(engine, "imageId", async () => { if (cell.stage === "image-lookup") inject(); return "local-image"; });
  const mutate = async () => {
    mutations++;
    if (cell.stage === "re-anchor") id = "new";
    if (cell.stage === "engine-command") inject();
  };
  for (const action of actions) t.mock.method(engine, action, mutate);
  if (cell.stage === "first-gate" && cell.scope !== "container") t.mock.method(registry, "get", inject);
  if (cell.stage === "queue") t.mock.method(stackLocks, "runExclusive", async () => inject());
  if (cell.stage === "re-anchor") {
    t.mock.method(registry, cell.scope === "container" ? "replaceContainerId" : "replaceContainerIds", inject);
  }
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (args.includes("config")) {
      if (cell.stage === "compose-config" && !mutations) inject();
      callback(null, JSON.stringify({ services: { web: { image: "example/app:1.0" } } }), "");
    } else {
      mutations++;
      if (cell.stage === "re-anchor") id = "new";
      if (cell.stage === "compose-command" && (!cell.commandPart || cell.commandPart === "both" ||
          (cell.commandPart === "stop" ? args.includes("stop") : args.includes("start") || args.includes("up")))) inject();
      commandStarted();
      if (cell.holdCommand) release = () => callback(null, "", "");
      else callback(null, "", "");
    }
    return {} as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const actionPath = cell.action + (cell.transport === "stream" ? "-stream" : "");
  const body = cell.scope === "container" ? { expectedContainer: { containerId: "old", status: "exited", startedAt: "seen" } } :
    { expectedStack: { projectName: "app", projectDir, composeFileName: "compose.yaml",
      services: [{ serviceName: "web", containerId: "old", status: "exited", startedAt: "seen" }] }, applyDefinition: cell.applyDefinition ?? true };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {}, aborted: false }) as unknown as http.IncomingMessage;
  const response = new Response();
  const context = { request, response: response as unknown as http.ServerResponse, actor: null, containerId: "old", action: cell.action,
    url: new URL(`http://agent.invalid/${cell.scope === "container" ? "containers/old" : "stacks/old/actions"}/${actionPath}`) };
  return { records, response, diagnostic, stderr, failure, started, release: () => release(), hits: () => hits, mutations: () => mutations,
    run: () => cell.scope === "container" ? handleSafeAction(context) :
      handleStackAction(context, context.url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!) };
}

test("fault matrix enumerates every requested combination and explicit exclusions", () => {
  assert.equal(matrix.length, 594);
  assert.equal(matrix.filter((cell) => !notApplicable(cell)).length, 408);
  assert.equal(matrix.filter((cell) => notApplicable(cell)).length, 186);
  assert.equal(recoveryCases.length, 30);
});

for (const cell of [...matrix, ...recoveryCases]) {
  const label = [cell.scope, cell.action, cell.transport, cell.stage, cell.kind, ...(cell.commandPart ? [`recovery-${cell.commandPart}`] : [])].join(" / ");
  test(`fault matrix: ${label}`, { skip: notApplicable(cell) }, async (t) => {
    const f = fixture(t, cell);
    // An escaped error is a test failure, rather than the dispatcher's generic 500.
    await assert.doesNotReject(f.run);
    assert.ok(f.hits() > 0, "the selected stage must actually be reached");
    const mutated = ["compose-command", "engine-command", "read-back", "re-anchor"].includes(cell.stage);
    assert.equal(f.mutations() > 0, mutated);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].outcome, mutated ? "error" : "denied");
    assert.equal(f.records[0].action, cell.scope === "container" ? cell.action : `stack-${cell.action}`);
    assert.ok(f.records[0].reason?.includes(f.diagnostic));
    if (cell.kind === "compose") {
      assert.ok(f.records[0].reason?.includes("exit 17"));
      assert.ok(f.records[0].reason?.includes(f.stderr));
    }
    const expectedStatus = cell.kind === "engine" ? 503 : cell.kind === "compose" ? 502 : 500;
    const expectedKey = cell.kind === "engine" ? "engine-action-failed" : cell.kind === "compose" ? "compose-action-failed" : "internal-error";
    const payload = f.response.chunks.join("");
    assert.equal(payload.includes(f.diagnostic), false);
    assert.equal(payload.includes(f.stderr), false);
    assert.equal(payload.includes("engineMessage"), false);
    assert.equal(payload.includes("composeExitCode"), false);
    if (cell.transport === "stream" && mutated) {
      assert.equal(f.response.status, 200);
      const lines = f.response.chunks.map((chunk) => stackActionStreamLineSchema.parse(JSON.parse(chunk)));
      assert.equal(lines[0].kind, "start");
      const last = lines.at(-1)!;
      assert.equal(last.kind, "error");
      assert.ok(last.kind === "error");
      assert.equal(last.reason, expectedKey);
      assert.equal(last.status, expectedStatus);
      assert.equal(last.body?.error, expectedKey);
    } else {
      assert.equal(f.response.status, expectedStatus);
      assert.equal(JSON.parse(payload).error, expectedKey);
    }
    assert.equal(f.response.writableEnded, true);
  });
}

for (const scope of scopes) for (const kind of kinds) {
  test(`delegation hints share the single failure audit: ${scope} / ${kind}`, async (t) => {
    const cell: Cell = { scope, action: "start", transport: scope === "container" ? "sync" : "stream", kind,
      stage: scope === "container" ? "engine-command" : "compose-command", delegation: true };
    const f = fixture(t, cell);
    await assert.doesNotReject(f.run);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].outcome, "error");
    assert.ok(f.records[0].reason?.includes(f.diagnostic));
    assert.match(String(f.records[0].reason), /delegation-lock-allowed:/);
    assert.equal(f.response.chunks.join("").includes("delegation-lock-allowed"), false);
  });
}

for (const kind of kinds) {
  test(`stream observation ${kind} failure is audited once with the final read-back`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const f = fixture(t, { scope: "own-stack", action: "start", transport: "stream", kind, stage: "engine-command", holdCommand: true });
    let injected = false;
    t.mock.method(engine, "listWithComposeLabels", async () => {
      if (f.mutations() && !injected) { injected = true; throw f.failure; }
      return [{ id: "old", name: "app-web-1", image: "example/app:1.0", status: "exited", labels }];
    });
    const run = f.run();
    await f.started;
    t.mock.timers.tick(1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.release();
    await assert.doesNotReject(run);
    assert.equal(injected, true);
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].outcome, "error");
    assert.ok(f.records[0].reason?.includes(f.diagnostic));
    if (kind === "compose") assert.ok(f.records[0].reason?.includes(f.stderr));
    const last = stackActionStreamLineSchema.parse(JSON.parse(f.response.chunks.at(-1)!));
    assert.ok(last.kind === "error");
    assert.equal(last.status, kind === "engine" ? 503 : kind === "compose" ? 502 : 500);
    assert.equal(last.body?.ok, false);
    const services = last.body?.services as Array<{ status: string }>;
    assert.equal(services[0].status, "running");
    assert.equal(f.response.chunks.join("").includes(f.diagnostic), false);
  });
}
