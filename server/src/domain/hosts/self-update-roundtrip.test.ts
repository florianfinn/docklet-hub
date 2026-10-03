import test, { after, before } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import {
  CONTAINER_ID,
  CONTAINER_NAME,
  COMPOSE_FILE_NAME,
  PROJECT_NAME,
  SERVICE_NAME,
  SHARE,
  schemaRefusals,
  startAgent,
  type AgentUnderTest
} from "../../platform/agent-transport/agent-roundtrip-test-support.js";
import { REGISTRY_SYNC_ACTOR, syncRegistry } from "../containers/index.js";
import { requestSelfUpdate } from "./self-update.js";
import { AgentError, agentGet, agentPut } from "../../platform/agent-transport/protocol.js";

// The contract test of #272 for the request of the self-update: the hub's
// agent client against the agent's REAL handlers in this process, with only
// Docker faked (`platform/agent-transport/agent-roundtrip-test-support.ts`).
// The log stream, the shell, the files and the compose surface (the apply
// stream, the preview and the project environment) have their own files
// inside their features (`features/<name>/agent-roundtrip.test.ts`). This one
// stood in `server/src/agent/` until #271 dissolved that folder; the
// self-update belongs to `domain/hosts/` (`self-update.ts`).
//
// Two things are checked. Every stream line the agent writes runs through the
// hub's schema check, so a line in a shape the hub does not read is missing
// below. And no request of the hub may meet a schema refusal of the agent
// (`schemaRefusals`): that would be the two sides disagreeing about a field.

const USER = { kind: "user" as const, id: "u-1" };

// One agent for the whole file: it reads its configuration once
// (`startAgent`). The tests share its allowlist and its share directory.
let agent: AgentUnderTest;

before(async () => {
  agent = await startAgent();
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
});

after(async () => {
  await agent.stop();
});

test("Anfrageform: das Selbst-Update trifft keine Schemaprüfung", async () => {
  // The agent refuses the update itself (it cannot prove its own container
  // here), but with a reason of its own and not over the shape of the request.
  await assert.rejects(
    requestSelfUpdate(agent.target, "ghcr.io/florianfinn/dashboard-docker-agent:v9.9.9", {
      actor: USER,
      fetchImpl: agent.fetchImpl
    })
  );
  const refusal = agent.refusals.find((entry) => entry.path === "/self-update");
  assert.ok(refusal, "the self-update request reached the agent");

  assert.deepEqual(schemaRefusals(agent), []);
});

test("eine Anfrage mit falschem Feld: 400 mit Schlüssel und Feld, ins Audit-Log ohne den Inhalt", async () => {
  const secretLooking = "hunter2-darf-nirgends-stehen";
  const refused = await agentPut(
    agent.target,
    "/registry",
    { entries: [{ containerId: CONTAINER_ID, containerName: { value: secretLooking }, imageRef: "nginx:1.27", allowed: true }] },
    { actor: REGISTRY_SYNC_ACTOR, fetchImpl: agent.fetchImpl }
  ).then(
    () => null,
    (error: unknown) => error
  );

  assert.ok(refused instanceof AgentError);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.detail, { error: "invalid-request", field: "entries.0.containerName" });

  const audit = readFileSync(agent.auditFile, "utf8");
  const last = JSON.parse(audit.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(last.action, "registry-sync");
  assert.equal(last.outcome, "denied");
  assert.equal(last.reason, "invalid-request (entries.0.containerName)");
  assert.ok(!audit.includes(secretLooking), "the audit log carries the content of the refused field");

  // Refused as a whole: the allowlist from before still holds, otherwise this
  // would be `404 not-allowlisted`.
  const env = await agentGet(agent.target, `/containers/${CONTAINER_ID}/env?plaintext=1`, {
    actor: USER,
    fetchImpl: agent.fetchImpl
  });
  assert.equal((env as { filePresent?: unknown }).filePresent, true);
});
