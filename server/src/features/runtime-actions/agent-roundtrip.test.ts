import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { startAgent, schemaRefusals, CONTAINER_ID, CONTAINER_NAME, PROJECT_NAME, SERVICE_NAME,
  COMPOSE_FILE_NAME } from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { syncRegistry, REGISTRY_SYNC_ACTOR } from "../../domain/containers/index.js";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { runContainer, runStack } from "./agent-client.js";

// Stale state and a fake config failure stop before any Docker mutation.
test("runtime clients reach the real agent handlers with contract 13 expectations and mode", async (t) => {
  let composeCalls = 0;
  t.mock.method(childProcess, "execFile", ((_binary: string, _args: string[], _options: unknown,
    callback: (error: Error, stdout: string, stderr: string) => void) => {
    composeCalls++;
    queueMicrotask(() => callback(new Error("fake config failure"), "", "private diagnostic"));
    return new EventEmitter();
  }) as never);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const agent = await startAgent(); t.after(agent.stop);
  await syncRegistry(agent.target, [{ containerId: CONTAINER_ID, containerName: CONTAINER_NAME,
    imageRef: "nginx:1.27", allowed: true, sharePath: "data", compose: { projectDir: agent.projectDir, projectName: PROJECT_NAME,
      serviceName: SERVICE_NAME, composeFileName: COMPOSE_FILE_NAME, origin: "adopted" } }],
  { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl });
  const expected = { containerId: CONTAINER_ID, status: "exited", startedAt: null };
  const options = { actor: { kind: "user" as const, id: "demo-human" }, fetchImpl: agent.fetchImpl,
    signal: new AbortController().signal };
  for (const action of ["start", "stop", "restart"] as const) {
    await assert.rejects(runContainer(agent.target, CONTAINER_ID, action, { expectedContainer: expected }, options),
      (error: unknown) => error instanceof AgentError && error.status === 409 &&
        (error.detail as { error: string }).error === "state-changed");
    const body = { expectedStack: { projectName: PROJECT_NAME, projectDir: agent.projectDir,
      composeFileName: COMPOSE_FILE_NAME, services: [{ serviceName: SERVICE_NAME, ...expected }] },
      ...(action === "stop" ? {} : { applyDefinition: true }) };
    await assert.rejects(runStack(agent.target, CONTAINER_ID, action, body, options,
      { signal: options.signal, open: () => undefined, write: async () => undefined }),
    (error: unknown) => error instanceof AgentError && error.status === 502 &&
      (error.detail as { error: string }).error === "compose-action-failed");
  }
  assert.equal(composeCalls, 3);
  assert.deepEqual(schemaRefusals(agent), []);
});
