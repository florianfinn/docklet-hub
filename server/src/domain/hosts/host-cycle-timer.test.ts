import test from "node:test";
import assert from "node:assert/strict";

import { createCycleRunner, startCycleTimer, type IntervalHandle } from "./host-cycle-timer.js";

// Riegel, Abschalter und `unref()` — geprüft ohne echte Uhr.
//
// ⚠️ KEIN `await new Promise((resolve) => setTimeout(resolve, …))` in dieser
// Datei. Der Zeitgeber bekommt seinen `setInterval`-Ersatz eingespeist, und
// der Riegel wird durch Aufrufe von Hand geprüft. Ein Test, der auf eine echte
// Uhr wartet, macht den Lauf langsam und wackelig — und ausgerechnet ein
// Riegel gegen überlappende Läufe wäre dann der Fall, der mal grün und mal rot
// ist.

// Ein Versprechen, das dieser Test von Hand einlöst — so lässt sich ein
// „gerade laufender" Durchlauf beliebig lange offen halten.
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve = (): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<void>((resolveImpl, rejectImpl) => {
    resolve = resolveImpl;
    reject = rejectImpl;
  });
  return { promise, resolve, reject };
}

test("kein zweiter Durchlauf, solange einer läuft", async () => {
  // ⚠️ Der Fall, für den es den Riegel gibt: ein Arm mit Frist 3 s und zwanzig
  // Armen kann länger dauern als das Intervall. Ohne Riegel startete jeder
  // Tick einen weiteren Durchlauf, und die Zahl der gleichzeitigen Abfragen
  // gegen denselben Agenten wüchse, bis der Hub keine Verbindungen mehr
  // bekommt.
  const gate = deferred();
  let starts = 0;
  let overlaps = 0;
  const runner = createCycleRunner({
    run: () => {
      starts += 1;
      return gate.promise;
    },
    onError: () => assert.fail("kein Fehler erwartet"),
    onOverlap: () => {
      overlaps += 1;
    }
  });

  runner.trigger();
  assert.equal(starts, 1);
  assert.equal(runner.isRunning(), true);

  runner.trigger();
  runner.trigger();
  assert.equal(starts, 1, "die beiden folgenden Ticks starten nichts");
  assert.equal(overlaps, 2);

  gate.resolve();
  await gate.promise;
  // Der Riegel löst im `finally` und damit einen Mikrotask nach dem Einlösen.
  await Promise.resolve();
  assert.equal(runner.isRunning(), false);

  runner.trigger();
  assert.equal(starts, 2, "nach dem Ende läuft der nächste Tick wieder durch");
});

test("ein abgelehnter Durchlauf löst den Riegel und meldet den Fehler", async () => {
  // ⚠️ Bliebe der Riegel nach einem Fehler gesetzt, wäre der Lauf ab dem
  // ersten Fehler dauerhaft tot — lautlos, denn der Zeitgeber tickte weiter.
  const gate = deferred();
  const errors: unknown[] = [];
  let starts = 0;
  const runner = createCycleRunner({
    run: () => {
      starts += 1;
      return gate.promise;
    },
    onError: (error) => errors.push(error)
  });

  runner.trigger();
  gate.reject(new Error("listHosts: Verbindung zur Datenbank verloren"));
  await gate.promise.catch(() => undefined);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "listHosts: Verbindung zur Datenbank verloren");
  assert.equal(runner.isRunning(), false);

  runner.trigger();
  assert.equal(starts, 2, "der nächste Tick läuft trotz des Fehlers");
});

test("ein Fehler im Durchlauf verlässt den Zeitgeber nicht als unbehandelte Ablehnung", async () => {
  // Ohne das `catch` in `createCycleRunner` stünde hier eine unbehandelte
  // Ablehnung im Prozess — und die beendet unter Node den Hub.
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const runner = createCycleRunner({
      run: () => Promise.reject(new Error("kaputt")),
      onError: () => undefined
    });
    runner.trigger();
    // Zwei Mikrotask-Runden reichen, damit eine unbehandelte Ablehnung
    // gemeldet würde; gewartet wird auf keine Uhr.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(rejections, []);
});

test("Intervall 0 schaltet den Lauf ab und legt keinen Zeitgeber an", () => {
  // Die Bremse: sie steht in der Umgebung und braucht keinen neuen Bau.
  let created = 0;
  const timer = startCycleTimer({
    intervalMs: 0,
    runner: { trigger: () => assert.fail("nichts darf laufen"), isRunning: () => false },
    setIntervalImpl: () => {
      created += 1;
      return {};
    }
  });

  assert.equal(timer.started, false);
  assert.equal(created, 0);
  // `stop()` auf einem abgeschalteten Zeitgeber ist erlaubt und tut nichts —
  // der Aufrufer soll nicht zwei Fälle unterscheiden müssen.
  timer.stop();
});

test("der laufende Zeitgeber ruft trigger, ist unref-t und lässt sich anhalten", () => {
  let handler = (): void => assert.fail("kein Handler angemeldet");
  let interval = -1;
  let unrefCalls = 0;
  let cleared: IntervalHandle | null = null;
  let triggers = 0;
  const handle: IntervalHandle = {
    unref: () => {
      unrefCalls += 1;
    }
  };

  const timer = startCycleTimer({
    intervalMs: 60_000,
    runner: { trigger: () => (triggers += 1), isRunning: () => false },
    setIntervalImpl: (givenHandler, ms) => {
      handler = givenHandler;
      interval = ms;
      return handle;
    },
    clearIntervalImpl: (given) => {
      cleared = given;
    }
  });

  assert.equal(timer.started, true);
  assert.equal(interval, 60_000);
  // ⚠️ Ohne `unref()` hält der Zeitgeber den Prozess am Leben; `node` beendet
  // sich erst, wenn keine offene Uhr mehr da ist.
  assert.equal(unrefCalls, 1);

  handler();
  handler();
  assert.equal(triggers, 2, "jeder Tick geht an den Riegel und nicht am ihm vorbei");

  timer.stop();
  assert.ok(cleared === handle, "stop() räumt genau diesen Zeitgeber ab");
});

test("ein Griff ohne unref bringt den Zeitgeber nicht um", () => {
  // Die Attrappe eines Tests trägt kein `unref`; der Aufruf ist optional
  // gehalten, damit ein solcher Griff nicht in einen Typfehler zur Laufzeit
  // läuft.
  const timer = startCycleTimer({
    intervalMs: 1_000,
    runner: { trigger: () => undefined, isRunning: () => false },
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => undefined
  });
  assert.equal(timer.started, true);
  timer.stop();
});
