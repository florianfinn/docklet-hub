import test from "node:test";
import assert from "node:assert/strict";

import { fetchHostContainers, parseHostContainerList } from "./host-containers.js";
import { ACTOR_HEADER, SECRET_HEADER } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";

// Geprüft gegen die Form, die der Agent unter GET /host-containers liefert —
// gemessen am 2026-09-07 an `florianfinn/dashboard-docker-agent`@6ffc3c8
// (v0.19.1), `src/index.ts:2463` und `src/redact.ts:138`. Kein laufender Agent
// nötig; eingespeist wird `fetchImpl` — AGENTS.md verlangt Tests ohne echte
// Dienste.

const HOST_ENTRY = {
  id: "3f1c2b",
  name: "media-jellyfin",
  image: "ghcr.io/example/jellyfin:10.9.0",
  status: "running",
  compose: { project: "media", service: "jellyfin" },
  externalManagement: null
};

const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };
const ACTOR = { kind: "system" as const, name: "hub" };

function replyWith(status: number, body: unknown = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

test("eine Antwort, die passt, wird auf die Felder des Abgleichs verkürzt", () => {
  const [entry] = parseHostContainerList({ containers: [HOST_ENTRY] });
  assert.deepEqual(entry, {
    id: "3f1c2b",
    name: "media-jellyfin",
    image: "ghcr.io/example/jellyfin:10.9.0",
    status: "running",
    compose: { project: "media", service: "jellyfin" },
    externalManagement: null
  });
});

test("eine Antwort, die Hinweisfelder weglässt, wird gekürzt statt abgebrochen", () => {
  // `compose` und `externalManagement` sind Hinweise an der Zeile und nicht
  // die Zeile selbst. Ein Arm, der sie nicht kennt oder anders formt, darf den
  // Bestand nicht umwerfen — an diesem Bestand hängt, wer überhaupt in die
  // Allowlist kommt.
  const { compose: _noCompose, externalManagement: _noManagement, ...bare } = HOST_ENTRY;
  const [entry] = parseHostContainerList({ containers: [bare] });
  assert.equal(entry.compose, null);
  assert.equal(entry.externalManagement, null);
  assert.equal(entry.id, "3f1c2b");

  for (const broken of [{}, { manager: "" }, "unraid", 7]) {
    assert.equal(
      parseHostContainerList({ containers: [{ ...HOST_ENTRY, externalManagement: broken }] })[0].externalManagement,
      null
    );
  }
  assert.equal(parseHostContainerList({ containers: [{ ...HOST_ENTRY, compose: { project: "media" } }] })[0].compose, null);
});

test("ein zweiter Verwalter kommt mit seinem Namen an", () => {
  // `manager` ist eine Zeichenkette und keine Aufzählung. Heute meldet der
  // Agent genau einen Wert (`"unraid"`, aus dem Label
  // `net.unraid.docker.managed`); ein zweiter darf hier nicht scheitern.
  const [entry] = parseHostContainerList({
    containers: [{ ...HOST_ENTRY, externalManagement: { manager: "portainer" } }]
  });
  assert.deepEqual(entry.externalManagement, { manager: "portainer" });
});

test("ein Container ohne Id hält den ganzen Bestand an", () => {
  // ⚠️ Der wichtigste Fall dieser Datei. Ein Container, der beim Auswerten
  // stillschweigend verloren ginge, fehlte danach in der Allowlist des
  // Agenten — der Abgleich ersetzt die Liste vollständig. Aus einem
  // unlesbaren Feld würde ein Container, an dem nichts mehr geht.
  assert.throws(
    () => parseHostContainerList({ containers: [HOST_ENTRY, { ...HOST_ENTRY, id: "" }] }),
    (error: unknown) => error instanceof AgentError && /Container 2/.test((error as Error).message)
  );
  for (const key of ["name", "image", "status"]) {
    assert.throws(
      () => parseHostContainerList({ containers: [{ ...HOST_ENTRY, [key]: undefined }] }),
      AgentError,
      `ein fehlendes „${key}" hätte anhalten müssen`
    );
  }
});

test("eine Antwort ohne containers-Feld hält an", () => {
  for (const body of [{}, { containers: null }, { containers: "keine" }, [], null, "text"]) {
    assert.throws(() => parseHostContainerList(body), AgentError, `${JSON.stringify(body)} hätte anhalten müssen`);
  }
});

test("eine leere Liste ist eine gültige Antwort", () => {
  // Ein Host ohne laufende Container. Anders als bei GET /containers ist eine
  // leere Antwort hier tatsächlich eine Aussage über den Host und nicht über
  // die Allowlist des Agenten.
  assert.deepEqual(parseHostContainerList({ containers: [] }), []);
});

test("die Anfrage trägt Geheimnis und Aufrufer, aber keine Netzstufe", async () => {
  let seen: { url: string; headers: Record<string, string>; method: string | undefined } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), headers: init?.headers as Record<string, string>, method: init?.method };
    return new Response(JSON.stringify({ containers: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  assert.deepEqual(await fetchHostContainers(TARGET, { actor: ACTOR, fetchImpl }), []);
  assert.ok(seen);
  const request = seen as unknown as { url: string; headers: Record<string, string>; method: string | undefined };
  assert.equal(request.url, "http://docker-agent:8099/host-containers");
  assert.equal(request.method, "GET");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  // ⚠️ `system:hub` und kein Benutzerkonto: der Abgleich läuft ohne Menschen
  // davor, und der Agent schreibt diesen Wert in sein Audit-Log.
  assert.equal(request.headers[ACTOR_HEADER], "system:hub");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
});

test("ein 403 nennt das Audit-Log, ein 401 das gemeinsame Geheimnis", async () => {
  // Beide sehen im Log gleich aus und haben völlig verschiedene Ursachen.
  await assert.rejects(
    fetchHostContainers(TARGET, { actor: ACTOR, fetchImpl: replyWith(403) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 403 && /Audit-Log/.test((error as Error).message)
  );
  await assert.rejects(
    fetchHostContainers(TARGET, { actor: ACTOR, fetchImpl: replyWith(401) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 401 && /DOCKER_AGENT_SECRET/.test((error as Error).message)
  );
});
