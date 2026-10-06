import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR_HEADER, LOG_TAIL_LINE_OPTIONS, MAX_TAIL, SECRET_HEADER } from "contract";
import {
  actorHeaderValue,
  agentDownload,
  agentGet,
  AgentError,
  agentPost,
  agentPut,
  agentStream,
  agentUpload
} from "./protocol.js";

// Die Fehlerfälle sind hier das Produkt. Ein 401 und ein 403 vom Agenten
// sehen im Log gleich aus und haben völlig verschiedene Ursachen: das eine
// heißt „ihr habt verschiedene Geheimnisse", das andere „der Agent hat diese
// Anfrage inhaltlich abgelehnt". Wer beides als „Agent antwortet nicht" liest,
// sucht tagelang an der falschen Stelle.

const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };
const ACTOR = { kind: "user" as const, id: "u-1" };

function replyWith(status: number, body: unknown = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

test("der Aufrufer wird nach seiner Art benannt", () => {
  assert.equal(actorHeaderValue({ kind: "user", id: "abc" }), "user:abc");
  assert.equal(actorHeaderValue({ kind: "system", name: "monitor" }), "system:monitor");
});

test("ein 401 nennt das gemeinsame Geheimnis", async () => {
  await assert.rejects(
    agentGet(TARGET, "/containers", { actor: ACTOR, fetchImpl: replyWith(401) }),
    (error: unknown) =>
      error instanceof AgentError && error.status === 401 && /DOCKER_AGENT_SECRET/.test((error as Error).message)
  );
});

test("ein 403 verweist auf das Audit-Log und nicht auf das Geheimnis", async () => {
  // The message claims no cause it does not know; it names the path and the
  // place where the reason is recorded.
  await assert.rejects(
    agentGet(TARGET, "/containers/abc/exec", { actor: ACTOR, fetchImpl: replyWith(403) }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.status === 403 &&
      /Audit-Log/.test((error as Error).message) &&
      /exec/.test((error as Error).message) &&
      !/DOCKER_AGENT_SECRET/.test((error as Error).message)
  );
});

test("jeder andere Fehlerstatus reist mit", async () => {
  await assert.rejects(
    agentGet(TARGET, "/containers", { actor: ACTOR, fetchImpl: replyWith(503) }),
    (error: unknown) => error instanceof AgentError && error.status === 503
  );
});

test("eine Antwort, die kein JSON ist, wird als solche gemeldet", async () => {
  const fetchImpl = (async () => new Response("<html>Proxy-Fehler</html>", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(
    agentGet(TARGET, "/containers", { actor: ACTOR, fetchImpl }),
    (error: unknown) => error instanceof AgentError && /kein JSON/.test((error as Error).message)
  );
});

test("ein schweigender Agent läuft in die Frist statt ins Leere", async () => {
  // Genau so verhält sich ein Port, vor dem eine Firewall verwirft statt
  // abzulehnen: die Verbindung wird angenommen, danach kommt nichts.
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;

  await assert.rejects(
    agentGet(TARGET, "/containers", { actor: ACTOR, fetchImpl, timeoutMs: 10 }),
    (error: unknown) => error instanceof AgentError && /10 ms/.test((error as Error).message)
  );
});

test("ein Verbindungsfehler wird nicht zu einem Protokollfehler", async () => {
  const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
  await assert.rejects(
    agentGet(TARGET, "/containers", { actor: ACTOR, fetchImpl }),
    (error: unknown) =>
      error instanceof AgentError && error.status === null && /ECONNREFUSED/.test((error as Error).message)
  );
});

test("die schreibende Richtung trägt dieselben drei Kopfzeilen plus content-type", async () => {
  // ⚠️ Es gibt keinen zweiten Weg zum Agenten. `agentPut` ist dieselbe
  // Anfrage wie `agentGet`, nur mit Methode und Rumpf — eine eigene Fassung
  // wäre die Stelle, an der eine später ergänzte Kopfzeile in genau einem der
  // beiden Wege fehlt, und das sähe aus wie ein falsches Geheimnis.
  let seen: { url: string; method: string | undefined; headers: Record<string, string>; body: unknown } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body
    };
    return new Response(JSON.stringify({ ok: true, entries: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  const answer = await agentPut(TARGET, "/registry", { entries: [{ containerId: "a1" }] }, { actor: ACTOR, fetchImpl });
  assert.deepEqual(answer, { ok: true, entries: 1 });
  assert.ok(seen);
  const request = seen as unknown as {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: unknown;
  };
  assert.equal(request.url, "http://docker-agent:8099/registry");
  assert.equal(request.method, "PUT");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[ACTOR_HEADER], "user:u-1");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.body, JSON.stringify({ entries: [{ containerId: "a1" }] }));
});

test("die lesende Richtung schickt weiterhin keinen Rumpf und keinen content-type", async () => {
  let seen: { headers: Record<string, string>; body: unknown } | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen = { headers: init?.headers as Record<string, string>, body: init?.body };
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  await agentGet(TARGET, "/containers", { actor: ACTOR, fetchImpl });
  assert.ok(seen);
  const request = seen as unknown as { headers: Record<string, string>; body: unknown };
  assert.equal(request.headers["content-type"], undefined);
  assert.equal(request.body, undefined);
});

test("die Fehlerübersetzung gilt für beide Richtungen", async () => {
  // Dieselbe Frist, dieselben Meldungen. Ein 403 auf PUT /registry heißt
  // dasselbe wie auf einer Leseroute — und darf nicht als „Geheimnis falsch"
  // erscheinen.
  await assert.rejects(
    agentPut(TARGET, "/registry", { entries: [] }, { actor: ACTOR, fetchImpl: replyWith(403) }),
    (error: unknown) =>
      error instanceof AgentError &&
      error.status === 403 &&
      /Audit-Log/.test((error as Error).message) &&
      !/DOCKER_AGENT_SECRET/.test((error as Error).message)
  );
  await assert.rejects(
    agentPut(TARGET, "/registry", { entries: [] }, { actor: ACTOR, fetchImpl: replyWith(401) }),
    (error: unknown) => error instanceof AgentError && error.status === 401
  );
  await assert.rejects(
    agentPut(TARGET, "/registry", { entries: [] }, { actor: ACTOR, fetchImpl: replyWith(500) }),
    (error: unknown) => error instanceof AgentError && error.status === 500
  );

  const silent = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
  await assert.rejects(
    agentPut(TARGET, "/registry", { entries: [] }, { actor: ACTOR, fetchImpl: silent, timeoutMs: 10 }),
    (error: unknown) => error instanceof AgentError && /10 ms/.test((error as Error).message)
  );
});

// ── Der Strom (Etappe B4b-F, #5) ────────────────────────────────────────────
//
// ⚠️ Was hier der eigentliche Nachweis ist: dass `agentStream` den Rumpf NICHT
// anfasst und dass seine Frist nur bis zur ersten Kopfzeile gilt. Beides fiele
// bei einer Umstellung auf `agentRequest` nicht auf — die Fehlerübersetzung
// wäre identisch, und erst ein Container, der eine halbe Stunde schweigt,
// zeigte den Unterschied.

const NEVER_ABORTED = new AbortController().signal;

function streamWith(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

test("der Strom trägt dieselben drei Kopfzeilen, aber accept ndjson", async () => {
  let seen: { url: string; method: string | undefined; headers: Record<string, string> } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), method: init?.method, headers: init?.headers as Record<string, string> };
    return new Response("{}\n", { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }) as unknown as typeof fetch;

  await agentStream(TARGET, "/containers/abc/logs-stream?tail=200", {
    actor: ACTOR,
    fetchImpl,
    signal: NEVER_ABORTED
  });
  assert.ok(seen);
  const request = seen as unknown as { url: string; method: string | undefined; headers: Record<string, string> };
  assert.equal(request.url, "http://docker-agent:8099/containers/abc/logs-stream?tail=200");
  assert.equal(request.method, "GET");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[ACTOR_HEADER], "user:u-1");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
  assert.equal(request.headers.accept, "application/x-ndjson");
});

test("der Rumpf des Stroms bleibt ungelesen und gehört dem Aufrufer", async () => {
  // ⚠️ Der Fall, den eine Umstellung auf `response.json()` bräche — und zwar
  // still: die Kopfzeilen stimmten weiter, der Status auch, und erst der
  // Aufrufer stünde vor einem verbrauchten Rumpf.
  const response = await agentStream(TARGET, "/containers/abc/logs-stream?tail=1", {
    actor: ACTOR,
    fetchImpl: streamWith(200, '{"kind":"start"}\n'),
    signal: NEVER_ABORTED
  });
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), '{"kind":"start"}\n');
});

test("die Fehlerübersetzung des Stroms ist WÖRTLICH die des Einzelaufrufs", async () => {
  // Der Grund für `assertAgentAccepted`: zwei Abschriften derselben Meldung
  // wären zwei Wahrheiten. Verglichen wird deshalb der Text und nicht nur der
  // Status.
  const path = "/containers/abc/logs-stream?tail=200";
  for (const status of [401, 403, 500]) {
    const fromRequest = await agentGet(TARGET, path, { actor: ACTOR, fetchImpl: replyWith(status) }).then(
      () => null,
      (error: unknown) => error as AgentError
    );
    const fromStream = await agentStream(TARGET, path, {
      actor: ACTOR,
      fetchImpl: streamWith(status, ""),
      signal: NEVER_ABORTED
    }).then(
      () => null,
      (error: unknown) => error as AgentError
    );
    assert.ok(fromRequest instanceof AgentError && fromStream instanceof AgentError, `Status ${status}`);
    assert.equal(fromStream.status, fromRequest.status);
    assert.equal(fromStream.message, fromRequest.message);
  }
});

test("der Deckel der Ströme kommt als 429 durch", async () => {
  // Über `MAX_OPEN_STREAMS` (`contract/src/agent/limits.ts`, seit #272 für
  // beide Seiten dieselbe Zahl) antwortet der Agent `429` mit
  // `{"error":"too-many-streams"}` — und zwar VOR dem ersten Byte des Stroms,
  // also als echter Statuscode. Der Hub übersetzt die Kennung an der Grenze
  // (`api/agent-error-translation.ts`); hier zählt, dass der Status ankommt.
  await assert.rejects(
    agentStream(TARGET, "/containers/abc/logs-stream?tail=200", {
      actor: ACTOR,
      fetchImpl: streamWith(429, '{"error":"too-many-streams"}'),
      signal: NEVER_ABORTED
    }),
    (error: unknown) => error instanceof AgentError && error.status === 429
  );
});

test("die Frist des Stroms gilt dem Verbindungsaufbau und nicht dem Schweigen danach", async () => {
  // Erste Hälfte: ein Agent, der die Verbindung annimmt und gar nicht erst
  // antwortet, läuft in die Frist.
  const silent = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
  await assert.rejects(
    agentStream(TARGET, "/containers/abc/logs-stream?tail=200", {
      actor: ACTOR,
      fetchImpl: silent,
      signal: NEVER_ABORTED,
      timeoutMs: 10
    }),
    (error: unknown) => error instanceof AgentError && /10 ms/.test((error as Error).message)
  );

  // ⚠️ Zweite Hälfte, und sie ist der eigentliche Punkt: ein Strom, der steht
  // und schweigt, ist KEIN Fehler. Die Frist ist nach der ersten Kopfzeile
  // abgeräumt — ein Container, der eine halbe Stunde nichts protokolliert, ist
  // ein ruhiger Container und kein Ausfall.
  const controller = new AbortController();
  const quiet = ((_input: unknown, _init?: unknown) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode('{"kind":"start"}\n'));
            // Danach nichts mehr. Kein `close()`.
          }
        }),
        { status: 200 }
      )
    )) as unknown as typeof fetch;

  const response = await agentStream(TARGET, "/containers/abc/logs-stream?tail=200", {
    actor: ACTOR,
    fetchImpl: quiet,
    signal: controller.signal,
    timeoutMs: 10
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), '{"kind":"start"}\n');
  // 40 ms Schweigen bei einer Frist von 10 ms — ohne die Trennung der beiden
  // Fristen wäre der Strom hier bereits abgerissen.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(controller.signal.aborted, false);
  await reader.cancel();
});

test("der Abbruch durch den Aufrufer reist als AbortError und nicht als AgentError", async () => {
  // Der Browser hat die Seite verlassen. Ein `AgentError` daraus füllte das
  // Log mit Nicht-Ereignissen — und sähe aus wie ein Agent, der ausfällt.
  const controller = new AbortController();
  const silent = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;

  const pending = agentStream(TARGET, "/containers/abc/logs-stream?tail=200", {
    actor: ACTOR,
    fetchImpl: silent,
    signal: controller.signal,
    timeoutMs: 5_000
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError" && !(error instanceof AgentError)
  );
});

test("ein bereits abgebrochenes Signal lässt den Strom gar nicht erst aufgehen", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) => {
    called = true;
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return Promise.resolve(new Response("", { status: 200 }));
  }) as unknown as typeof fetch;

  await assert.rejects(
    agentStream(TARGET, "/containers/abc/logs-stream?tail=200", {
      actor: ACTOR,
      fetchImpl,
      signal: controller.signal
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.equal(called, true, "das Signal muss den Aufruf erreichen, nicht ihn ersetzen");
});

// ── Die drei Wege der Datei-Fläche (B5/E1) ──────────────────────────────────
//
// Die Frage dieser Fälle ist nicht „funktioniert der Aufruf", sondern: laufen
// sie durch DIESELBE Anfrage wie die alten? Ein zweiter Weg zum Agenten wäre
// die Stelle, an der eine später ergänzte Kopfzeile in genau einem der Wege
// fehlt — und das sähe von außen aus wie ein falsches Geheimnis.

/** Fängt eine Anfrage ab und antwortet mit dem Gewünschten. */
function capture(reply: () => Response): {
  fetchImpl: typeof fetch;
  seen: () => { url: string; method: string | undefined; headers: Record<string, string>; body: unknown };
} {
  let taken: { url: string; method: string | undefined; headers: Record<string, string>; body: unknown } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    taken = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body
    };
    return reply();
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    seen: () => {
      assert.ok(taken, "der Aufruf hat fetch nie erreicht");
      return taken as unknown as {
        url: string;
        method: string | undefined;
        headers: Record<string, string>;
        body: unknown;
      };
    }
  };
}

function jsonReply(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("agentPost trägt dieselben drei Kopfzeilen, POST und einen JSON-Rumpf", async () => {
  const { fetchImpl, seen } = capture(jsonReply({ ok: true, name: "neu" }));

  const answer = await agentPost(
    TARGET,
    "/containers/abc/files?share=daten",
    { action: "create-folder", path: "unterordner", name: "neu" },
    { actor: ACTOR, fetchImpl }
  );

  assert.deepEqual(answer, { ok: true, name: "neu" });
  const request = seen();
  assert.equal(request.url, "http://docker-agent:8099/containers/abc/files?share=daten");
  assert.equal(request.method, "POST");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[ACTOR_HEADER], "user:u-1");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.body, JSON.stringify({ action: "create-folder", path: "unterordner", name: "neu" }));
});

test("agentUpload schickt die rohen Bytes und NICHT deren JSON-Fassung", async () => {
  // ⚠️ Der eigentliche Fall. Ein `JSON.stringify` über einem `Uint8Array`
  // ergibt `{"0":80,"1":75,…}` — kein Fehler, keine Warnung, nur eine Datei,
  // die beim Betreiber ankommt und sich nicht öffnen lässt.
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  const { fetchImpl, seen } = capture(jsonReply({ ok: true, name: "archiv.zip", size: bytes.length }));

  const answer = await agentUpload(TARGET, "/containers/abc/file?share=daten&path=&name=archiv.zip", bytes, {
    actor: ACTOR,
    fetchImpl
  });

  assert.deepEqual(answer, { ok: true, name: "archiv.zip", size: 6 });
  const request = seen();
  assert.equal(request.method, "PUT");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[ACTOR_HEADER], "user:u-1");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
  assert.equal(request.headers["content-type"], "application/octet-stream");
  // Die Antwort ist JSON, der Rumpf sind Bytes — die beiden Kopfzeilen
  // beschreiben verschiedene Richtungen und dürfen nicht angeglichen werden.
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.body, bytes, "der Rumpf ist dasselbe Uint8Array und keine Abschrift");
  assert.notEqual(typeof request.body, "string");
});

test("agentUpload läuft durch dieselbe Fehlerübersetzung wie der Rest", async () => {
  await assert.rejects(
    agentUpload(TARGET, "/containers/abc/file", new Uint8Array([1]), { actor: ACTOR, fetchImpl: replyWith(401) }),
    (error: unknown) => error instanceof AgentError && error.status === 401 && /DOCKER_AGENT_SECRET/.test(error.message)
  );
  await assert.rejects(
    agentUpload(TARGET, "/containers/abc/file", new Uint8Array([1]), { actor: ACTOR, fetchImpl: replyWith(403) }),
    (error: unknown) => error instanceof AgentError && error.status === 403 && /Audit-Log/.test(error.message)
  );
  // Der Fall der Gegenseite: über MAX_UPLOAD_BYTES antwortet der Agent mit 413.
  // Er reist mit seinem Status nach außen und wird hier nicht gedeutet.
  await assert.rejects(
    agentUpload(TARGET, "/containers/abc/file", new Uint8Array([1]), { actor: ACTOR, fetchImpl: replyWith(413) }),
    (error: unknown) => error instanceof AgentError && error.status === 413
  );
});

test("agentDownload gibt die Antwort ungelesen zurück und sammelt nichts", async () => {
  // ⚠️ Der Rumpf gehört dem Aufrufer. Ein hier gelesener Rumpf wäre dort für
  // immer weg — und die ganze Datei im Speicher des Hubs, nur um sie
  // weiterzugeben. Eine Obergrenze, an der sich das abschätzen ließe, gibt es
  // für diese Richtung nicht: `MAX_UPLOAD_BYTES` deckelt nur den Upload.
  const { fetchImpl, seen } = capture(
    () =>
      new Response("Bytes-nicht-JSON", {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": "16" }
      })
  );

  const response = await agentDownload(TARGET, "/containers/abc/file?share=daten&path=a.bin", {
    actor: ACTOR,
    fetchImpl
  });

  assert.equal(response.bodyUsed, false, "der Rumpf muss ungelesen sein");
  assert.equal(response.headers.get("content-length"), "16");
  const request = seen();
  assert.equal(request.method, "GET");
  assert.equal(request.headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(request.headers[ACTOR_HEADER], "user:u-1");
  assert.equal(request.headers["x-docker-agent-tier"], undefined);
  assert.equal(request.headers.accept, "application/octet-stream");
  assert.equal(request.body, undefined, "ein Download schickt keinen Rumpf");
  assert.equal(await response.text(), "Bytes-nicht-JSON");
});

test("agentDownload übersetzt die Fehlerstatus WÖRTLICH wie der Einzelaufruf", async () => {
  await assert.rejects(
    agentDownload(TARGET, "/containers/abc/file", { actor: ACTOR, fetchImpl: replyWith(401) }),
    (error: unknown) => error instanceof AgentError && error.status === 401 && /DOCKER_AGENT_SECRET/.test(error.message)
  );
  await assert.rejects(
    agentDownload(TARGET, "/containers/abc/file", { actor: ACTOR, fetchImpl: replyWith(403) }),
    (error: unknown) => error instanceof AgentError && error.status === 403 && /Audit-Log/.test(error.message)
  );
  // Die fehlende Datei. Sie ist ein gewöhnlicher Fehlerstatus und behält ihn.
  await assert.rejects(
    agentDownload(TARGET, "/containers/abc/file", { actor: ACTOR, fetchImpl: replyWith(404) }),
    (error: unknown) => error instanceof AgentError && error.status === 404
  );
});

test("agentDownload läuft ohne signal und bricht mit signal ab", async () => {
  // ⚠️ Anders als beim Strom ist `signal` hier KEINE Pflicht: ein Download ist
  // endlich, er hört bei `content-length` auf. Beide Fälle stehen deshalb hier.
  const unsignalled = await agentDownload(TARGET, "/containers/abc/file", {
    actor: ACTOR,
    fetchImpl: (async () => new Response("x", { status: 200 })) as unknown as typeof fetch
  });
  assert.equal(unsignalled.status, 200);

  const controller = new AbortController();
  controller.abort();
  let reached = false;
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) => {
    reached = true;
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    return Promise.resolve(new Response("", { status: 200 }));
  }) as unknown as typeof fetch;

  await assert.rejects(
    agentDownload(TARGET, "/containers/abc/file", { actor: ACTOR, fetchImpl, signal: controller.signal }),
    // Der Abbruch des Aufrufers ist kein Befund und wird nicht zum AgentError.
    (error: unknown) => error instanceof Error && error.name === "AbortError" && !(error instanceof AgentError)
  );
  assert.equal(reached, true, "das Signal muss den Aufruf erreichen, nicht ihn ersetzen");
});

test("agentDownload trennt die Frist des Aufbaus vom Abbruch des Aufrufers", async () => {
  // Ein Agent, der die Verbindung annimmt und dann schweigt. Das IST ein
  // Befund — anders als der Abbruch oben — und wird zum AgentError.
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;

  await assert.rejects(
    agentDownload(TARGET, "/containers/abc/file", { actor: ACTOR, fetchImpl, timeoutMs: 10 }),
    (error: unknown) => error instanceof AgentError && /innerhalb von 10 ms/.test(error.message)
  );
});

// Moved here from the hub's former contract test (#274). The header names are
// typed out on purpose: an agent of an older release on another host reads
// these literals, and a typo in the contract would show up there as a `401`
// that looks like a wrong secret. The constants alone would stay green.
test("the two headers go out with their literal names, and no tier header", async () => {
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;

  await agentGet(TARGET, "/containers", { actor: { kind: "system", name: "hub" }, fetchImpl });

  assert.equal(headers["x-docker-agent-secret"], "s".repeat(32));
  assert.equal(headers["x-docker-agent-actor"], "system:hub");
  assert.equal(headers[SECRET_HEADER], "s".repeat(32));
  assert.equal(headers[ACTOR_HEADER], "system:hub");
  assert.equal("x-docker-agent-tier" in headers, false);
});

// `LOG_TAIL_LINE_OPTIONS` is deliberately not derived from `MAX_TAIL` (reason
// there). This assertion replaces the derivation: if the agent's limit sank,
// the settings would keep offering a value the hub then rejects when a log
// opens.
test("the operator's tail choices stay within the agent's limit", () => {
  assert.ok(
    Math.max(...LOG_TAIL_LINE_OPTIONS) <= MAX_TAIL,
    `choices reach ${Math.max(...LOG_TAIL_LINE_OPTIONS)}, the agent takes ${MAX_TAIL}`
  );
});
