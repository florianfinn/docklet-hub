import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TAIL, MAX_TAIL } from "contract";
import { AgentError } from "../../platform/agent-transport/protocol.js";
import { parseTail, streamLogs, type LogLine } from "./agent-client.js";

// Die stillen Fallen dieses Bausteins, jede mit ihrem eigenen Fall.
//
// ⚠️ Was hier NICHT geprüft werden kann und trotzdem der Grund für die Bauart
// ist: ein Chunk ist keine Zeile. Die Bytes kommen in beliebigem Schnitt, und
// ein Test, der je Chunk genau eine ganze Zeile einspeist, ist mit jeder
// naiven Auswertung grün — auch mit der, die im Betrieb bricht. Die Fälle
// unten zerschneiden deshalb ABSICHTLICH an den Stellen, an denen das Netz es
// auch täte: mitten im Umschlag und mitten in einem Zeichen.

const TARGET = { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) };
const ACTOR = { kind: "user" as const, id: "u-1" };
const NEVER_ABORTED = new AbortController().signal;

const ENCODER = new TextEncoder();

function envelope(text: string, stream: "stdout" | "stderr" = "stdout", ts = "2026-09-07T10:00:00.000Z"): string {
  return `${JSON.stringify({ kind: "line", stream, ts, text })}\n`;
}

// Ein Agent, der genau diese Chunks in genau dieser Reihenfolge schickt.
function agentSending(chunks: Uint8Array[], status = 200): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      }),
      { status, headers: { "content-type": "application/x-ndjson; charset=utf-8" } }
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

function collect(): { lines: LogLine[]; onLine: (line: LogLine) => void } {
  const lines: LogLine[] = [];
  return { lines, onLine: (line) => lines.push(line) };
}

// ── tail ────────────────────────────────────────────────────────────────────

test("parseTail nimmt 1 bis 2000 und sonst nichts", () => {
  assert.equal(parseTail("1"), 1);
  assert.equal(parseTail("200"), 200);
  assert.equal(parseTail(String(MAX_TAIL)), MAX_TAIL);
  assert.equal(parseTail(2000), 2000);
  // ⚠️ Die vier, auf die es ankommt. `0` ist beim Agenten ein ANDERER Strom
  // (nur neue Zeilen, keine Vergangenheit) und darf den Hub nie verlassen.
  assert.equal(parseTail("0"), null);
  assert.equal(parseTail("2001"), null);
  assert.equal(parseTail("-5"), null);
  assert.equal(parseTail("1.5"), null);
  assert.equal(parseTail("viele"), null);
  assert.equal(parseTail(undefined), null);
  assert.equal(parseTail(null), null);
  // Eine Liste in der Abfragezeichenkette (`?tail=1&tail=2`) kommt bei Express
  // als Feld an. Sie ist keine Zahl und wird auch keine.
  assert.equal(parseTail(["1", "2"]), null);
});

test("ohne Angabe geht die Vorgabe des Agenten hinaus, und niemals eine Null", async () => {
  const agent = agentSending([ENCODER.encode(envelope("a"))]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(agent.urls, [`http://docker-agent:8099/containers/abc/logs-stream?tail=${DEFAULT_TAIL}`]);
});

test("ein tail von 0 verlässt den Hub gar nicht erst", async () => {
  const agent = agentSending([]);
  const sink = collect();
  await assert.rejects(
    streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, tail: 0, signal: NEVER_ABORTED }, sink.onLine),
    (error: unknown) => error instanceof AgentError
  );
  assert.deepEqual(agent.urls, [], "der Agent wurde trotz ungültigem tail angesprochen");
});

test("die Kennung des Containers wird für die URL kodiert", async () => {
  const agent = agentSending([]);
  const sink = collect();
  await streamLogs(
    TARGET,
    "a/b?c",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, tail: 5, signal: NEVER_ABORTED },
    sink.onLine
  );
  assert.deepEqual(agent.urls, ["http://docker-agent:8099/containers/a%2Fb%3Fc/logs-stream?tail=5"]);
});

// ── Der Schnitt der Chunks ──────────────────────────────────────────────────

test("EIN Umschlag in ZWEI Chunks ergibt EINE Zeile", async () => {
  // Der Fall, den ein Aufrufer ohne Zeilenpuffer als zweimal kaputtes JSON
  // sähe — und dann, je nach Bauart, entweder zwei Zeilen verlöre oder den
  // ganzen Strom abbräche.
  const line = envelope("eine Zeile über zwei Chunks");
  const bytes = ENCODER.encode(line);
  const cut = Math.floor(bytes.length / 2);
  const agent = agentSending([bytes.slice(0, cut), bytes.slice(cut)]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(
    sink.lines,
    [{ stream: "stdout", ts: "2026-09-07T10:00:00.000Z", text: "eine Zeile über zwei Chunks" }]
  );
});

test("EIN Chunk mit DREI Umschlägen ergibt DREI Zeilen, in ihrer Reihenfolge", async () => {
  const agent = agentSending([ENCODER.encode(envelope("a") + envelope("b", "stderr") + envelope("c"))]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(
    sink.lines.map((line) => `${line.stream}:${line.text}`),
    ["stdout:a", "stderr:b", "stdout:c"]
  );
});

test("ein ß mitten auf der Chunk-Grenze bleibt ein ß", async () => {
  // ⚠️ Der Fall, den `Buffer.toString()` je Chunk verlöre — und zwar
  // dauerhaft: die zweite Hälfte des Zeichens kommt zwar an, hat aber
  // niemanden mehr, zu dem sie gehört. Übrig blieben zwei Ersatzzeichen in
  // einer Logzeile, die im Original in Ordnung war.
  const bytes = ENCODER.encode(envelope("Grüße aus dem Container"));
  // „ß" ist in UTF-8 `C3 9F`. Geschnitten wird ZWISCHEN den beiden Bytes:
  // `9F` kommt in dieser Zeile sonst nicht vor.
  const cut = bytes.indexOf(0x9f);
  assert.ok(cut > 0, "die Probe trägt kein ß mehr");
  const agent = agentSending([bytes.slice(0, cut), bytes.slice(cut)]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(sink.lines.map((line) => line.text), ["Grüße aus dem Container"]);
});

// ── Was den Strom nicht umwerfen darf ───────────────────────────────────────

test("eine unparsbare Zeile fällt weg, der Strom läuft weiter", async () => {
  const agent = agentSending([ENCODER.encode(`${envelope("davor")}{kaputt\n${envelope("danach")}`)]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(sink.lines.map((line) => line.text), ["davor", "danach"]);
});

test("ein abgerissener letzter Chunk ohne Zeilenende fällt still weg", async () => {
  // Die Entscheidung, belegt: eine halbe Zeile ist kein Ereignis. Sie wird
  // NICHT geworfen — der Abriss ist der Normalfall am Ende eines Stroms, und
  // ein Fehler daraus machte aus jedem beendeten Log einen Zwischenfall.
  const agent = agentSending([ENCODER.encode(`${envelope("vollständig")}{"kind":"line","str`)]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(sink.lines.map((line) => line.text), ["vollständig"]);
});

test("eine vollständige letzte Zeile ohne Zeilenende kommt trotzdem an", async () => {
  // Die Gegenprobe zum Fall darüber: ohne sie wäre „still weggefallen" auch
  // dann grün, wenn der Rest grundsätzlich verloren ginge.
  const agent = agentSending([ENCODER.encode(envelope("letzte").trimEnd())]);
  const sink = collect();
  await streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED }, sink.onLine);
  assert.deepEqual(sink.lines.map((line) => line.text), ["letzte"]);
});

// ── start und fehler ────────────────────────────────────────────────────────

test("start und fehler laufen an ihre eigenen Rückrufe, nicht an onLine", async () => {
  const agent = agentSending([
    ENCODER.encode(
      `${JSON.stringify({ kind: "start", containerName: "immich", tty: true })}\n` +
        envelope("etwas") +
        `${JSON.stringify({ kind: "error", reason: "abgebrochen" })}\n`
    )
  ]);
  const sink = collect();
  const starts: { containerName: string; tty: boolean }[] = [];
  const failures: (string | null)[] = [];
  await streamLogs(
    TARGET,
    "abc",
    {
      actor: ACTOR,
      fetchImpl: agent.fetchImpl,
      signal: NEVER_ABORTED,
      onStart: (start) => starts.push(start),
      onFailure: (failure) => failures.push(failure.reason)
    },
    sink.onLine
  );
  assert.deepEqual(starts, [{ containerName: "immich", tty: true }]);
  assert.deepEqual(failures, ["abgebrochen"]);
  assert.deepEqual(sink.lines.map((line) => line.text), ["etwas"]);
});

test("eine fehler-Zeile ohne Grund kommt als null an und nicht mit einem Wort des Hubs (#176)", async () => {
  // ⚠️ Bis #176 setzte der Hub hier `unbekannt` ein — deutsch, in dem Feld, in
  // dem sonst ein Wert des Agenten steht, und auf dem Bildschirm eine Klammer,
  // die wie eine Auskunft aussah.
  const agent = agentSending([ENCODER.encode(`${JSON.stringify({ kind: "error" })}\n`)]);
  const failures: (string | null)[] = [];
  await streamLogs(
    TARGET,
    "abc",
    {
      actor: ACTOR,
      fetchImpl: agent.fetchImpl,
      signal: NEVER_ABORTED,
      onFailure: (failure) => failures.push(failure.reason)
    },
    collect().onLine
  );
  assert.deepEqual(failures, [null]);
});

// ── Der Strom ist einer ─────────────────────────────────────────────────────

test("eine Zeile ist da, bevor die nächste geschickt wird", async () => {
  // ⚠️ DER EIGENTLICHE NACHWEIS DIESES BAUSTEINS. Alle Fälle oben wären auch
  // mit einer Fassung grün, die den Rumpf erst vollständig liest und dann alle
  // Rückrufe hintereinander abfeuert — und genau die ist keine Durchreichung,
  // sondern eine Batchausgabe. Hier wird die zweite Zeile ERST DANN
  // eingespeist, wenn die erste angekommen ist: eine sammelnde Fassung käme
  // aus dem Wartezustand nicht heraus und liefe in die Frist dieses Laufs.
  let push: ((chunk: string) => void) | null = null;
  let finish: (() => void) | null = null;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk: string) => controller.enqueue(ENCODER.encode(chunk));
          finish = () => controller.close();
        }
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const seen: string[] = [];
  let firstArrived: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    firstArrived = resolve;
  });

  const running = streamLogs(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl, signal: NEVER_ABORTED },
    (line) => {
      seen.push(line.text);
      if (seen.length === 1) firstArrived();
    }
  );

  // Der Rumpf steht erst, wenn `agentStream` zurück ist.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(push && finish, "der Strom des Agenten steht nicht");
  (push as (chunk: string) => void)(envelope("erste"));
  await first;
  assert.deepEqual(seen, ["erste"], "die erste Zeile kam nicht vor der zweiten");
  (push as (chunk: string) => void)(envelope("zweite"));
  (finish as () => void)();
  await running;
  assert.deepEqual(seen, ["erste", "zweite"]);
});

// ── Der Abbruch ─────────────────────────────────────────────────────────────

test("der Abbruch durch den Aufrufer ist kein Fehler", async () => {
  // Der Browser hat die Seite verlassen. `streamLogs` endet still — ein
  // `AbortError`, der als Serverfehler hochblubbert, füllt das Log mit
  // Nicht-Ereignissen.
  const controller = new AbortController();
  let push: ((chunk: string) => void) | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init?: { signal?: AbortSignal }) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          push = (chunk: string) => streamController.enqueue(ENCODER.encode(chunk));
          init?.signal?.addEventListener("abort", () => {
            streamController.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const seen: string[] = [];
  let firstArrived: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    firstArrived = resolve;
  });
  const running = streamLogs(TARGET, "abc", { actor: ACTOR, fetchImpl, signal: controller.signal }, (line) => {
    seen.push(line.text);
    firstArrived();
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(push, "der Strom des Agenten steht nicht");
  (push as (chunk: string) => void)(envelope("noch da"));
  await first;
  controller.abort();
  // Kein `assert.rejects`: dass diese Zusage überhaupt zurückkommt, IST der
  // Nachweis.
  await running;
  assert.deepEqual(seen, ["noch da"]);
});

test("onOpen läuft, sobald der Strom steht — und nicht erst mit der ersten Zeile", async () => {
  // ⚠️ Der Zeitpunkt, den die Route braucht, um ihre eigenen Kopfzeilen
  // hinauszuschicken. Wer stattdessen auf die `start`-Zeile wartet, hängt seine
  // Antwort an die Geschwindigkeit der Engine des Zielhosts.
  const order: string[] = [];
  let push: ((chunk: string) => void) | null = null;
  let finish: (() => void) | null = null;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk: string) => controller.enqueue(ENCODER.encode(chunk));
          finish = () => controller.close();
        }
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const running = streamLogs(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl, signal: NEVER_ABORTED, onOpen: () => order.push("offen") },
    (line) => {
      order.push(line.text);
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["offen"], "onOpen wartet auf eine Zeile, die es noch gar nicht gibt");
  assert.ok(push && finish);
  (push as (chunk: string) => void)(envelope("erste"));
  (finish as () => void)();
  await running;
  assert.deepEqual(order, ["offen", "erste"]);
});

// ── The move of the contract values: do they arrive unchanged? ─────────────
// Moved here from the hub's former contract test with this client (#254). The
// numbers are typed out on purpose: a case holding `MAX_TAIL` against
// `MAX_TAIL` stays green when the number changes.

test("die Grenzen von tail kommen unverändert in agent-client.ts an", () => {
  // `parseTail` liest MIN_TAIL und MAX_TAIL aus dem Vertrag. Geprüft wird das
  // Verhalten an den Rändern, mit abgetippten Zahlen.
  assert.equal(parseTail("1"), 1, "die Untergrenze steht auf 1");
  assert.equal(parseTail("0"), null, "eine Null verlässt den Hub nie");
  assert.equal(parseTail("2000"), 2000, "die Obergrenze steht auf 2000");
  assert.equal(parseTail("2001"), null, "über der Obergrenze wird nichts zurechtgebogen");
});

test("die Vorgabe von tail kommt unverändert in der URL des Stroms an", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" }
    });
  }) as unknown as typeof fetch;

  await streamLogs(
    { baseUrl: "http://docker-agent:8099", secret: "s".repeat(32) },
    "abc",
    { actor: { kind: "user", id: "u-1" }, fetchImpl, signal: new AbortController().signal },
    () => undefined
  );
  assert.deepEqual(urls, ["http://docker-agent:8099/containers/abc/logs-stream?tail=200"]);
});
