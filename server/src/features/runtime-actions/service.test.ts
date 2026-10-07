import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeActionsService } from "./service.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import type { HubContainerRuntimeResult } from "contract";
const ID = "demo";
const EXPECTED = { containerId: ID, status: "running", startedAt: null };
const STACK = { projectName: "demo", projectDir: "/srv/example/demo", composeFileName: "compose.yml", services: [] };
const containerResult = (): HubContainerRuntimeResult => ({ ok: true, action: "start", outcome: "ok",
  state: { ...EXPECTED, exitCode: null, health: null } });

test("unreachable hosts reject after access checking without waiting for refresh, and malformed bodies cannot execute", { timeout: 5000 }, async () => {
  let opened = 0;
  let refreshed = 0;
  const service = createRuntimeActionsService({
    openContainer: async () => { opened++; return { ok: false, failure: { kind: "problem", status: 503,
      error: "host-unreachable", message: "Agent nicht erreichbar." } }; }, readApplyDefinition: async () => true,
    liveEvents: { refresh: async () => { refreshed++; return new Promise(() => undefined); } }
  });
  const ref = { hostId: "demo", containerId: ID, userId: "human" };
  await assert.rejects(service.execute(ref, "start", { expectedContainer: EXPECTED }, new AbortController().signal),
    (error: unknown) => error instanceof AgentError && error.status === 503 &&
      (error.detail as { error: string }).error === "runtime-host-offline");
  assert.equal(opened, 1);
  assert.equal(refreshed, 1);
  for (const body of [null, [], {}]) await assert.rejects(service.execute(ref, "start", body, new AbortController().signal),
    (error: unknown) => error instanceof AgentError && error.status === 400);
  assert.equal(opened, 1);
  assert.equal(refreshed, 1);
});

test("refresh rejection cannot hide a completed action and container calls never read the mode", async () => {
  let modes = 0;
  let refreshed = 0;
  const service = createRuntimeActionsService({
    openContainer: async () => ({ ok: true, access: { target: { baseUrl: "http://agent.example.org", secret: "synthetic" },
      options: { actor: { kind: "user", id: "human" } } } as never }),
    readApplyDefinition: async () => { modes++; return true; },
    agent: { runContainer: async () => containerResult(), runStack: async () => undefined },
    liveEvents: { refresh: async () => { refreshed++; throw new Error("private diagnostic"); } }
  });
  assert.deepEqual(await service.execute({ hostId: "demo", containerId: ID, userId: "human" }, "start",
    { expectedContainer: EXPECTED }, new AbortController().signal), containerResult());
  assert.equal(modes, 0);
  assert.equal(refreshed, 1);
});

test("browser abort during access prevents the action and still refreshes the expected stack", async () => {
  const caller = new AbortController();
  let actions = 0;
  let refreshed: unknown;
  const service = createRuntimeActionsService({
    openContainer: async () => { caller.abort(); return { ok: true, access: {} as never }; },
    readApplyDefinition: async () => true,
    agent: { runContainer: async () => { actions++; return containerResult(); }, runStack: async () => { actions++; } },
    liveEvents: { refresh: async (_hostId, target) => { refreshed = target; return []; } }
  });
  await assert.rejects(service.execute({ hostId: "demo", containerId: ID, userId: "human" }, "start",
    { expectedStack: STACK }, caller.signal, { signal: caller.signal, open: () => undefined, write: async () => undefined }));
  assert.equal(actions, 0);
  assert.deepEqual(refreshed, { project: "demo" });
});

test("unexpected hub failures become internal-error and still trigger refresh", async () => {
  let refreshed = 0;
  const service = createRuntimeActionsService({
    openContainer: async () => { throw new Error("private database diagnostic"); }, readApplyDefinition: async () => true,
    liveEvents: { refresh: async () => { refreshed++; return []; } }
  });
  await assert.rejects(service.execute({ hostId: "demo", containerId: ID, userId: "human" }, "start",
    { expectedContainer: EXPECTED }, new AbortController().signal), (error: unknown) => {
    assert.equal(error instanceof AgentError, true);
    assert.deepEqual((error as AgentError).detail, { error: "internal-error" });
    assert.equal(String(error).includes("private database diagnostic"), false);
    return true;
  });
  assert.equal(refreshed, 1);
});
