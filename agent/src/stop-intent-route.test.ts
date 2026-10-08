import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after, type TestContext } from "node:test";
import { ACTOR_HEADER, SECRET_HEADER, stopIntentsResponseSchema, stackActionStreamLineSchema } from "contract";
import { EngineError, type RawInspect } from "./engine.js";
import { findRoute } from "./route-policy.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-intent-route-test-"));
const secret = "s".repeat(64);
process.env.DOCKER_AGENT_SECRET = secret;
process.env.DOCKER_AGENT_REGISTRY_FILE = path.join(directory, "registry.json");
process.env.DOCKER_AGENT_MONITOR_FILE = path.join(directory, "monitors.json");
process.env.DOCKER_AGENT_AUDIT_FILE = path.join(directory, "audit.jsonl");
process.env.DOCKER_AGENT_BIND_BASE_PATH = "/srv/apps";
const { handleRequest } = await import("./dispatch.js");
const { stopIntents, dockerEvents, config, registry, engine, audit } = await import("./runtime/state.js");
after(() => fs.rmSync(directory, { recursive: true, force: true }));

class Response extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  status = 0;
  headers: Record<string, unknown> = {};
  chunks: string[] = [];
  setHeader(name: string, value: unknown) { this.headers[name] = value; }
  writeHead(code: number, headers: Record<string, string> = {}) {
    this.status = code;
    Object.assign(this.headers, headers);
    this.headersSent = true;
  }
  write(value: string) { this.chunks.push(value); return true; }
  end(value?: string) { if (value) this.chunks.push(value); this.writableEnded = true; }
  body(): unknown { return JSON.parse(this.chunks.join("")); }
}

async function request(url: string, options: { authorized?: boolean; body?: unknown; accept?: string } = {}) {
  const input = Object.assign(Readable.from(options.body ? [Buffer.from(JSON.stringify(options.body))] : []), {
    url, method: options.body ? "POST" : "GET", aborted: false,
    headers: { ...(options.authorized === false ? {} : { [SECRET_HEADER]: secret }),
      [ACTOR_HEADER]: "demo-operator", ...(options.accept ? { accept: options.accept } : {}) }
  }) as unknown as http.IncomingMessage;
  const output = new Response();
  await handleRequest(input, output as unknown as http.ServerResponse);
  return output;
}

test("stop-intents route is authenticated, read-only and in the published policy", async (t) => {
  const policy = findRoute("GET", "/stop-intents");
  assert.equal(policy?.mutating, false);
  assert.equal(policy?.audit, "stop-intents");
  assert.equal(policy?.public, undefined);
  assert.equal(findRoute("POST", "/stop-intents"), null);
  assert.equal((await request("/stop-intents", { authorized: false })).status, 401);
  t.mock.method(dockerEvents, "isObserving", () => true);
  t.mock.property(config, "readOnly", true);
  const response = await request("/stop-intents");
  assert.equal(response.status, 200);
  assert.equal(stopIntentsResponseSchema.safeParse(response.body()).success, true);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("unavailable observation is explicit and audited", async (t) => {
  t.mock.method(dockerEvents, "isObserving", () => false);
  const response = await request("/stop-intents");
  assert.equal(response.status, 503);
  assert.equal(stopIntentsResponseSchema.parse(response.body()).observing, false);
  const lines = fs.readFileSync(path.join(directory, "audit.jsonl"), "utf8").trim().split("\n");
  const record = JSON.parse(lines.at(-1)!) as { action: string; actor: string; outcome: string };
  assert.equal(record.action, "stop-intents");
  assert.equal(record.actor, "demo-operator");
  assert.equal(record.outcome, "error");
});

const id = "a".repeat(64);
const workerId = "b".repeat(64);
const projectDir = "/srv/apps/demo";
const scenarios = ["confirmed", "failed", "failed-after-events", "already-stopped", "state-changed"] as const;
type Scenario = typeof scenarios[number];

function fixture(t: TestContext, stack: boolean, scenario: Scenario, external = false, restart = false) {
  stopIntents.daemonDisconnected();
  stopIntents.setDaemonGeneration("boot-a:socket-a");
  const ids = stack ? [id, workerId] : [id];
  let stopped = scenario === "already-stopped";
  const containers = new Map(ids.map((containerId, index) => {
    const service = index ? "worker" : "web";
    const labels: Record<string, string> = stack ? { "com.docker.compose.project": "demo", "com.docker.compose.service": service,
      "com.docker.compose.project.working_dir": projectDir, "com.docker.compose.project.config_files": `${projectDir}/compose.yaml` } : {};
    return [containerId, { Id: containerId, Name: `/demo-${service}`, Config: { Labels: labels, StopTimeout: 30 },
      State: { Status: "running", Running: true, StartedAt: "seen", ExitCode: 0 }, HostConfig: {} } satisfies RawInspect];
  }));
  const inspect = (containerId: string): RawInspect => {
    const container = containers.get(containerId)!;
    return { ...container, State: { ...container.State, Running: !stopped, Status: stopped ? "exited" : "running" } };
  };
  registry.replaceAll(ids.map((containerId, index) => ({ containerId, containerName: `demo-${index ? "worker" : "web"}`,
    imageRef: "example/app:1.0", allowed: true, externallyManaged: external,
    ...(stack ? { compose: { projectDir, projectName: "demo", serviceName: index ? "worker" : "web", composeFileName: "compose.yaml", origin: "dashboard" } } : {}) })));
  t.mock.method(engine, "inspect", async (containerId: string) => inspect(containerId));
  t.mock.method(engine, "listWithComposeLabels", async () => ids.map((containerId) => ({ id: containerId,
    name: inspect(containerId).Name.slice(1), image: "example/app:1.0", status: stopped ? "exited" : "running",
    labels: inspect(containerId).Config!.Labels! })));
  const records: Parameters<typeof audit.write>[0][] = [];
  t.mock.method(audit, "write", (record: Parameters<typeof audit.write>[0]) => { records.push(record); });
  const annotations: Array<{ ids: readonly string[]; actor: string | null }> = [];
  let finishes = 0;
  const begin = stopIntents.beginHubStop.bind(stopIntents);
  t.mock.method(stopIntents, "beginHubStop", (containerIds: readonly string[], actor: string | null) => {
    annotations.push({ ids: [...containerIds], actor });
    const finish = begin(containerIds, actor);
    return () => { finishes++; finish(); };
  });
  let mutations = 0;
  const mutate = () => {
    mutations++;
    if (scenario === "confirmed" || scenario === "failed-after-events") {
      assert.equal(stopIntents.list().length, 0);
      for (const containerId of ids) stopIntents.observe({ action: "kill", signal: "15", containerId }, inspect(containerId));
      assert.equal(stopIntents.list().length, 0);
      for (const containerId of ids) stopIntents.observe({ action: "die", containerId }, inspect(containerId));
      stopped = true;
    }
    if (scenario === "failed" || scenario === "failed-after-events") throw new EngineError("synthetic stop refused", 503);
  };
  t.mock.method(engine, "restart", async (containerId: string, timeout: number | null) => {
    assert.equal(containerId, id); assert.equal(timeout, 30);
    mutate();
  });
  t.mock.method(engine, "imageId", async () => "sha256:synthetic");
  t.mock.method(engine, "stop", async (containerId: string, timeout: number | null) => {
    assert.equal(containerId, id);
    assert.equal(timeout, 30);
    mutate();
  });
  if (stack) {
    t.mock.method(childProcess, "execFile", (_file: string, args: string[], _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (args.includes("config")) callback(null, JSON.stringify({ services: { web: { image: "example/app:1.0" }, worker: { image: "example/app:1.0" } } }), "");
      else {
        if (restart && (args.at(-1) === "start" || args.includes("up"))) {
          if (!stopped) {
            try { mutate(); } catch { /* The start failure is reported by the Compose callback. */ }
          }
          callback(new Error("synthetic start refused"), "", "synthetic start refused");
          return {} as childProcess.ChildProcess;
        }
        assert.equal(args.at(-1), "stop");
        try { mutate(); callback(null, "", ""); }
        catch (error) { callback(error as Error, "", "synthetic stop refused"); }
      }
      return {} as childProcess.ChildProcess;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }
  const status = scenario === "already-stopped" ? "exited" : scenario === "state-changed" ? "paused" : "running";
  const body = stack ? { expectedStack: { projectName: "demo", projectDir, composeFileName: "compose.yaml",
    services: ids.map((containerId, index) => ({ serviceName: index ? "worker" : "web", containerId, status, startedAt: "seen" })) } }
    : { expectedContainer: { containerId: id, status, startedAt: "seen" } };
  return { ids, records, annotations, body, stopped: () => stopped, finishes: () => finishes, mutations: () => mutations };
}

function verify(f: ReturnType<typeof fixture>, scenario: Scenario, response: Response, stack: boolean) {
  const changed = scenario === "state-changed";
  const failed = scenario === "failed" || scenario === "failed-after-events";
  assert.equal(f.mutations(), changed ? 0 : 1);
  assert.deepEqual(f.annotations, changed ? [] : [{ ids: f.ids, actor: "demo-operator" }]);
  assert.equal(f.finishes(), changed ? 0 : 1);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].actor, "demo-operator");
  assert.equal(f.records[0].outcome, changed ? "denied" : failed ? "error" : "allowed");
  assert.equal(f.records[0].action, stack ? "stack-stop" : "stop");
  const payload = response.headers["content-type"] === "application/x-ndjson; charset=utf-8"
    ? stackActionStreamLineSchema.parse(JSON.parse(response.chunks.at(-1)!))
    : { status: response.status };
  assert.equal("status" in payload ? payload.status : undefined, changed ? 409 : failed ? stack ? 502 : 503 : 200);
  assert.deepEqual(stopIntents.list().map((intent) => ({ id: intent.containerId, actor: intent.actor })),
    scenario === "confirmed" || scenario === "failed-after-events" ? f.ids.map((containerId) => ({ id: containerId, actor: "demo-operator" })) : []);
}

for (const scenario of scenarios) {
  test(`container stop handler annotates only event-confirmed intent: ${scenario}`, async (t) => {
    const f = fixture(t, false, scenario);
    const response = await request(`/containers/${id}/stop`, { body: f.body });
    verify(f, scenario, response, false);
    t.mock.method(dockerEvents, "isObserving", () => true);
    const list = stopIntentsResponseSchema.parse((await request("/stop-intents")).body());
    assert.deepEqual(list.intents, stopIntents.list());
  });
}

for (const external of [false, true]) for (const transport of ["sync", "suffix", "accept"]) for (const scenario of scenarios) {
  test(`stack stop handler annotation: ${external ? "foreign" : "own"} / ${transport} / ${scenario}`, async (t) => {
    const f = fixture(t, true, scenario, external);
    const response = await request(`/stacks/${id}/actions/stop${transport === "suffix" ? "-stream" : ""}`, {
      body: f.body, ...(transport === "accept" ? { accept: "application/x-ndjson" } : {})
    });
    verify(f, scenario, response, true);
    assert.equal(response.headers["content-type"], transport === "sync" || scenario === "state-changed"
      ? "application/json; charset=utf-8" : "application/x-ndjson; charset=utf-8");
  });
}


for (const stack of [false, true]) for (const external of stack ? [false, true] : [false]) {
  for (const applyDefinition of stack && !external ? [false, true] : [false]) {
    for (const transport of stack ? ["sync", "suffix", "accept"] : ["sync"]) {
      test(`restart handler leaves no manual intent after its start fails: stack=${stack} external=${external} apply=${applyDefinition} transport=${transport}`, async (t) => {
        const f = fixture(t, stack, "failed-after-events", external, true);
        const url = stack ? `/stacks/${id}/actions/restart${transport === "suffix" ? "-stream" : ""}` : `/containers/${id}/restart`;
        const response = await request(url, { body: stack ? { ...f.body, applyDefinition } : f.body,
          ...(transport === "accept" ? { accept: "application/x-ndjson" } : {}) });
        assert.equal(f.stopped(), true);
        assert.deepEqual(f.annotations, []);
        assert.deepEqual(stopIntents.list(), []);
        assert.equal(stopIntents.isHubRestartActive(id), false);
        assert.deepEqual(stopIntents.recentExits().map((exit) => exit.kind), f.ids.map(() => "unexpected"));
        assert.equal(f.records.length, 1); assert.equal(f.records[0].outcome, "error");
        assert.equal(f.records[0].action, stack ? "stack-restart" : "restart");
        if (response.headers["content-type"] === "application/x-ndjson; charset=utf-8") {
          const result = stackActionStreamLineSchema.parse(JSON.parse(response.chunks.at(-1)!));
          assert.equal("status" in result ? result.status : undefined, 502);
        } else assert.equal(response.status, stack ? 502 : 503);
      });
    }
  }
}
