import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Response } from "express";

import { ndjsonWriter } from "./stream-response.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Gegendruck (#131) ist am Augenschein nicht zu sehen: eine Fassung, die
// den Rückgabewert von `response.write` übergeht, schreibt dieselben Zeilen in
// derselben Reihenfolge hinaus. Der Unterschied liegt darin, WANN der Aufrufer
// weitermachen darf — und wer das nicht prüft, merkt vom Rückstau erst etwas,
// wenn er im Speicher des Hubs liegt. Drei Fälle:
//
//   1. NIMMT DER PUFFER, WARTET NIEMAND. Ein Schreiber, der bei jeder Zeile
//      einen Takt wartete, machte aus dem Log ein Ruckeln.
//   2. NIMMT ER NICHT, WARTET DER AUFRUFER — bis zum Ereignis `drain`.
//   3. EIN ABRISS ZÄHLT WIE `drain`. Eine abgerissene Verbindung sendet kein
//      `drain` mehr; wer nur darauf hört, lässt den Aufrufer für immer stehen,
//      und mit ihm den Strom zum Arm, der einen der Plätze hält.
//
// Alle drei prüfen mit, dass hinterher keine Zuhörer liegen bleiben: ein
// Zuhörer je gestauter Zeile ist ein Leck, und Node meldet es erst ab elf.

type FakeResponse = EventEmitter & {
  /** Jede Zeile, die hinausgegangen ist. */
  written: string[];
  /** Was `response.write` das nächste Mal zurückgibt. */
  accepts: boolean;
};

/**
 * Eine Antwort, die sich wie die von Express verhält — und sonst nichts kann.
 *
 * ⚠️ EIN `EventEmitter` UND KEIN OBJEKTLITERAL MIT EIGENEM `once`. Der
 * Schreiber meldet sich mit `once` an und mit `off` wieder ab; ein von Hand
 * gebauter Ersatz hätte genau die Abmeldung nicht, und die Zählung der Zuhörer
 * prüfte dann ihr eigenes Gerüst.
 */
function fakeResponse(): FakeResponse {
  const response = new EventEmitter() as FakeResponse;
  response.written = [];
  response.accepts = true;
  Object.assign(response, {
    status: () => response,
    setHeader: () => response,
    flushHeaders: () => undefined,
    writableEnded: false,
    write: (chunk: string): boolean => {
      response.written.push(chunk);
      return response.accepts;
    },
    end: () => response
  });
  return response;
}

const writerOn = (response: FakeResponse) => ndjsonWriter(response as unknown as Response);

/** Einen Takt vergehen lassen, ohne etwas auszulösen. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Dass am Ende nichts hängen bleibt, gehört zu jedem der drei Fälle. */
function assertNoListenersLeft(response: FakeResponse): void {
  assert.equal(response.listenerCount("drain"), 0, `es blieben ${response.listenerCount("drain")} Zuhörer auf drain`);
  assert.equal(response.listenerCount("close"), 0, `es blieben ${response.listenerCount("close")} Zuhörer auf close`);
}

// ── 1. Nimmt der Puffer, wartet niemand ──────────────────────────────────────

test("solange der Ausgabepuffer nimmt, steht der Gegendruck schon fest", async () => {
  const response = fakeResponse();
  const writer = writerOn(response);

  const settled = { done: false };
  void writer.write({ kind: "line", text: "erste" }).then(() => {
    settled.done = true;
  });
  await tick();

  assert.equal(settled.done, true, "der Schreiber wartete, obwohl der Puffer genommen hat");
  assert.deepEqual(response.written, ['{"kind":"line","text":"erste"}\n']);
  assertNoListenersLeft(response);
});

// ── 2. Nimmt er nicht, wartet der Aufrufer ───────────────────────────────────

test("ist der Ausgabepuffer voll, löst sich der Gegendruck erst mit dem Ereignis drain", async () => {
  const response = fakeResponse();
  const writer = writerOn(response);
  response.accepts = false;

  const settled = { done: false };
  void writer.write({ kind: "line", text: "erste" }).then(() => {
    settled.done = true;
  });
  await tick();

  // ⚠️ Die Zeile ist trotzdem draußen. Der Gegendruck bremst den NÄCHSTEN
  // Schreiber; er hält die eben geschriebene Zeile nicht zurück.
  assert.deepEqual(response.written, ['{"kind":"line","text":"erste"}\n']);
  assert.equal(settled.done, false, "der Schreiber lief weiter, obwohl der Puffer voll war");

  response.emit("drain");
  await tick();

  assert.equal(settled.done, true, "nach dem drain lief der Schreiber nicht weiter");
  assertNoListenersLeft(response);
});

// ── 3. Ein Abriss zählt wie `drain` ──────────────────────────────────────────

test("eine abgerissene Verbindung löst den Gegendruck ebenfalls", async () => {
  const response = fakeResponse();
  const writer = writerOn(response);
  response.accepts = false;

  const settled = { done: false };
  void writer.write({ kind: "line", text: "erste" }).then(() => {
    settled.done = true;
  });
  await tick();
  assert.equal(settled.done, false, "der Fall prüft den falschen Zustand");

  response.emit("close");
  await tick();

  assert.equal(settled.done, true, "der Schreiber wartete nach dem Abriss auf ein drain, das nie kommt");
  assertNoListenersLeft(response);
});
