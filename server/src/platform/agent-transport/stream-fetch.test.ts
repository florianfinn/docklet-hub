import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { streamFetch, StreamFetchError } from "./stream-fetch.js";
import { listenOnFetchablePort } from "../testing/port-test-support.js";

// WAS DIESE DATEI PRÜFT — UND WAS NICHT
//
// ⚠️ DIE LÜCKE, BENANNT: die Frist selbst ist hier nicht nachzustellen. Das
// eingebaute `fetch` reißt einen Rumpf erst nach 300 s Stille ab (gemessen am
// 2026-09-29, `stream-fetch.ts`), und ein Test, der fünf Minuten wartet, ist
// keiner, den jemand laufen lässt. Geprüft wird deshalb zweierlei: dass
// `streamFetch` sich für die Aufrufer wie `fetch` verhält — Status,
// Kopfzeilen, ein Rumpf, der Stück für Stück ankommt, ein Rumpf hinaus, beide
// Abbrüche —, und dass die zwei Stellen, die einen Strom öffnen, ihn als
// Vorgabe nehmen und nicht auf das eingebaute `fetch` zurückfallen.

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await listenOnFetchablePort(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

test("Status, Kopfzeilen und ein Rumpf, der ankommt, bevor die Antwort endet", async () => {
  let finish: () => void = () => undefined;
  const agent = await serve((request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson", "x-probe": request.headers["x-probe"] ?? "" });
    response.write('{"kind":"start"}\n');
    finish = () => response.end('{"kind":"line"}\n');
  });
  try {
    const response = await streamFetch(`${agent.url}/containers/c1/logs-stream`, { headers: { "x-probe": "da" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.equal(response.headers.get("x-probe"), "da", "die Kopfzeile der Anfrage kam nicht an");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // Das erste Stück MUSS da sein, solange der Server die Antwort noch offen hält.
    const first = await reader.read();
    assert.equal(decoder.decode(first.value), '{"kind":"start"}\n');
    finish();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    assert.equal(rest, '{"kind":"line"}\n');
  } finally {
    await agent.close();
  }
});

test("ein Rumpf hinaus, mit Methode, und ein abgelehnter Status bleibt lesbar", async () => {
  const agent = await serve((request, response) => {
    let received = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (received += chunk));
    request.on("end", () => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method, type: request.headers["content-type"], received }));
    });
  });
  try {
    const response = await streamFetch(`${agent.url}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cols: 80 })
    });
    assert.equal(response.status, 409);
    assert.equal(response.ok, false);
    assert.deepEqual(await response.json(), {
      method: "POST",
      type: "application/json",
      received: '{"cols":80}'
    });
  } finally {
    await agent.close();
  }
});

test("ein Abbruch vor der Antwort wirft einen AbortError — wie beim eingebauten fetch", async () => {
  const agent = await serve(() => undefined);
  try {
    const controller = new AbortController();
    const pending = streamFetch(`${agent.url}/logs`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  } finally {
    await agent.close();
  }
});

test("a pre-send abort and a peer disconnect after receiving the request carry delivery evidence", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(streamFetch("http://agent.example.org/action", { signal: controller.signal }),
    (error: unknown) => error instanceof StreamFetchError && !error.requestSent && error.name === "AbortError");
  const agent = await serve((request, response) => {
    request.resume();
    request.on("end", () => response.destroy());
  });
  try {
    await assert.rejects(streamFetch(`${agent.url}/action`, { method: "POST", body: "{}" }),
      (error: unknown) => error instanceof StreamFetchError && error.requestSent);
  } finally { await agent.close(); }
});

test("ein Abbruch mitten im Rumpf beendet das Lesen und schließt die Verbindung zum Agenten", async () => {
  let closed: () => void = () => undefined;
  const closedAtAgent = new Promise<void>((resolve) => (closed = resolve));
  const agent = await serve((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write('{"kind":"start"}\n');
    response.on("close", () => closed());
  });
  try {
    const controller = new AbortController();
    const response = await streamFetch(`${agent.url}/logs`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read());
    await closedAtAgent;
  } finally {
    await agent.close();
  }
});

test("die zwei Stellen, die einen Strom öffnen, nehmen streamFetch als Vorgabe", () => {
  // Ein Textvergleich, weil die Vorgabe von außen nicht zu sehen ist: beide
  // Stellen nehmen ein `fetchImpl` an, und jeder Test reicht eines hinein.
  const protocol = readFileSync(new URL("./protocol.ts", import.meta.url), "utf8");
  const openStream = protocol.slice(protocol.indexOf("async function openStream("));
  const openStreamBody = openStream.slice(0, openStream.indexOf("\n}\n"));
  assert.match(openStreamBody, /options\.fetchImpl \?\? streamFetch;/);
  assert.doesNotMatch(openStreamBody, /\?\? fetch\b/);

  const rejection = readFileSync(new URL("./stream-rejection.ts", import.meta.url), "utf8");
  assert.match(rejection, /const base = fetchImpl \?\? streamFetch;/);
  assert.doesNotMatch(rejection, /\?\? fetch\b/);
});
