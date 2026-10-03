import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTAINER_ID,
  CONTAINER_NAME,
  COMPOSE_FILE_NAME,
  FAKE_LOG_LINES,
  PROJECT_NAME,
  SERVICE_NAME,
  schemaRefusals,
  startAgent
} from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { syncRegistry, REGISTRY_SYNC_ACTOR } from "../../domain/containers/index.js";
import { streamLogs, type LogLine, type LogStreamFailure, type LogStreamStart } from "./agent-client.js";

// The contract test of #272 for the log stream: the hub's `streamLogs` against
// the agent's real `logs-stream` handler, with only Docker faked
// (`platform/agent-transport/agent-roundtrip-test-support.ts`). Every line the
// agent writes runs through the hub's schema check, so a line it sends in a
// shape the hub does not read would be missing below.

test("Logstrom: der Hub liest start, zeile und fehler des echten Agenten", async (t) => {
  const agent = await startAgent();
  t.after(agent.stop);
  const options = { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl };

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
    options
  );

  const starts: LogStreamStart[] = [];
  const failures: LogStreamFailure[] = [];
  const lines: LogLine[] = [];
  await streamLogs(
    agent.target,
    CONTAINER_ID,
    {
      actor: { kind: "user", id: "u-1" },
      fetchImpl: agent.fetchImpl,
      tail: 50,
      signal: new AbortController().signal,
      onStart: (start) => starts.push(start),
      onFailure: (failure) => failures.push(failure)
    },
    (line) => {
      lines.push(line);
    }
  );

  assert.deepEqual(starts, [{ containerName: CONTAINER_NAME, tty: false }]);
  assert.deepEqual(lines, FAKE_LOG_LINES.map((line) => ({ ...line })));
  assert.deepEqual(failures, [{ reason: "container-gone" }]);
  assert.deepEqual(schemaRefusals(agent), []);
});
