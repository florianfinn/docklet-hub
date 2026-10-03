import test from "node:test";
import assert from "node:assert/strict";

import { composeApplyStepSchema } from "contract";

import {
  CONTAINER_ID,
  CONTAINER_NAME,
  COMPOSE_CONTENT,
  COMPOSE_FILE_NAME,
  PROJECT_NAME,
  SERVICE_NAME,
  SHARE,
  schemaRefusals,
  startAgent
} from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { REGISTRY_SYNC_ACTOR, syncRegistry } from "../../domain/containers/index.js";
import { applyCompose, applyComposeStreaming, previewComposeOnAgent, readProjectEnv } from "./agent-client.js";
import type { ComposeStreamStep } from "./types.js";

// The contract test of #272 for the compose surface: the hub's agent client
// against the agent's REAL handlers in this process, with only Docker faked
// (`platform/agent-transport/agent-roundtrip-test-support.ts`). Every stream
// line the agent writes runs through the hub's schema check, so a line in a
// shape the hub does not read is missing below. And no request of the hub may
// meet a schema refusal of the agent (`schemaRefusals`): that would be the two
// sides disagreeing about a field.

const USER = { kind: "user" as const, id: "u-1" };

test("Compose: start, schritt und ergebnis des echten Agenten; die Vorschau und die Umgebung ebenso", async (t) => {
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
        sharePath: SHARE
      }
    ],
    { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl }
  );
  const options = { actor: USER, fetchImpl: agent.fetchImpl };
  const draft = `${COMPOSE_CONTENT}    restart: unless-stopped\n`;

  const preview = await previewComposeOnAgent(agent.target, CONTAINER_ID, draft, options);
  assert.equal(preview.source, "agent");

  const input = {
    content: draft,
    expectedComposeHash: agent.composeHash,
    stackName: PROJECT_NAME,
    confirmNew: [],
    confirmRemoved: [],
    acknowledgeImagePull: [],
    acknowledgeHardening: []
  };
  const starts: unknown[] = [];
  const steps: ComposeStreamStep[] = [];
  const result = await applyComposeStreaming(agent.target, CONTAINER_ID, input, {
    ...options,
    signal: new AbortController().signal,
    onStart: (start) => starts.push(start),
    onStep: (step) => {
      steps.push(step);
    }
  });

  assert.deepEqual(starts, [
    { projectDir: agent.projectDir, composeFileName: COMPOSE_FILE_NAME, stackName: PROJECT_NAME }
  ]);
  // The first step of applying (`composeApplyStepSchema`), and only that one.
  assert.deepEqual(steps, [{ step: composeApplyStepSchema.options[0], detail: null }]);
  // The fake `docker compose config` fails, and the agent names that in its
  // result line. Reaching the named question is the proof the line was read.
  assert.equal(result.ok, false);

  // The same request without the stream, the way older arms are written to.
  assert.equal((await applyCompose(agent.target, CONTAINER_ID, input, options)).ok, false);

  // The project environment, over the arm's internal route.
  const env = await readProjectEnv(agent.target, CONTAINER_ID, true, options);
  assert.equal(env.filePresent, true);

  assert.deepEqual(schemaRefusals(agent), []);
});
