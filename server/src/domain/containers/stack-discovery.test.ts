import test from "node:test";
import assert from "node:assert/strict";

import { fetchStackDiscovery, parseStackDiscovery } from "./stack-discovery.js";
import { ACTOR_HEADER, SECRET_HEADER } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";

// Geprüft gegen die Form, die der Agent unter GET /stacks liefert — gemessen
// am 2026-09-07 an `florianfinn/dashboard-docker-agent`@6ffc3c8 (v0.19.1),
// `src/stacks.ts:48`. Eingespeister `fetchImpl`, kein laufender Agent.

const STACK = {
  projectDir: "/srv/stacks/media",
  projectName: "media",
  composeFileName: "docker-compose.yml",
  management: "adoptiert",
  filePresent: true,
  services: [
    {
      serviceName: "jellyfin",
      containerName: "media-jellyfin",
      containerId: "3f1c2b",
      status: "running",
      image: "ghcr.io/example/jellyfin:10.9.0"
    }
  ]
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

test("eine Antwort, die passt, kommt vollständig an", () => {
  const discovery = parseStackDiscovery({
    stacks: [STACK],
    findings: [{ kind: "container-without-compose-labels", detail: "watchtower" }]
  });
  assert.deepEqual(discovery.stacks, [STACK]);
  assert.deepEqual(discovery.findings, [{ kind: "container-without-compose-labels", detail: "watchtower" }]);
});

test("eine Antwort, die Felder weglässt, verliert nur die Beiwerk-Felder", () => {
  // `management`, `filePresent` und die Anzeigefelder eines Dienstes sind
  // Beiwerk für die Fehlersuche. Der Anker hängt an `projectDir`,
  // `composeFileName` und `serviceName`.
  const discovery = parseStackDiscovery({
    stacks: [
      {
        projectDir: "/srv/stacks/media",
        composeFileName: "compose.yaml",
        services: [{ serviceName: "web", containerId: "b2" }]
      }
    ]
  });
  assert.deepEqual(discovery.stacks[0], {
    projectDir: "/srv/stacks/media",
    projectName: "",
    composeFileName: "compose.yaml",
    management: "",
    filePresent: false,
    services: [{ serviceName: "web", containerId: "b2", containerName: "", status: "", image: "" }]
  });
  // `findings` darf ganz fehlen: ein Arm ohne Befunde hat nichts zu erklären.
  assert.deepEqual(discovery.findings, []);
});

test("ein fehlender Projektname hält die Erhebung nicht an", () => {
  // Er ist im Registry-Vertrag optional; ohne ihn lehnt der Agent nur die
  // STACK-Aktionen ab, während der Container selbst erlaubt bleibt. Ein
  // Abbruch nähme dem ganzen Host seine Allowlist wegen eines Feldes, das
  // einen Teil kostet.
  const { projectName: _gone, ...withoutName } = STACK;
  assert.equal(parseStackDiscovery({ stacks: [withoutName] }).stacks[0].projectName, "");
});

test("ein Stack ohne Verzeichnis oder Dateinamen hält die Erhebung an", () => {
  // Beide tragen den Anker. Ein Stack, der einen davon nicht nennt, ist keine
  // gekürzte Auskunft, sondern eine widersprüchliche.
  for (const key of ["projectDir", "composeFileName"]) {
    assert.throws(
      () => parseStackDiscovery({ stacks: [{ ...STACK, [key]: "" }] }),
      (error: unknown) => error instanceof AgentError && /Stack 1/.test((error as Error).message)
    );
  }
  assert.throws(() => parseStackDiscovery({ stacks: [{ ...STACK, services: null }] }), AgentError);
  assert.throws(
    () => parseStackDiscovery({ stacks: [{ ...STACK, services: [{ serviceName: "web" }] }] }),
    (error: unknown) => error instanceof AgentError && /Dienst 1/.test((error as Error).message)
  );
});

test("ein unbekannter Befund wird gekürzt und wirft die Erhebung nicht um", () => {
  // Ein Befund erklärt eine Lücke, er erzeugt keine. Die Erhebung wegen eines
  // unlesbaren Befunds ganz zu verwerfen hieße, den Anker aller Stacks zu
  // verlieren, die daneben in Ordnung sind. Heute kommen vier Gründe vor
  // (v0.19.1, `src/stacks.ts`: Container ohne Compose-Labels, Container ohne
  // Verzeichnis, Stack außerhalb des Basispfads, Verzeichnis ohne Container);
  // ein fünfter reist mit.
  const discovery = parseStackDiscovery({
    stacks: [STACK],
    findings: [null, "text", { detail: "ohne Art" }, { kind: "neuer-grund" }]
  });
  assert.equal(discovery.stacks.length, 1);
  assert.deepEqual(discovery.findings, [{ kind: "neuer-grund", detail: null }]);
});

test("eine Antwort ohne stacks-Feld hält an", () => {
  for (const body of [{}, { stacks: null }, { stacks: "keine" }, [], null, "text"]) {
    assert.throws(() => parseStackDiscovery(body), AgentError, `${JSON.stringify(body)} hätte anhalten müssen`);
  }
});

test("die Anfrage trägt Geheimnis und Aufrufer, aber keine Netzstufe", async () => {
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify({ stacks: [], findings: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  const discovery = await fetchStackDiscovery(TARGET, { actor: ACTOR, fetchImpl });
  assert.deepEqual(discovery, { stacks: [], findings: [] });
  assert.ok(seen);
  const request = seen as unknown as { url: string; headers: Record<string, string> };
  assert.equal(request.url, "http://docker-agent:8099/stacks");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[ACTOR_HEADER], "system:hub");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
});

test("ein 403 und ein 401 werden auseinandergehalten", async () => {
  await assert.rejects(
    fetchStackDiscovery(TARGET, { actor: ACTOR, fetchImpl: replyWith(403) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 403 && /Audit-Log/.test((error as Error).message)
  );
  await assert.rejects(
    fetchStackDiscovery(TARGET, { actor: ACTOR, fetchImpl: replyWith(401) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 401 && /DOCKER_AGENT_SECRET/.test((error as Error).message)
  );
});
