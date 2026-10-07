import { RuntimeActionFailure } from "./action-failure.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION, containerActionRequestSchema, stackActionRequestSchema, stackRuntimeActionRequestSchema,
  stackRuntimeResultSchema, stackActionStreamLineSchema, type RuntimeAction
} from "contract";
import {
  containerActionTimeoutMs, gracePeriodSeconds, stackActionTimeoutMs,
  runtimeStateOf, serviceResult, runtimeOutcome, expectedContainerMatches
} from "./runtime-actions.js";
import { executeContainerRuntimeAction } from "./container-runtime-action.js";
import { EngineError } from "./engine.js";
import { buildUpArgs } from "./compose-cli.js";

async function containerResult(...args: Parameters<typeof executeContainerRuntimeAction>) {
  try { return await executeContainerRuntimeAction(...args); }
  catch (error) {
    assert.ok(error instanceof RuntimeActionFailure);
    return { ...error.failure, body: error.failure.body as Awaited<ReturnType<typeof executeContainerRuntimeAction>>["body"] };
  }
}

const state = runtimeStateOf({ Id: "id", Name: "/app", State: { Status: "running", ExitCode: 0, StartedAt: "seen", Health: { Status: "unhealthy" } } });
const expected = { containerId: "id", status: "running", startedAt: "seen" };

test("contract 12 requires the mode and observed runtime state", () => {
  assert.equal(CONTRACT_VERSION, 12);
  assert.equal(containerActionRequestSchema.safeParse({}).success, false);
  assert.equal(containerActionRequestSchema.safeParse({ expectedContainer: expected }).success, true);
  const stack = { projectName: "app", projectDir: "/srv/apps/app", composeFileName: "compose.yaml", services: [{ serviceName: "web", ...expected }] };
  assert.equal(stackRuntimeActionRequestSchema.safeParse({ expectedStack: stack, allowFallbackUp: true }).success, false);
  assert.equal(stackRuntimeActionRequestSchema.safeParse({ expectedStack: stack, applyDefinition: true }).success, true);
  assert.equal(stackActionRequestSchema.safeParse({ expectedStack: stack }).success, true);
  assert.equal(stackActionRequestSchema.safeParse({ expectedStack: { ...stack, services: [{ serviceName: "web", containerId: "id" }] }, applyDefinition: true }).success, false);
});

test("runtime up has no health wait, build, pull or removal in either mode", () => {
  for (const applyDefinition of [true, false]) for (const action of ["start", "restart"] as const) {
    const args = buildUpArgs({ projectDir: "/srv/apps/app", composeFileName: "compose.yaml", projectName: "app" }, {
      removeOrphans: false, pullNever: true, wait: false, noRecreate: !applyDefinition,
      forceRecreate: applyDefinition && action === "restart"
    });
    assert.equal(args.includes("--wait"), false);
    assert.equal(args.includes("--no-build"), true);
    assert.deepEqual(args.slice(args.indexOf("--pull"), args.indexOf("--pull") + 2), ["--pull", "never"]);
    assert.equal(args.includes("--remove-orphans"), false);
    assert.equal(args.includes("--no-recreate"), !applyDefinition);
    assert.equal(args.includes("--force-recreate"), applyDefinition && action === "restart");
    assert.equal(args.includes("down"), false);
  }
});

test("stop deadlines include Docker's configured grace period and a buffer", () => {
  assert.equal(containerActionTimeoutMs("stop", undefined), 20_000);
  assert.equal(containerActionTimeoutMs("stop", 90), 100_000);
  assert.equal(containerActionTimeoutMs("restart", 0), 10_000);
  assert.equal(containerActionTimeoutMs("start", 90), 30_000);
  assert.equal(containerActionTimeoutMs("stop", -1), 610_000);
  assert.equal(stackActionTimeoutMs("stop", [10, 120]), 150_000);
  assert.equal(stackActionTimeoutMs("restart", [120]), 300_000);
  assert.equal(stackActionTimeoutMs("start", [10]), 60_000);
  assert.equal(stackActionTimeoutMs("restart", [2000]), 600_000);
  assert.equal(stackActionTimeoutMs("stop", []), 60_000);
});

test("Compose grace periods accept normalized composite and fractional durations", () => {
  assert.equal(gracePeriodSeconds("1m30s"), 90);
  assert.equal(gracePeriodSeconds("1.5s250ms"), 1.75);
  assert.equal(gracePeriodSeconds("2h"), 7200);
  assert.equal(gracePeriodSeconds(undefined), 10);
  assert.equal(gracePeriodSeconds("garbage30s"), 10);
});

test("health is reported without becoming a runtime success condition", () => {
  const service = serviceResult("start", "web", state, false);
  assert.equal(service.health, "unhealthy");
  assert.equal(service.outcome, "ok");
  assert.equal(serviceResult("stop", "web", state, false).outcome, "failed");
});

test("exit code zero succeeds as a one-shot job for start and restart", () => {
  for (const action of ["start", "restart"] as const) {
    assert.equal(serviceResult(action, "job", { ...state, status: "exited", exitCode: 0 }, false).outcome, "ok");
    assert.equal(serviceResult(action, "job", { ...state, status: "exited", exitCode: 1 }, false).outcome, "failed");
    assert.equal(serviceResult(action, "job", { ...state, status: "restarting" }, false).outcome, "failed");
  }
  assert.equal(serviceResult("stop", "job", { ...state, status: "exited", exitCode: 137 }, false).outcome, "ok");
});

test("runtime results distinguish ok, partial, failed and external missing services", () => {
  const ok = serviceResult("start", "web", state, false);
  const missing = serviceResult("start", "job", runtimeStateOf(null), true);
  assert.equal(missing.outcome, "not-created-externally-managed");
  assert.equal(runtimeOutcome([ok]), "ok");
  assert.equal(runtimeOutcome([ok, missing]), "partial");
  assert.equal(runtimeOutcome([missing]), "failed");
  assert.equal(runtimeOutcome([]), "failed");
});

test("container expectations catch a changed state or restart with the same id", () => {
  assert.equal(expectedContainerMatches(expected, state), true);
  assert.equal(expectedContainerMatches(expected, { ...state, status: "exited" }), false);
  assert.equal(expectedContainerMatches(expected, { ...state, startedAt: "later" }), false);
  assert.equal(expectedContainerMatches(expected, { ...state, containerId: "new" }), false);
});

for (const action of ["start", "stop", "restart"] as const) {
  test(`container ${action} returns the freshly inspected state`, async () => {
    let reads = 0;
    const result = await containerResult({
      execute: async () => {}, inspect: async () => {
        reads++;
        return { Id: "id", Name: "/app", State: { Status: action === "stop" ? "exited" : "running", StartedAt: "later", ExitCode: 0 } };
      }
    }, action, expected, { Id: "id", Name: "/app", State: { Status: "running", StartedAt: "seen" } });
    assert.equal(reads, 1);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.state.startedAt, "later");
  });
}

test("container failures also return the new anchor and state", async () => {
  const result = await containerResult({
    execute: async () => { throw new EngineError("failed", 409); },
    inspect: async () => ({ Id: "new", Name: "/app", State: { Status: "exited", ExitCode: 2 } })
  }, "start", expected, { Id: "id", Name: "/app", State: { Status: "running", StartedAt: "seen" } });
  assert.equal(result.body.error, "engine-action-failed");
  assert.equal(result.body.state.containerId, "new");
  assert.equal(result.body.outcome, "failed");
});

test("changed container state and a disconnected caller prevent mutation", async () => {
  for (const disconnected of [false, true]) {
    let calls = 0;
    const controller = new AbortController();
    if (disconnected) controller.abort();
    const result = await containerResult({
      execute: async () => { calls++; }, inspect: async () => ({ Id: "id", Name: "/app", State: { Status: "exited" } })
    }, "start", expected, { Id: "id", Name: "/app", State: { Status: disconnected ? "running" : "exited", StartedAt: "seen" } }, controller.signal);
    assert.equal(calls, 0);
    assert.equal(result.body.error, disconnected ? "action-caller-disconnected" : "state-changed");
  }
});

test("unreadable container state never reports success", async () => {
  const result = await containerResult({ execute: async () => {}, inspect: async () => { throw new Error("offline"); } },
    "start", expected, { Id: "id", Name: "/app", State: { Status: "running", StartedAt: "seen" } });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.state.status, "unknown");
  assert.equal(result.body.error, "internal-error");
});

test("stream result schemas carry exactly the synchronous runtime result", () => {
  const body = { ok: true, action: "start" as RuntimeAction, applyDefinition: false, outcome: "ok" as const,
    services: [serviceResult("start", "web", state, false)], containerIds: { web: "id" } };
  assert.deepEqual(stackRuntimeResultSchema.parse(body), body);
  assert.deepEqual(stackActionStreamLineSchema.parse({ kind: "result", status: 200, body }), { kind: "result", status: 200, body });
});

test("an already stopped, never-started container satisfies stop after an engine 304", async () => {
  const inspect = { Id: "id", Name: "/app", State: { Status: "created", StartedAt: "seen", ExitCode: 0 } };
  const result = await containerResult({ execute: async () => {}, inspect: async () => inspect },
    "stop", { ...expected, status: "created" }, inspect);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.state.status, "created");
});

test("missing services satisfy stop but unreadable states do not", () => {
  for (const external of [false, true]) {
    assert.equal(serviceResult("stop", "job", runtimeStateOf(null), external).outcome, "ok");
    assert.equal(serviceResult("stop", "job", runtimeStateOf(null, true), external).outcome, "failed");
  }
});

test("shared hub and browser deadlines cover queue and maximum action with delivery reserves", async () => {
  const { HUB_RUNTIME_TIMEOUT_MS, LIFECYCLE_TIMEOUT_MS } = await import("contract");
  const { ACTION_QUEUE_WAIT_MS, MAX_STACK_ACTION_MS } = await import("./runtime-actions.js");
  assert.equal(HUB_RUNTIME_TIMEOUT_MS, ACTION_QUEUE_WAIT_MS + MAX_STACK_ACTION_MS + 30_000);
  assert.equal(LIFECYCLE_TIMEOUT_MS, HUB_RUNTIME_TIMEOUT_MS + 10_000);
});
