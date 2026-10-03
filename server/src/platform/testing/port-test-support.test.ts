import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { agentGet, AgentError } from "../agent-transport/protocol.js";
import { FETCH_BLOCKED_PORTS, listenOnFetchablePort } from "./port-test-support.js";

// Der Helfer, auf dem jeder Zuhörer im Prüfstand des Servers steht — und die
// Gegenprobe, die den Wackler aus `compose-routes.test.ts` ohne Zufall
// nachstellt. Die Messungen stehen in `port-test-support.ts`.

/** Die Ursache, mit der `fetch` gegen diesen Port scheitert — oder `null`. */
async function fetchFailure(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return null;
  } catch (error) {
    const cause = (error as { cause?: { message?: unknown } }).cause;
    return typeof cause?.message === "string" ? cause.message : String(error);
  }
}

/** Ein Zuhörer auf dem ersten gesperrten Port, der hier frei ist. */
async function listenOnBlockedPort(server: http.Server): Promise<number> {
  for (const port of FETCH_BLOCKED_PORTS) {
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) return port;
  }
  throw new Error("kein einziger gesperrter Port ist frei");
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("jeder Port der Liste wird vom fetch dieses Node verweigert", async () => {
  // ⚠️ DIE LISTE IST EINE MESSUNG UND KEINE ABSCHRIFT. Fällt hier ein Port,
  // sperrt Node ihn nicht mehr, und er gehört aus der Liste. Die Sperre greift
  // vor jedem Verbindungsversuch — deshalb braucht es keinen Zuhörer, und
  // jeder Aufruf kommt sofort zurück.
  for (const port of FETCH_BLOCKED_PORTS) {
    assert.equal(await fetchFailure(port), "bad port", `Port ${port}`);
  }
});

test("zieht listen(0) einen gesperrten Port, lauscht der Zuhörer danach auf einem anderen", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  const asked: number[] = [];
  try {
    // Der erste Zug gilt als gesperrt, der zweite nicht — der Fall, den
    // `listen(0)` von sich aus nur einmal in einigen tausend Zügen liefert.
    const port = await listenOnFetchablePort(server, "127.0.0.1", (candidate) => {
      asked.push(candidate);
      return asked.length === 1;
    });

    assert.equal(asked.length, 2);
    assert.equal(port, asked[1]);
    assert.ok(server.listening, "der Zuhörer lauscht nach dem zweiten Zug");
    assert.equal(await fetchFailure(port), null);
  } finally {
    await closeServer(server);
  }
});

test("Gegenprobe: ein Arm auf einem gesperrten Port ergibt einen AgentError ohne Status", async () => {
  // Das ist der Wackler, deterministisch: der Arm antwortet, aber das `fetch`
  // des Hubs fragt ihn gar nicht erst. Ein `AgentError` ohne Status wird in
  // `translateAgentOutcome` zu `502 agent-unreachable` („kein Status ohne
  // benannten Grund bleibt 502 agent-unreachable") — und daraus wurde in
  // `compose-routes.test.ts` die gemessene `502 !== 403`.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ containers: [] }));
  });
  try {
    const port = await listenOnBlockedPort(server);
    const failure = await agentGet({ baseUrl: `http://127.0.0.1:${port}`, secret: "s" }, "/containers", {
      actor: { kind: "system", name: "hub" }
    }).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof AgentError, "der Aufruf scheitert als AgentError");
    assert.equal(failure.status, null);
    assert.match(failure.message, /nicht erreichbar/);
  } finally {
    await closeServer(server);
  }
});
