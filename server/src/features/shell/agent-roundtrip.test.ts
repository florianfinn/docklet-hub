import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTAINER_ID,
  CONTAINER_NAME,
  COMPOSE_FILE_NAME,
  FAKE_SHELL_ECHO,
  PROJECT_NAME,
  SERVICE_NAME,
  schemaRefusals,
  startAgent
} from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { REGISTRY_SYNC_ACTOR, syncRegistry } from "../../domain/containers/index.js";
import { closeExec, resize, sendInput, startExec } from "./agent-client.js";

// The contract test of #272 for the shell: the hub's agent client against the
// agent's REAL exec handlers in this process, with only Docker faked
// (`platform/agent-transport/agent-roundtrip-test-support.ts`). Every stream
// line the agent writes runs through the hub's schema check, and no request of
// the hub may meet a schema refusal of the agent (`schemaRefusals`): that would
// be the two sides disagreeing about a field.

test("Shell: start, aus und ende des echten Agenten, dazu Eingabe, Größe und Schließen", async (t) => {
  const agent = await startAgent();
  t.after(agent.stop);
  await syncRegistry(
    agent.target,
    [
      {
        containerId: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        imageRef: "nginx:1.27",
        allowed: true,
        compose: {
          projectDir: agent.projectDir,
          projectName: PROJECT_NAME,
          serviceName: SERVICE_NAME,
          composeFileName: COMPOSE_FILE_NAME,
          origin: "adopted"
        },
        sharePath: null
      }
    ],
    { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl }
  );
  const options = { actor: { kind: "user" as const, id: "u-1" }, fetchImpl: agent.fetchImpl };
  const output: string[] = [];
  const pending: Promise<unknown>[] = [];
  let shell: string | null = null;
  let agentSession = "";
  let giveUp: NodeJS.Timeout | undefined;

  const outcome = await startExec(
    agent.target,
    CONTAINER_ID,
    {
      ...options,
      cols: 80,
      rows: 24,
      signal: new AbortController().signal,
      onStart: (start) => {
        shell = start.shell;
        agentSession = start.agentSession;
        // A request the agent reads differently ends in no answer, not in a
        // refusal (`data` defaults to ""): the shell then stays open. Closed
        // after a while, the test fails on the output instead of hanging.
        giveUp = setTimeout(() => void closeExec(agent.target, start.agentSession, options).catch(() => {}), 5_000);
        pending.push(
          (async () => {
            await resize(agent.target, start.agentSession, { cols: 120, rows: 40 }, options);
            await sendInput(agent.target, start.agentSession, new TextEncoder().encode("ping\n"), options);
          })().catch(async (error: unknown) => {
            // Without the answer the stream would never end: close it, and
            // let the test fail with the refusal.
            await closeExec(agent.target, start.agentSession, options);
            throw error;
          })
        );
      }
    },
    (text) => {
      output.push(text);
      if (text.includes("pong")) {
        // The session id is the one from `start`; the agent knows only that.
        pending.push(closeExec(agent.target, agentSession, options));
      }
    }
  );
  clearTimeout(giveUp);
  await Promise.all(pending);

  assert.equal(shell, "bash");
  assert.equal(output.join(""), FAKE_SHELL_ECHO);
  assert.equal(outcome.kind, "ended");
  assert.deepEqual(schemaRefusals(agent), []);
});
