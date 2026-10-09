import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR_HEADER, SECRET_HEADER } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import {
  agentUpdateOffer,
  fetchSelfUpdateStatus,
  parseSelfUpdateStatus,
  requestSelfUpdate,
  versionOfImageRef
} from "./self-update.js";

// Geprüft gegen die Formen, die der Agent unter `POST` und `GET /self-update`
// liefert (`dashboard-docker-agent`, `src/index.ts`, Abschnitt „Selbstupdate
// des Agents (#36)"; Rumpf mit `imageRef` ab v0.30.0, #112). Kein laufender
// Agent nötig.

const DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET = `ghcr.io/florianfinn/docklet-hub-agent:v0.32.0@${DIGEST}`;
const AGENT = { baseUrl: "http://10.254.0.2:8099", secret: "s".repeat(43) };
const ACTOR = { kind: "user", id: "u-1" } as const;

test("die Fassung steht im Tag des Refs, mit und ohne Digest", () => {
  assert.equal(versionOfImageRef(TARGET), "0.32.0");
  assert.equal(versionOfImageRef("ghcr.io/florianfinn/docklet-hub-agent:v0.29.1"), "0.29.1");
  // Ein Registry-Port ist kein Tag.
  assert.equal(versionOfImageRef("registry.local:5000/agent:v1.2.3"), "1.2.3");
  assert.equal(versionOfImageRef("registry.local:5000/agent"), null);
  assert.equal(versionOfImageRef(`ghcr.io/florianfinn/docklet-hub-agent@${DIGEST}`), null);
  assert.equal(versionOfImageRef("ghcr.io/florianfinn/docklet-hub-agent:latest"), null);
});

test("das Angebot unterscheidet aktuell, per Knopf und von Hand", () => {
  assert.deepEqual(agentUpdateOffer("0.32.0", TARGET), { targetVersion: "0.32.0", targetImageRef: TARGET, state: "current" });
  assert.deepEqual(agentUpdateOffer("0.33.0", TARGET), { targetVersion: "0.32.0", targetImageRef: TARGET, state: "current" });

  const newer = `ghcr.io/florianfinn/docklet-hub-agent:v0.33.0@${DIGEST}`;
  assert.deepEqual(agentUpdateOffer("0.32.0", newer), { targetVersion: "0.33.0", targetImageRef: newer, state: "available" });

  // An arm below v0.32.0 runs from the old image name
  // (`dashboard-docker-agent`) and refuses a target in the new repository, so
  // the button would have no effect there: the step is done once by hand
  // (#279). That holds for 0.30.0 and 0.31.0, which do read `imageRef`.
  for (const old of ["0.31.0", "0.30.0", "0.29.1"]) {
    assert.deepEqual(agentUpdateOffer(old, TARGET), { targetVersion: "0.32.0", targetImageRef: TARGET, state: "manual" }, old);
    assert.deepEqual(agentUpdateOffer(old, newer), { targetVersion: "0.33.0", targetImageRef: newer, state: "manual" }, old);
  }
});

test("eine unlesbare Fassung des Arms ist „von Hand“ und nicht „per Knopf“", () => {
  for (const version of [null, "", "unbekannt"]) {
    assert.deepEqual(agentUpdateOffer(version, TARGET), { targetVersion: "0.32.0", targetImageRef: TARGET, state: "manual" }, String(version));
  }
});

test("ein Ziel ohne lesbare Fassung ergibt kein Angebot", () => {
  assert.equal(agentUpdateOffer("0.30.0", "ghcr.io/florianfinn/docklet-hub-agent:latest"), null);
});

test("der Stand wird gelesen, und ein unbekannter Ausgang kommt wörtlich an", () => {
  assert.deepEqual(
    parseSelfUpdateStatus({
      running: false,
      version: "0.30.0",
      last: {
        jobId: "j-1",
        outcome: "ok",
        reason: null,
        fromVersion: "0.29.1",
        toVersion: "v0.30.0",
        fromImageId: "sha256:x",
        toImageId: "sha256:y",
        digest: TARGET,
        startedAt: "2026-09-29T20:00:00.000Z",
        finishedAt: "2026-09-29T20:01:00.000Z"
      }
    }),
    {
      running: false,
      version: "0.30.0",
      last: {
        jobId: "j-1",
        outcome: "ok",
        reason: null,
        fromVersion: "0.29.1",
        toVersion: "v0.30.0",
        finishedAt: "2026-09-29T20:01:00.000Z"
      }
    }
  );
  const later = parseSelfUpdateStatus({ running: true, version: "0.30.0", last: { jobId: "j-2", outcome: "paused" } });
  assert.equal(later.last?.outcome, "paused");
});

test("ohne letzten Lauf ist `last` null, und ohne `running` ist die Antwort unbrauchbar", () => {
  assert.equal(parseSelfUpdateStatus({ running: false, version: "0.30.0", last: null }).last, null);
  assert.equal(parseSelfUpdateStatus({ running: false, version: "0.30.0", last: { outcome: "ok" } }).last, null);
  assert.throws(() => parseSelfUpdateStatus({ version: "0.30.0" }), AgentError);
  assert.throws(() => parseSelfUpdateStatus([]), AgentError);
});

test("der Auftrag geht als POST mit dem Ziel im Rumpf und unter dem Aufrufer", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, jobId: "j-1", imageRef: TARGET }), {
      status: 202,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  const accepted = await requestSelfUpdate(AGENT, TARGET, { actor: ACTOR, fetchImpl });
  assert.deepEqual(accepted, { jobId: "j-1", imageRef: TARGET });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://10.254.0.2:8099/self-update");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { imageRef: TARGET });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get(SECRET_HEADER), AGENT.secret);
  assert.equal(headers.get(ACTOR_HEADER), "user:u-1");
});

test("eine Ablehnung des Agenten kommt als AgentError mit Status und Schlüssel an", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "already-running" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;

  await assert.rejects(
    () => requestSelfUpdate(AGENT, TARGET, { actor: ACTOR, fetchImpl }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.status === 409 &&
      (error.detail as { error?: string } | null)?.error === "already-running"
  );
});

test("der Stand geht als GET ohne Rumpf", async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response(JSON.stringify({ running: true, version: "0.30.0", last: null }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  assert.deepEqual(await fetchSelfUpdateStatus(AGENT, { actor: ACTOR, fetchImpl }), {
    running: true,
    version: "0.30.0",
    last: null
  });
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});


test("image tag versions retain rc suffixes with and without a digest", () => {
  const ref = "registry.example:5000/agent:v0.32.0-rc.4";
  assert.equal(versionOfImageRef(ref), "0.32.0-rc.4");
  assert.equal(versionOfImageRef(`${ref}@${DIGEST}`), "0.32.0-rc.4");
});

for (const [running, target, state] of [
  ["0.32.0-rc.3", "0.32.0-rc.4", "available"],
  ["0.32.0-rc.4", "0.32.0-rc.4", "current"],
  ["0.32.0", "0.32.0-rc.4", "current"],
  ["0.32.0-rc.10", "0.32.0-rc.9", "current"],
  ["0.32.0-rc.9", "0.32.0-rc.10", "available"],
  ["0.31.9", "0.32.0-rc.4", "manual"],
  ["unbekannt", "0.32.0-rc.4", "manual"],
  ["0.32.0-rc.10", "0.32.0", "available"],
  ["0.32.0", "0.32.1-rc.1", "available"]
] as const) {
  test(`update offer: ${running} against ${target} is ${state}`, () => {
    const targetImageRef = `registry.example/agent:v${target}@${DIGEST}`;
    assert.deepEqual(agentUpdateOffer(running, targetImageRef), { targetVersion: target, targetImageRef, state });
  });
}
