import test from "node:test";
import assert from "node:assert/strict";

import { AgentError } from "../../platform/agent-transport/protocol.js";
import {
  ACTOR,
  agentSending,
  DEADLINE_MS,
  ENCODER,
  line,
  NEVER_ABORTED,
  TARGET
} from "./agent-client-test-support.js";
import { startExec, type ExecStart } from "./agent-client.js";

// The stream of the agent client of the feature `shell` (#260), against a
// stand-in — without Docker and without a network. The three short calls are
// `session-calls.test.ts`; the stand-ins are `agent-client-test-support.ts`.
//
// Der Client der vier Exec-Aufrufe, gegen eine Attrappe — ohne Docker und ohne
// Netz, nach dem Muster von `logs.test.ts` und `compose.test.ts`.
//
// ⚠️ ZWEI FALLEN, DIE EIN GRÜNER TEST HIER NICHT ZEIGT, WENN MAN SIE NICHT
// SUCHT:
//
//   1. Eine Eingabe wie `ls` läuft auch mit dem FALSCHEN Bau grün durch:
//      base64 und Klartext sehen bei reinem ASCII gleich lang aus, und der
//      Unterschied fällt erst im Container auf. Der Fall unten benutzt deshalb
//      ein Zeichen außerhalb von ASCII UND ein Steuerzeichen.
//   2. Eine Attrappe, auf die ein Test wartet, braucht eine FRIST. Ohne sie
//      hängt der Testläufer, statt rot zu werden — und ein hängender Lauf sieht
//      aus wie ein langsamer. Jeder Fall, der auf einen Strom wartet, trägt
//      deshalb `{ timeout: … }`.

// ── Der Strom: Adresse, Rumpf, die drei Arten ───────────────────────────────

test("startExec ruft die Exec-Route des Containers mit cols und rows im Rumpf", { timeout: DEADLINE_MS }, async () => {
  const agent = agentSending([line({ kind: "end", exitCode: 0 })]);
  await startExec(
    TARGET,
    "a/b?c",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 120, rows: 40 },
    () => undefined
  );
  assert.equal(agent.calls.length, 1);
  // Die Kennung wird für die Adresse kodiert — sonst wäre ein Container mit
  // einem Schrägstrich im Namen ein anderer Pfad.
  assert.equal(agent.calls[0].url, "http://docker-agent:8099/containers/a%2Fb%3Fc/exec");
  assert.equal(agent.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(agent.calls[0].body ?? "null"), { cols: 120, rows: 40 });
  // ⚠️ GENAU ZWEI FELDER. Der Agent liest kein drittes; ein weiteres hier wäre
  // eine Zusage, die niemand einlöst.
  assert.deepEqual(Object.keys(JSON.parse(agent.calls[0].body ?? "null")).sort(), ["cols", "rows"]);
});

test("die start-Zeile läuft an onStart — mit dem Feld session, nicht sitzung", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ DER FALL, DER DIE ÜBERNAHME BERICHTIGT. Das Quellsystem las `sitzung`;
  // dieser Agent sendet `session`. Mit dem alten Namen bliebe `agentSession`
  // dauerhaft leer, die Sitzung würde nie gekoppelt, und die Shell nähme für
  // immer keine Eingabe an — ohne dass irgendetwas rot würde.
  const agent = agentSending([
    line({ kind: "start", session: "agent-7", shell: "bash", containerName: "immich" }),
    line({ kind: "end", exitCode: 0 })
  ]);
  const starts: ExecStart[] = [];
  await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24, onStart: (start) => starts.push(start) },
    () => undefined
  );
  assert.deepEqual(starts, [{ agentSession: "agent-7", shell: "bash", containerName: "immich" }]);
});

test("eine start-Zeile im alten Feldnamen koppelt NICHT", { timeout: DEADLINE_MS }, async () => {
  // Die Gegenprobe zum Fall darüber: ohne sie wäre „liest session" auch dann
  // grün, wenn der Umschlag jedes beliebige Feld annähme.
  const agent = agentSending([
    line({ kind: "start", "sitzung": "agent-7", shell: "bash", containerName: "immich" }),
    line({ kind: "end", exitCode: 0 })
  ]);
  const starts: ExecStart[] = [];
  await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24, onStart: (start) => starts.push(start) },
    () => undefined
  );
  assert.deepEqual(starts, [], "eine Zeile ohne `session` ist keine Kopplung");
});

test("onOpen läuft, sobald der Strom steht — vor jeder Zeile", { timeout: DEADLINE_MS }, async () => {
  const order: string[] = [];
  const agent = agentSending([line({ kind: "output", text: "erste" }), line({ kind: "end", exitCode: 0 })]);
  await startExec(
    TARGET,
    "abc",
    {
      actor: ACTOR,
      fetchImpl: agent.fetchImpl,
      signal: NEVER_ABORTED,
      cols: 80,
      rows: 24,
      onOpen: () => order.push("offen")
    },
    (text) => {
      order.push(text);
    }
  );
  assert.deepEqual(order, ["offen", "erste"]);
});

// ── Die vier Enden des Stroms ───────────────────────────────────────────────

test("ein Prozess, der von selbst endet, trägt seine Zahl", { timeout: DEADLINE_MS }, async () => {
  const agent = agentSending([line({ kind: "output", text: "x" }), line({ kind: "end", exitCode: 130 })]);
  const outcome = await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24 },
    () => undefined
  );
  assert.deepEqual(outcome, { kind: "ended", exitCode: 130 });
});

test("ein ende OHNE vorheriges aus wird getragen", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ Zeitablauf und Leerlauf enden so: der Agent zerstört den Socket zum
  // Container, die Antwort bleibt offen und trägt noch ein `end` mit `null`
  // hinaus. Es kann die EINZIGE Zeile des ganzen Stroms sein.
  const agent = agentSending([line({ kind: "end" })]);
  const seen: string[] = [];
  const outcome = await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24 },
    (text) => {
      seen.push(text);
    }
  );
  assert.deepEqual(outcome, { kind: "ended", exitCode: null });
  assert.deepEqual(seen, []);
});

test("ein ende mit einem exitCode, der keine Zahl ist, fällt auf null", { timeout: DEADLINE_MS }, async () => {
  const agent = agentSending([line({ kind: "end", exitCode: "0" })]);
  const outcome = await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24 },
    () => undefined
  );
  assert.deepEqual(outcome, { kind: "ended", exitCode: null });
});

test("ein Strom, der OHNE ende abreisst, wird getragen und wirft nicht", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ DER WICHTIGSTE FALL DIESER DATEI. Der Exec-Strom hat als EINZIGER der
  // vier Ströme des Agenten KEINE `error`-Zeile; zwei seiner vier Ausgänge
  // (Abbruch des Aufrufers, Rückstau) haben überhaupt keine letzte Zeile. Wer
  // hier auf ein `end` oder auf einen Fehler wartet, wartet für immer — und
  // genau das würde ohne diesen Fall niemandem auffallen.
  const agent = agentSending([line({ kind: "output", text: "halb" })]);
  const seen: string[] = [];
  const outcome = await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24 },
    (text) => {
      seen.push(text);
    }
  );
  assert.deepEqual(outcome, { kind: "unterminated" });
  assert.deepEqual(seen, ["halb"], "die Ausgabe VOR dem Abriss bleibt erhalten");
});

test("der Abbruch durch den Aufrufer ist kein Fehler und ergibt unterminated", { timeout: DEADLINE_MS }, async () => {
  const controller = new AbortController();
  const pushing: { push: ((chunk: string) => void) | null } = { push: null };
  const fetchImpl = (async (_input: string | URL | Request, options?: { signal?: AbortSignal }) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          pushing.push = (chunk: string) => streamController.enqueue(ENCODER.encode(chunk));
          options?.signal?.addEventListener("abort", () => {
            streamController.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const seen: string[] = [];
  let arrived: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const running = startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl, signal: controller.signal, cols: 80, rows: 24 },
    (text) => {
      seen.push(text);
      arrived();
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pushing.push, "der Strom der Attrappe steht nicht");
  pushing.push(line({ kind: "output", text: "noch da" }));
  await first;
  controller.abort();
  // Kein `assert.rejects`: dass diese Zusage überhaupt zurückkommt, IST der
  // Nachweis.
  assert.deepEqual(await running, { kind: "unterminated" });
  assert.deepEqual(seen, ["noch da"]);
});

// ── Die Ablehnungen ───────────────────────────────────────────────────────

test("eine Ablehnung vor der ersten Stromzeile trägt Status UND Schlüssel", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ Der Grund für `openExecStream`. `agentStreamPost` lässt den Fehlerrumpf
  // ABSICHTLICH ungelesen — bei einem Strom gehört er dem Aufrufer. Bei einer
  // Ablehnung gibt es aber keinen Strom, und der Status allein hält die
  // Ablehnungen nicht auseinander: `409` heißt `container-not-started`
  // ODER `no-shell`.
  const agent = agentSending([], { status: 409, payload: { error: "no-shell" } });
  await assert.rejects(
    startExec(
      TARGET,
      "abc",
      { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24 },
      () => undefined
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.detail, { error: "no-shell" });
      return true;
    }
  );
});

test("die Agent-Sitzungs-Id steckt in keinem Rückgabewert dieses Clients", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ Sie kommt ausschließlich über `onStart` heraus — dort, wo die Route sie
  // ins Register koppelt und nirgends sonst hin. `ExecOutcome`, das der
  // Aufrufer am Ende bekommt, trägt sie NICHT: ein Ergebnisobjekt ist genau
  // die Sorte Wert, die versehentlich in eine Antwort serialisiert wird.
  const agent = agentSending([
    line({ kind: "start", session: "agent-id-bleibt-hier", shell: "bash", containerName: "immich" }),
    line({ kind: "output", text: "hallo" }),
    line({ kind: "end", exitCode: 0 })
  ]);
  const starts: ExecStart[] = [];
  const seen: string[] = [];
  const outcome = await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: agent.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24, onStart: (start) => starts.push(start) },
    (text) => {
      seen.push(text);
    }
  );
  assert.equal(starts[0]?.agentSession, "agent-id-bleibt-hier", "der Rückruf bekommt sie sehr wohl");
  assert.ok(
    !JSON.stringify(outcome).includes("agent-id-bleibt-hier"),
    `die Agent-Id steht im Ergebnis: ${JSON.stringify(outcome)}`
  );
  // Und auch nicht in der Ausgabe — der Weg, der geradewegs in den Browser
  // führt.
  assert.ok(!seen.join("").includes("agent-id-bleibt-hier"));
});

test("eine Attrappe, die nie antwortet, wird von der Frist des Aufbaus beendet", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ DER FALL, DER DIE FRIST SELBST PRÜFT. Alle Fälle oben tragen
  // `{ timeout }` als Netz für den Testläufer; dieser prüft, dass der CLIENT
  // eine Frist hat. Ohne sie bliebe ein Aufruf gegen einen Agenten, der die
  // Verbindung annimmt und dann schweigt, bis zum Prozessende offen — und im
  // Betrieb wäre das eine Shell, die sich nie öffnet und nie aufgibt.
  // ⚠️ DIE ATTRAPPE MUSS DAS `signal` BEACHTEN, und das ist selbst eine Lehre
  // dieses Falls: eine Fassung, die einfach nie auflöst, hängt nicht am Client,
  // sondern am Testläufer — er meldet „Promise resolution is still pending"
  // und sagt nichts über die Frist. Ein echtes `fetch` lehnt beim Abbruch mit
  // einem `AbortError` ab; genau das tut sie hier.
  const silent = (async (_input: string | URL | Request, options?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as unknown as typeof fetch;
  await assert.rejects(
    startExec(
      TARGET,
      "abc",
      { actor: ACTOR, fetchImpl: silent, signal: NEVER_ABORTED, cols: 80, rows: 24, timeoutMs: 25 },
      () => undefined
    ),
    (error: unknown) => {
      assert.ok(error instanceof AgentError, "die Frist ergibt einen AgentError und keinen nackten AbortError");
      assert.match(error.message, /25 ms/);
      return true;
    }
  );
});
