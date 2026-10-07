import { RuntimeActionFailure } from "./action-failure.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_QUEUE_WAIT_MS, HUB_RUNTIME_TIMEOUT_MS, LIFECYCLE_TIMEOUT_MS,
  MAX_STOP_GRACE_MS, RUNTIME_READBACK_RESERVE_MS, RUNTIME_TRANSPORT_RESERVE_MS,
  type RuntimeAction, type StackActionRequest
} from "contract";
import { executeStackRuntimeAction, type StackRuntimeOps } from "./stack-runtime-action.js";
import { StackEndpointError } from "./stack-control.js";
import type { PreparedStack, StackContextResponse } from "./runtime/stack.js";

async function stackResult(...args: Parameters<typeof executeStackRuntimeAction>) {
  let mutationStarted = false;
  try {
    return await executeStackRuntimeAction(args[0], args[1], args[2], {
      ...args[3], onMutation: () => { mutationStarted = true; args[3]?.onMutation?.(); }
    });
  } catch (error) {
    assert.ok(error instanceof RuntimeActionFailure);
    return { ...error.failure, mutationStarted,
      body: error.failure.body as Awaited<ReturnType<typeof executeStackRuntimeAction>>["body"] };
  }
}

function fixture(external = false, missing = false) {
  const service = { serviceName: "web", containerId: missing ? null : "old", containerName: "app-web-1", imageRef: "example/app:1.0",
    status: missing ? "missing" : "exited", startedAt: "seen", exitCode: 1, health: null, stopTimeoutSeconds: 90,
    running: false, missing, allowed: true, delegationLocked: false, hardeningVerified: true };
  const context: StackContextResponse = {
    projectName: "app", projectDir: "/srv/apps/app", composeFileName: "compose.yaml", anchorServiceName: "web",
    state: "stopped", readOnly: false, services: [service], couplings: [], missingServices: missing ? ["web"] : [], runningServices: []
  };
  const entry = { containerId: "old", containerName: "app-web-1", imageRef: "example/app:1.0", allowed: true, observeOnly: false,
    externallyManaged: external, secured: false };
  const prepared: PreparedStack = {
    project: { projectName: "app", projectDir: "/srv/apps/app", composeFileName: "compose.yaml", anchorEntry: entry, anchorServiceName: "web" },
    context, definition: { services: ["web"], couplings: [] },
    normalized: { services: { web: { image: "example/app:1.0", stop_grace_period: "2m" } } },
    externallyManaged: external, entriesByService: new Map([["web", entry]])
  };
  const calls: Array<{ name: string; args?: unknown }> = [];
  let after: StackContextResponse = { ...context, services: [{ ...service, missing: false, containerId: "new", status: "running", startedAt: "later", exitCode: 0 }] };
  const ops: StackRuntimeOps = {
    prepare: async () => { calls.push({ name: "config" }); return prepared; },
    checkRuntimeScope: () => {},
    checkCreateScope: () => { calls.push({ name: "scope" }); },
    imageId: async (ref) => { calls.push({ name: "image", args: ref }); return "image-id"; },
    up: async (args) => { calls.push({ name: "up", args }); },
    start: async (timeoutMs) => { calls.push({ name: "start", args: timeoutMs }); },
    stop: async (timeoutMs) => { calls.push({ name: "stop", args: timeoutMs }); },
    restart: async (timeoutMs, startWithUp) => { calls.push({ name: startWithUp ? "stop-up" : "stop-start", args: timeoutMs }); },
    refresh: async () => { calls.push({ name: "reanchor-read" }); return after; }
  };
  const body: StackActionRequest = { applyDefinition: false, expectedStack: {
    projectName: "app", projectDir: "/srv/apps/app", composeFileName: "compose.yaml",
    services: [{ serviceName: "web", containerId: service.containerId, status: service.status, startedAt: service.startedAt }]
  } };
  return { prepared, ops, calls, body, setAfter: (value: StackContextResponse) => { after = value; } };
}

for (const action of ["start", "stop", "restart"] as const) for (const applyDefinition of [true, false]) {
  test(`own stack ${action}, apply definition ${applyDefinition}`, async () => {
    const f = fixture(false, action === "start");
    f.body.applyDefinition = applyDefinition;
    if (action === "stop") f.setAfter({ ...f.prepared.context, services: f.prepared.context.services });
    const result = await stackResult(f.ops, action, f.body);
    const creating = action !== "stop";
    const command = action === "restart" && !applyDefinition ? "stop-up" : "up";
    assert.deepEqual(f.calls.map((call) => call.name), creating
      ? ["config", "scope", "image", "scope", command, "reanchor-read"]
      : ["config", "stop", "reanchor-read"]);
    if (command === "up" && creating) assert.deepEqual(f.calls.find((call) => call.name === "up")?.args, {
      applyDefinition, forceRecreate: action === "restart", timeoutMs: action === "restart" ? 300_000 : 150_000
    });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.containerIds.web, action === "stop" ? "old" : "new");
  });
}

for (const action of ["start", "restart"] as const) for (const requestedMode of [true, false]) {
  test(`foreign stack ${action} forces definition off (requested ${requestedMode})`, async () => {
    const f = fixture(true);
    f.body.applyDefinition = requestedMode;
    const result = await stackResult(f.ops, action, f.body);
    assert.deepEqual(f.calls.map((call) => call.name), ["config", action === "restart" ? "stop-start" : "start", "reanchor-read"]);
    assert.equal(result.body.applyDefinition, false);
  });
}

test("foreign stacks report missing services as partial without creation", async () => {
  const f = fixture(true);
  f.prepared.context.services.push({ ...f.prepared.context.services[0], serviceName: "job", containerId: null, missing: true, status: "missing" });
  f.body.expectedStack.services.push({ serviceName: "job", containerId: null, status: "missing", startedAt: "seen" });
  f.setAfter({ ...f.prepared.context, services: [
    { ...f.prepared.context.services[0], status: "running" }, f.prepared.context.services[1]
  ] });
  const result = await stackResult(f.ops, "start", f.body);
  assert.equal(result.body.outcome, "partial");
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "runtime-target-not-reached");
  assert.equal(result.body.services[1].outcome, "not-created-externally-managed");
  assert.equal(f.calls.some((call) => call.name === "up"), false);
});

for (const action of ["start", "restart"] as const) for (const error of ["runtime-image-missing", "stack-service-not-allowlisted", "externally-managed"]) {
  test(`preflight ${error} leaves the stack unchanged before ${action} and rereads ids`, async () => {
    const f = fixture();
    f.setAfter(f.prepared.context);
    if (error === "runtime-image-missing") f.ops.imageId = async () => null;
    else f.ops.checkCreateScope = () => { throw new StackEndpointError(403, error); };
    const result = await stackResult(f.ops, action, f.body);
    assert.equal(result.body.error, error);
    assert.equal(result.mutationStarted, false);
    assert.equal(f.calls.some((call) => ["up", "start", "stop", "stop-start", "stop-up"].includes(call.name)), false);
    assert.equal(result.body.containerIds.web, "old");
    assert.equal(f.calls.at(-1)?.name, "reanchor-read");
  });
}

for (const change of ["id", "status", "startedAt"]) {
  test(`stack expectation refuses changed ${change} before mutation`, async () => {
    const f = fixture();
    const expected = f.body.expectedStack.services[0];
    if (change === "id") expected.containerId = "different";
    if (change === "status") expected.status = "running";
    if (change === "startedAt") expected.startedAt = "different";
    const result = await stackResult(f.ops, "restart", f.body);
    assert.equal(result.body.error, "state-changed");
    assert.equal(result.mutationStarted, false);
    assert.deepEqual(f.calls.map((call) => call.name), ["config", "reanchor-read"]);
    assert.equal(result.body.containerIds.web, "new");
  });
}

test("a CLI failure returns replacement ids and the actual per-service states", async () => {
  const f = fixture();
  f.ops.up = async () => { throw new Error("failed after replacement"); };
  f.setAfter({ ...f.prepared.context, services: [{ ...f.prepared.context.services[0], containerId: "replaced", status: "exited", exitCode: 2, health: "unhealthy" }] });
  const result = await stackResult(f.ops, "start", f.body);
  assert.equal(result.body.containerIds.web, "replaced");
  assert.equal(result.body.outcome, "failed");
  assert.equal(result.body.services[0].exitCode, 2);
  assert.equal(result.body.services[0].health, "unhealthy");
  assert.equal(result.body.error, "internal-error");
  assert.equal(result.mutationStarted, true);
});

test("stream callbacks preserve the exact synchronous result", async () => {
  const f = fixture();
  const kinds: string[] = [];
  const streamResult = await stackResult(f.ops, "start", f.body, {
    onStart: () => { kinds.push("start"); }, onProgress: () => { kinds.push("progress"); }
  });
  const sync = fixture();
  assert.deepEqual(streamResult, await stackResult(sync.ops, "start", sync.body));
  assert.deepEqual(kinds, ["start", "progress", "progress"]);
});

test("an aborted caller is discarded before the first mutation", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await stackResult(f.ops, "stop", f.body, { signal: controller.signal });
  assert.equal(result.body.error, "action-caller-disconnected");
  assert.equal(result.mutationStarted, false);
  assert.equal(f.calls.some((call) => call.name === "stop"), false);
});

test("failed state read is an unknown outcome with no stale ids", async () => {
  const f = fixture();
  f.ops.refresh = async () => { throw new Error("read failed"); };
  const result = await stackResult(f.ops, "start", f.body);
  assert.equal(result.body.error, "internal-error");
  assert.equal(result.mutationStarted, true);
  assert.equal(result.body.outcome, "failed");
  assert.deepEqual(result.body.containerIds, {});
});

for (const action of ["start", "restart"] as RuntimeAction[]) {
  test(`one-shot exit zero succeeds for stack ${action}`, async () => {
    const f = fixture();
    f.setAfter({ ...f.prepared.context, services: [{ ...f.prepared.context.services[0], status: "exited", exitCode: 0 }] });
    assert.equal((await stackResult(f.ops, action, f.body)).body.ok, true);
  });
}

test("permission changes during image preflight still block the creating command", async () => {
  const f = fixture();
  let revoked = false;
  f.ops.imageId = async () => { revoked = true; return "local-image"; };
  f.ops.checkCreateScope = () => { if (revoked) throw new StackEndpointError(403, "externally-managed"); };
  const result = await stackResult(f.ops, "start", f.body);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, "externally-managed");
  assert.equal(result.mutationStarted, false);
  assert.equal(f.calls.some((call) => call.name === "up"), false);
});

test("runtime permission revocation also blocks stop and the non-creating restart", async () => {
  for (const action of ["stop", "restart"] as const) {
    const f = fixture();
    f.ops.checkRuntimeScope = () => { throw new StackEndpointError(403, "stack-service-gate-denied"); };
    const result = await stackResult(f.ops, action, f.body);
    assert.equal(result.status, 403);
    assert.equal(result.mutationStarted, false);
    assert.equal(f.calls.some((call) => ["stop", "stop-start"].includes(call.name)), false);
  }
});

test("a queued stack request sees the predecessor's completed state and refuses stale expectations", async () => {
  const { KeyedMutex } = await import("./concurrency.js");
  const mutex = new KeyedMutex();
  const f = fixture(true);
  let release!: () => void;
  let starts = 0;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  f.ops.start = async () => { starts++; enter(); await new Promise<void>((resolve) => { release = resolve; }); };
  const originalRefresh = f.ops.refresh;
  f.ops.refresh = async (prepared) => {
    const after = await originalRefresh(prepared);
    f.prepared.context = after;
    return after;
  };
  const first = mutex.runExclusive("app", () => stackResult(f.ops, "start", f.body));
  await entered;
  const second = mutex.runExclusive("app", () => stackResult(f.ops, "start", f.body), { waitMs: 1000 });
  release();
  await first;
  const result = await second;
  assert.equal(starts, 1);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "state-changed");
  assert.equal(result.body.containerIds.web, "new");
});

test("disconnect when opening the stream also prevents a mutation that has not begun", async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = await stackResult(f.ops, "start", f.body, { signal: controller.signal, onStart: () => controller.abort() });
  assert.equal(result.body.error, "action-caller-disconnected");
  assert.equal(result.mutationStarted, false);
  assert.equal(f.calls.some((call) => call.name === "up"), false);
});

for (const external of [false, true]) {
  test(`stack stop treats a missing service as already stopped (external ${external})`, async () => {
    const f = fixture(external);
    f.prepared.context.services.push({ ...f.prepared.context.services[0], serviceName: "job", containerId: null, missing: true, status: "missing" });
    f.body.expectedStack.services.push({ serviceName: "job", containerId: null, status: "missing", startedAt: "seen" });
    f.setAfter(f.prepared.context);
    const result = await stackResult(f.ops, "stop", f.body);
    assert.equal(result.status, 200);
    assert.equal(result.body.outcome, "ok");
    assert.deepEqual(result.body.services.map((service) => service.outcome), ["ok", "ok"]);
  });
}

test("own restart with definition off prechecks and creates missing services without recreation", async () => {
  const f = fixture(false, true);
  const result = await stackResult(f.ops, "restart", f.body);
  assert.equal(result.body.ok, true);
  assert.deepEqual(f.calls.map((call) => call.name), ["config", "scope", "image", "scope", "stop-up", "reanchor-read"]);
});


test("all stack dispatch paths pass deadlines covered by the hub and browser budgets", async () => {
  for (const external of [false, true]) for (const applyDefinition of [false, true]) {
    for (const action of ["start", "stop", "restart"] as const) {
      for (const grace of [MAX_STOP_GRACE_MS / 1000, -1, 2000]) {
        const { prepared, ops, calls, body } = fixture(external);
        prepared.context.services[0].stopTimeoutSeconds = grace;
        prepared.normalized = { services: { web: { image: "example/app:1.0", stop_grace_period: "2h" } } };
        await stackResult(ops, action, { ...body, applyDefinition });
        const mutation = calls.find((call) => ["up", "start", "stop", "stop-up", "stop-start"].includes(call.name));
        assert.ok(mutation, `${external}/${applyDefinition}/${action}/${grace}`);
        const timeoutMs = mutation.name === "up" ? (mutation.args as { timeoutMs: number }).timeoutMs : mutation.args as number;
        assert.ok(HUB_RUNTIME_TIMEOUT_MS >= ACTION_QUEUE_WAIT_MS + timeoutMs
          + RUNTIME_READBACK_RESERVE_MS + RUNTIME_TRANSPORT_RESERVE_MS);
        assert.ok(LIFECYCLE_TIMEOUT_MS > HUB_RUNTIME_TIMEOUT_MS);
      }
    }
  }
});
