import assert from "node:assert/strict";
import test from "node:test";

import { NDJSON_MAX_BUFFERED_CHARS, NDJSON_MAX_LINE_CHARS, readNdjson } from "contract";

// The one case set of the NDJSON reader in `contract/src/stream/ndjson.ts`
// (#252), which server and web both import. Until then each side carried its
// own copy with its own tests (`server/src/agent/ndjson.test.ts`,
// `web/tests/ndjson-line-cap.test.mjs`) and a guard holding both caps equal.
//
// ⚠️ WHY HERE AND NOT UNDER `contract/`. The package loads neither the Node
// typings nor `node:` modules (`contract/tsconfig.json`,
// `web/tests/contract-package.test.mjs`); `node:test` is both. The web tests
// import `contract` through the `source` condition, the same path the
// browser bundle takes.
//
// None of the cases is visible to the eye: a stream of three short lines runs
// through the same with and without each of them.

const NEVER_ABORTED = new AbortController().signal;

/**
 * A body from fixed chunks that counts every `read()`.
 *
 * ⚠️ A HAND-MADE READER AND NO REAL `ReadableStream`. The backpressure case
 * measures WHEN reading continues; a real stream with its own queue would
 * read ahead by itself, and the count would say nothing about the reader.
 */
function bodyOf(chunks, state = { reads: 0, cancelled: false }) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: () => {
        state.reads += 1;
        if (index >= chunks.length) return Promise.resolve({ done: true, value: undefined });
        const chunk = chunks[index++];
        return Promise.resolve({ done: false, value: typeof chunk === "string" ? encoder.encode(chunk) : chunk });
      },
      cancel: () => {
        state.cancelled = true;
        return Promise.resolve();
      }
    })
  };
}

async function collect(chunks) {
  const seen = [];
  await readNdjson(bodyOf(chunks), { signal: NEVER_ABORTED }, (event) => {
    seen.push(event);
  });
  return seen;
}

const line = (text) => `${JSON.stringify({ kind: "line", text })}\n`;

/** A line (without `\n`) whose total length is `length`. */
function envelopeOfLength(length) {
  const frame = JSON.stringify({ kind: "line", text: "" });
  return JSON.stringify({ kind: "line", text: "x".repeat(length - frame.length) });
}

// ── The wire format ──────────────────────────────────────────────────────────

test("eine Zeile über zwei Blöcke kommt einmal und ganz an", async () => {
  const whole = line("über zwei Blöcke");
  const seen = await collect([whole.slice(0, 10), whole.slice(10)]);
  assert.deepEqual(seen, [{ kind: "line", text: "über zwei Blöcke" }]);
});

test("mehrere Zeilen in einem Block kommen einzeln an", async () => {
  const seen = await collect([`${line("a")}${line("b")}${line("c")}`]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["a", "b", "c"]
  );
});

test("ein UTF-8-Zeichen über eine Blockgrenze bleibt ein Zeichen", async () => {
  const bytes = new TextEncoder().encode(line("Straße"));
  // "ß" is two bytes (0xC3 0x9F); cut between them.
  const cut = bytes.indexOf(0xc3) + 1;
  assert.equal(bytes[cut], 0x9f, "der Schnitt liegt nicht im Zeichen");

  const seen = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["Straße"],
    "das halbierte Zeichen wurde zu Ersatzzeichen"
  );
});

test("die letzte Zeile ohne \\n kommt an", async () => {
  const seen = await collect([line("erste"), JSON.stringify({ kind: "line", text: "letzte" })]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["erste", "letzte"],
    "die letzte Zeile eines endenden Stroms fiel weg"
  );
});

test("leere Zeilen werden übergangen", async () => {
  const seen = await collect([`\n\n${line("a")}\n\r\n${line("b")}`]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["a", "b"]
  );
});

test("\\r\\n trennt Zeilen wie \\n, auch über eine Blockgrenze", async () => {
  const first = JSON.stringify({ kind: "line", text: "a" });
  const seen = await collect([`${first}\r`, `\n${JSON.stringify({ kind: "line", text: "b" })}\r\n`]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["a", "b"]
  );
});

test("ungültiges JSON fällt weg, der Strom läuft weiter", async () => {
  const seen = await collect([`{"kind":"line",\n${line("danach")}`]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["danach"]
  );
});

test("gültiges JSON, das kein Objekt ist, fällt weg", async () => {
  const seen = await collect([`42\n[1,2]\nnull\n"text"\n${line("objekt")}`]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["objekt"]
  );
});

// ── The caps ─────────────────────────────────────────────────────────────────

test("die Obergrenzen sind benannt und hängen aneinander", () => {
  assert.equal(NDJSON_MAX_LINE_CHARS, 256 * 1024);
  // One more than a line: the `\r` of a line exactly at the cap.
  assert.equal(NDJSON_MAX_BUFFERED_CHARS, NDJSON_MAX_LINE_CHARS + 1);
});

test("eine Zeile über der Obergrenze fällt weg, die nächste kommt an", async () => {
  const oversized = line("x".repeat(NDJSON_MAX_LINE_CHARS));
  const seen = await collect([oversized, line("danach")]);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["danach"],
    "verworfen wurde die falsche Zeile"
  );
});

test("eine Zeile GENAU auf der Obergrenze läuft durch, auch mit \\r\\n", async () => {
  const exact = envelopeOfLength(NDJSON_MAX_LINE_CHARS);
  assert.equal(exact.length, NDJSON_MAX_LINE_CHARS, "der Fall prüft die falsche Länge");

  assert.equal((await collect([`${exact}\n`])).length, 1, "der größte zugelassene Umschlag fiel weg (\\n)");
  assert.equal((await collect([`${exact}\r\n`])).length, 1, "der größte zugelassene Umschlag fiel weg (\\r\\n)");
  // Same, with the line split so that it waits in the buffer for its `\n`.
  assert.equal(
    (await collect([`${exact}\r`, "\n"])).length,
    1,
    "der größte Umschlag passte nicht in den Puffer"
  );
});

test("eine 1-MiB-Zeile ohne Umbruch über viele Blöcke wird verworfen, nicht gesammelt", async () => {
  // The measured case of #117: an agent or a proxy losing a `\n`.
  const piece = "y".repeat(64 * 1024);
  const chunks = [`{"kind":"line","text":"`, ...Array.from({ length: 16 }, () => piece), `"}\n${line("danach")}`];
  const seen = await collect(chunks);
  assert.deepEqual(
    seen.map((event) => event.text),
    ["danach"],
    "der Strom hat sich nach der überlangen Zeile nicht wiedergefunden"
  );
});

test("eine überlange Zeile ohne abschließendes \\n fällt ebenfalls weg", async () => {
  const seen = await collect([`{"kind":"line","text":"${"z".repeat(NDJSON_MAX_LINE_CHARS)}`]);
  assert.deepEqual(seen, [], "der Rest ohne Zeilenumbruch kam an der Obergrenze vorbei");
});

// ── Backpressure ─────────────────────────────────────────────────────────────

test("ein Rückruf, der ein Promise gibt, hält das Lesen an", async () => {
  const state = { reads: 0, cancelled: false };
  const seen = [];
  const gate = { release: null };
  const done = readNdjson(bodyOf([line("erste"), line("zweite")], state), { signal: NEVER_ABORTED }, (event) => {
    seen.push(event.text);
    if (seen.length > 1) return;
    return new Promise((resolve) => {
      gate.release = resolve;
    });
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["erste"], "der Leser las weiter, obwohl der Aufrufer noch nicht bereit war");
  assert.equal(state.reads, 1, `es wurde ${state.reads} Mal gelesen statt einmal`);

  assert.ok(gate.release !== null, "der Rückruf lief gar nicht");
  gate.release();
  await done;
  assert.deepEqual(seen, ["erste", "zweite"], "nach dem Auflösen lief der Strom nicht weiter");
});

// ── Cancellation ─────────────────────────────────────────────────────────────

test("ein Abbruch mitten im Strom beendet den Leser ohne hängende Promise", async () => {
  // A real stream that delivers one line and then stays silent forever.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line("vorher")));
    }
  });
  const controller = new AbortController();
  const seen = [];
  const done = readNdjson(stream, { signal: controller.signal }, (event) => {
    seen.push(event.text);
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const outcome = await Promise.race([
    done.then(() => "ended"),
    new Promise((resolve) => setTimeout(() => resolve("hanging"), 1000))
  ]);
  assert.equal(outcome, "ended", "der Leser hing nach dem Abbruch");
  assert.deepEqual(seen, ["vorher"]);
});

test("ein Abbruch, während der Rückruf wartet, beendet den Leser und liefert nichts mehr", async () => {
  const state = { reads: 0, cancelled: false };
  const controller = new AbortController();
  const seen = [];
  const done = readNdjson(bodyOf([`${line("erste")}${line("zweite")}`], state), { signal: controller.signal }, (event) => {
    seen.push(event.text);
    // Never settles: a write to a browser that has gone away.
    return new Promise(() => undefined);
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const outcome = await Promise.race([
    done.then(() => "ended"),
    new Promise((resolve) => setTimeout(() => resolve("hanging"), 1000))
  ]);
  assert.equal(outcome, "ended", "der Leser hing am Rückruf");
  assert.deepEqual(seen, ["erste"], "nach dem Abbruch kam noch eine Zeile an");
  assert.ok(state.cancelled, "die Verbindung wurde nicht freigegeben");
});

test("ein schon abgebrochenes Signal liest gar nicht erst", async () => {
  const state = { reads: 0, cancelled: false };
  const controller = new AbortController();
  controller.abort();
  const seen = [];
  await readNdjson(bodyOf([line("a")], state), { signal: controller.signal }, (event) => {
    seen.push(event);
  });
  assert.equal(state.reads, 0);
  assert.deepEqual(seen, []);
  assert.ok(state.cancelled, "die Verbindung wurde nicht freigegeben");
});

test("ein Fehler im Strom ohne Abbruch geht hinaus", async () => {
  const body = {
    getReader: () => ({
      read: () => Promise.reject(new Error("broken")),
      cancel: () => Promise.resolve()
    })
  };
  await assert.rejects(readNdjson(body, { signal: NEVER_ABORTED }, () => undefined), /broken/);
});
