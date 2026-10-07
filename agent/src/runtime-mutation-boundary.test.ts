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
import { HUB_RUNTIME_TIMEOUT_MS, RUNTIME_TRANSPORT_RESERVE_MS, SELF_HEALING_SYSTEM_ACTOR, stackActionStreamLineSchema, type RuntimeAction } from "contract";
import type { RawInspect } from "./engine.js";
import { RuntimeBudget } from "./runtime-budget.js";
import { SelfHealingController } from "./self-healing.js";
import { SelfHealingStore } from "./self-healing-store.js";
import { StopIntentStore } from "./stop-intent.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mutation-boundary-"));
Object.assign(process.env, {
  DOCKER_AGENT_SECRET: "s".repeat(32), DOCKER_AGENT_REGISTRY_FILE: path.join(directory, "registry.json"),
  DOCKER_AGENT_AUDIT_FILE: path.join(directory, "audit.ndjson"), DOCKER_AGENT_MONITOR_FILE: path.join(directory, "monitor.json"),
  DOCKER_AGENT_BIND_BASE_PATH: "/srv/apps"
});
const { engine, registry, audit, stopIntents, selfHealingState, selfHealingConfig } = await import("./runtime/state.js");
const { runContainerAction } = await import("./container-action.js");
const { handleStackAction } = await import("./routes/stack-routes.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const points = ["before-reservation", "during-reservation", "before-call", "after-call"] as const;
type Point = typeof points[number];
type Cell = { scope: "container" | "stack" | "healing"; point: Point; stream?: boolean; external?: boolean; applyDefinition?: boolean; action?: RuntimeAction };
const envelope = HUB_RUNTIME_TIMEOUT_MS - RUNTIME_TRANSPORT_RESERVE_MS;
const projectDir = "/srv/apps/demo";
const labels = { "com.docker.compose.project": "demo", "com.docker.compose.service": "web",
  "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": `${projectDir}/compose.yaml` };

class Response extends EventEmitter {
  status = 0; headersSent = false; destroyed = false; writableEnded = false; writableLength = 0;
  chunks: string[] = [];
  writeHead(status: number) { this.status = status; this.headersSent = true; }
  write(chunk: string) { this.chunks.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.chunks.push(chunk); this.writableEnded = true; }
}

function fixture(t: TestContext, cell: Cell) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const action = cell.scope === "healing" ? "start" : cell.action ?? "restart";
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(stopIntents as unknown as { now: () => number }, "now", () => now);
  let hits = 0;
  const expire = () => { hits++; now = envelope; };
  stopIntents.setDaemonGeneration(`boundary-${JSON.stringify(cell)}`);
  selfHealingState.change((state) => { state.entries = []; state.incidents = []; state.maintenance = []; });
  selfHealingConfig.write({ enabled: true, attempts: 2, retryDelaysSeconds: [1, 2], stabilityWindowSeconds: 600, maintenanceDurationSeconds: 3600 });
  const raw: RawInspect = { Id: "old", Name: "/demo-web", Config: { Labels: cell.scope === "healing" ? {} : labels },
    HostConfig: { RestartPolicy: { Name: "no" } }, RestartCount: 0,
    State: { Status: "exited", Running: false, StartedAt: "seen", ExitCode: 1 } };
  registry.replaceAll([{ containerId: raw.Id, containerName: "demo-web", imageRef: "example/app:1.0", allowed: true,
    externallyManaged: cell.external, ...(cell.scope === "healing" ? {} : { compose: {
      projectName: "demo", projectDir, serviceName: "web", composeFileName: "compose.yaml", origin: "adopted"
    } }) }]);
  const records: Parameters<typeof audit.write>[0][] = [];
  t.mock.method(audit, "write", (entry: Parameters<typeof audit.write>[0]) => records.push(entry));
  t.mock.method(engine, "inspect", async () => structuredClone(raw));
  t.mock.method(engine, "listWithComposeLabels", async () => [{ id: raw.Id, name: "demo-web", image: "example/app:1.0", status: "exited", labels }]);
  t.mock.method(engine, "imageId", async () => "local-image");
  let calls = 0;
  const mutate = async () => { calls++; if (cell.point === "after-call") { expire(); t.mock.timers.tick(envelope); } };
  t.mock.method(engine, "restart", mutate);
  t.mock.method(engine, "start", mutate);
  t.mock.method(engine, "stop", mutate);
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (args.includes("config")) callback(null, JSON.stringify({ services: { web: { image: "example/app:1.0" } } }), "");
    else { calls++; if (cell.point === "after-call") { expire(); t.mock.timers.tick(envelope); } callback(null, "", ""); }
    return new EventEmitter() as childProcess.ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  // The last scope check precedes reservation; inspect and preflight still complete.
  let accesses = 0;
  const checkAccess = registry.checkAccess.bind(registry);
  t.mock.method(registry, "checkAccess", (...args: Parameters<typeof registry.checkAccess>) => {
    const result = checkAccess(...args);
    if (++accesses === (cell.scope === "stack" ? 3 : 4)) {
      if (cell.point === "before-reservation") expire();
      if (action !== "restart" && cell.scope !== "healing") markerWritten = true;
    }
    return result;
  });
  let reserved = false;
  let writes = 0;
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    rename(...args);
    const file = cell.scope === "healing" ? "self-healing-state.json" : "stop-intents.json";
    if (reserved && String(args[1]).endsWith(file) && cell.point === "during-reservation") { writes++; expire(); }
  });
  let markerWritten = false;
  const begin = stopIntents.beginHubRestart.bind(stopIntents);
  t.mock.method(stopIntents, "beginHubRestart", (containers: readonly RawInspect[]) => {
    reserved = true;
    const finish = begin(containers);
    reserved = false;
    markerWritten = true;
    return finish;
  });
  const run = RuntimeBudget.prototype.run;
  t.mock.method(RuntimeBudget.prototype, "run", function<T>(this: RuntimeBudget,
    operation: Parameters<RuntimeBudget["run"]>[0], cap?: number): Promise<T> {
    if (markerWritten && cell.point === "before-call") { markerWritten = false; expire(); }
    return run.call(this, operation, cap) as Promise<T>;
  });
  const expected = { containerId: raw.Id, status: "exited", startedAt: "seen" };
  const event = { containerId: raw.Id, action: "kill" as const, signal: "15", atMs: 0 };
  let priorIntents: ReturnType<typeof stopIntents.list> = [];
  if (cell.scope !== "healing") {
    stopIntents.observe(event, raw);
    stopIntents.observe({ ...event, action: "die" }, raw);
    priorIntents = stopIntents.list();
    assert.equal(priorIntents.length, 1);
  }
  let controller: SelfHealingController | undefined;
  let pendingId: string | undefined;
  if (cell.scope === "healing") {
    controller = new SelfHealingController(selfHealingState, {
      config: () => selfHealingConfig.read(), check: async () => raw, inspect: async () => calls ? null : raw,
      evidence: async () => { throw new Error("no incident before attempt budget is exhausted"); },
      start: (id, expectation, signal, reserve) => runContainerAction(id, "start", expectation, SELF_HEALING_SYSTEM_ACTOR, signal, (before) => {
        reserved = true;
        try { reserve(before); } finally { reserved = false; }
        markerWritten = true;
      })
    });
    controller.setObserving(true); controller.reconcile(raw);
    controller.observe({ containerId: raw.Id, action: "die", exitCode: 1 }, raw, "unexpected");
    const entry = selfHealingState.entries()[0]; entry.pending!.dueAt = 0; pendingId = entry.pending!.id; selfHealingState.put(entry);
  }
  return { raw, records, priorIntents, pendingId, hits: () => hits, calls: () => calls, writes: () => writes,
    run: async () => {
      if (controller) { await controller.tick(); return null; }
      if (cell.scope === "container") return runContainerAction(raw.Id, action, expected, "demo-operator");
      const body = { expectedStack: { projectName: "demo", projectDir, composeFileName: "compose.yaml",
        services: [{ serviceName: "web", containerId: raw.Id, status: "exited", startedAt: "seen" }] }, applyDefinition: cell.applyDefinition };
      const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: {}, aborted: false }) as unknown as http.IncomingMessage;
      const response = new Response();
      const url = new URL(`http://agent.invalid/stacks/old/actions/${action}${cell.stream ? "-stream" : ""}`);
      await handleStackAction({ request, response: response as unknown as http.ServerResponse, actor: "demo-operator", url },
        url.pathname.match(/^\/stacks\/([^/]+)\/actions\/([^/]+)$/)!);
      if (!cell.stream || response.status !== 200) return { status: response.status, body: JSON.parse(response.chunks.join("")) };
      const terminal = stackActionStreamLineSchema.parse(JSON.parse(response.chunks.at(-1)!));
      assert.equal(terminal.kind, "error"); assert.ok(terminal.kind === "error");
      return { status: terminal.status, body: terminal.body };
    }
  };
}

const matrix: Cell[] = points.flatMap((point) => [
  { scope: "healing", point },
  ...(["start", "stop", "restart"] as const).flatMap((action) => [
    { scope: "container" as const, point, action },
    ...[false, true].flatMap((stream) => [
      { scope: "stack" as const, point, action, stream, external: false, applyDefinition: false },
      { scope: "stack" as const, point, action, stream, external: false, applyDefinition: true },
      { scope: "stack" as const, point, action, stream, external: true, applyDefinition: false }
    ])
  ])
]);
for (const cell of matrix) test(`mutation boundary: ${JSON.stringify(cell)}`, {
  skip: cell.point === "during-reservation" && cell.scope !== "healing" && cell.action !== "restart"
    ? "Start and stop have no persistent reservation or restart marker." : false
}, async (t) => {
  const f = fixture(t, cell);
  const result = await f.run();
  assert.ok(f.hits() > 0, "expiry injection must be reached");
  if (cell.point === "during-reservation") assert.equal(f.writes(), 1, "expiry occurs inside the persistent write");
  const started = cell.point === "after-call";
  assert.equal(f.calls(), started ? 1 : 0);
  assert.equal(f.records.length, 1, "exactly one audit outcome");
  assert.equal(f.records[0].outcome, started ? "error" : "denied");
  assert.ok(f.records[0].reason?.includes("runtime-deadline-exceeded"));
  if (result) {
    assert.equal(result.status, 504); assert.equal(result.body.error, "runtime-deadline-exceeded");
    assert.equal(result.body.ok, false);
    assert.equal(JSON.stringify(result.body).includes("engineMessage"), false);
  }
  const entry = selfHealingState.entries()[0];
  assert.equal(entry?.attempts.length ?? 0, cell.scope === "healing" && started ? 1 : 0);
  const persisted = new SelfHealingStore(path.join(directory, "self-healing-state.json"));
  assert.equal(persisted.entries()[0]?.attempts.length ?? 0, cell.scope === "healing" && started ? 1 : 0);
  if (cell.scope === "healing") {
    assert.equal(entry.healingStart !== null, started);
    assert.equal(entry.pending?.id, cell.point === "before-reservation" ? undefined : f.pendingId);
  } else {
    assert.equal(stopIntents.isHubRestartActive(f.raw.Id), false);
    assert.equal(stopIntents.restartRequested({ containerId: f.raw.Id, action: "kill", atMs: envelope }), started && cell.action === "restart");
    assert.deepEqual(stopIntents.list(), started && cell.action === "restart" ? [] : f.priorIntents);
    assert.deepEqual(new StopIntentStore(path.join(directory, "stop-intents.json")).list(), started && cell.action === "restart" ? [] : f.priorIntents);
  }
});
