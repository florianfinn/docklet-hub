import assert from "node:assert/strict";
import test from "node:test";

import { applyCompose } from "../src/features/compose/api.ts";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// `applyCompose` liest einen STROM, und an einem Strom ist genau das still
// falsch, was ein Test mit einer fertigen Antwort nicht sieht. Vier Fälle,
// jeder gegen einen anderen dieser stillen Fehler:
//
//   1. KEIN AUSGANG IST KEIN ERFOLG. Ein Strom, der ohne Abschlusszeile endet,
//      sagt NICHTS über den Stand des Stacks. Eine Fassung, die daraus
//      „fertig" macht, bestünde jeden Test, der nur den Erfolgsfall prüft —
//      und meldete einen Stack als angewandt, über den niemand etwas weiß.
//   2. EINE RÜCKFRAGE IST KEIN FEHLSCHLAG. Sie kommt als Zeile und nicht als
//      Status, weil der Strom längst steht; wer sie als Fehler behandelt,
//      macht aus einer beantwortbaren Frage eine Sackgasse.
//   3. `live: false` MUSS ANKOMMEN. Ohne die Angabe zeigt die Fläche eine
//      Schrittliste, in der für immer der erste Schritt läuft.
//   4. DIE SCHRITTE MÜSSEN DURCHGEREICHT WERDEN, WÄHREND SIE KOMMEN — nicht
//      gesammelt und am Ende ausgeliefert. Genau dafür gibt es den Strom.

const INPUT = {
  content: "services:\n  sonarr:\n    image: sonarr:1\n",
  expectedComposeHash: "h1",
  confirmNew: [],
  confirmRemoved: [],
  acknowledgeImagePull: [],
  acknowledgeHardening: []
};

/** Ein Fake-`fetch`, der die Zeilen in den angegebenen Stücken ausliefert. */
function streaming(chunks) {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader() {
          let index = 0;
          return {
            read: () =>
              Promise.resolve(
                index < chunks.length
                  ? { done: false, value: new TextEncoder().encode(chunks[index++]) }
                  : { done: true, value: undefined }
              ),
            cancel: () => Promise.resolve()
          };
        }
      }
    });
}

async function run(chunks, seen = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = streaming(chunks);
  try {
    return await applyCompose("h1", "c1", INPUT, {
      signal: new AbortController().signal,
      onStart: (start) => {
        seen.start = start;
      },
      onStep: (step) => {
        (seen.steps ??= []).push(step.step);
      }
    });
  } finally {
    globalThis.fetch = original;
  }
}

test("ein Strom ohne Abschlusszeile gilt NICHT als angewandt", async () => {
  const outcome = await run([
    '{"kind":"start","stackName":"medien"}\n',
    '{"kind":"step","step":"write-file"}\n'
  ]);
  // ⚠️ Der gefährlichste Ausgang von allen. Die Datei kann geschrieben und der
  // Stack halb gestartet sein; „fertig" wäre hier eine Behauptung über etwas,
  // das niemand gemessen hat.
  assert.equal(outcome.kind, "failed");
  // ⚠️ `null` und kein Wort (#176): bis dahin stand hier `unbekannt`, ein Wort
  // des Browsers in dem Feld, in dem sonst die Schlüssel des Agenten stehen.
  assert.ok(outcome.reason === null, `der Browser erfindet einen Grund: ${JSON.stringify(outcome.reason)}`);
});

test("eine fehler-Zeile ohne Grund bleibt ohne Grund, und ein Grund kommt roh an (#176)", async () => {
  const bare = await run(['{"kind":"start","stackName":"medien"}\n', '{"kind":"error"}\n']);
  assert.equal(bare.kind, "failed");
  assert.ok(bare.reason === null, `der Browser erfindet einen Grund: ${JSON.stringify(bare.reason)}`);

  const named = await run(['{"kind":"start","stackName":"medien"}\n', '{"kind":"error","reason":"x-neu"}\n']);
  assert.deepEqual(named, { kind: "failed", reason: "x-neu" });
});

test("ein Ergebnis ohne Abgleichsstatus trägt null und kein erfundenes Wort (#176)", async () => {
  const outcome = await run(['{"kind":"start","stackName":"medien"}\n', '{"kind":"result","applied":{}}\n']);
  assert.equal(outcome.kind, "applied");
  assert.ok(outcome.resync.status === null, `erfundener Status: ${JSON.stringify(outcome.resync.status)}`);
});

test("ein eigener Abbruch ist kein Fehlschlag und trägt keinen Grund (#173)", async () => {
  // ⚠️ Bis #173 kam hier `failed` mit dem Grund `abgebrochen` heraus — ein Wort
  // des Browsers in dem Feld, in dem sonst die Schlüssel des Agenten stehen.
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = () => {
    controller.abort();
    return Promise.reject(new DOMException("Der Vorgang wurde abgebrochen.", "AbortError"));
  };
  try {
    const before = await applyCompose("h1", "c1", INPUT, { signal: controller.signal });
    assert.deepEqual(before, { kind: "detached" });
  } finally {
    globalThis.fetch = original;
  }

  // Und mitten im Strom: der Ausgang fehlt, weil niemand mehr liest — nicht,
  // weil der Strom ohne ihn endete. Das bleibt vom Fall oben unterschieden.
  const midway = new AbortController();
  globalThis.fetch = () => {
    const response = streaming(['{"kind":"start","stackName":"medien"}\n'])();
    midway.abort();
    return response;
  };
  try {
    const during = await applyCompose("h1", "c1", INPUT, { signal: midway.signal });
    assert.deepEqual(during, { kind: "detached" });
  } finally {
    globalThis.fetch = original;
  }
});

test("eine Rückfrage kommt als Frage an und nicht als Fehlschlag", async () => {
  const outcome = await run([
    '{"kind":"start","stackName":"medien"}\n',
    '{"kind":"question","question":{"kind":"images","missing":["radarr:1"]}}\n'
  ]);
  assert.equal(outcome.kind, "question");
  // Die Liste muss MITKOMMEN — der Hub kann sie nicht selbst bilden, und ohne
  // sie ist die Frage unbeantwortbar.
  assert.deepEqual(outcome.question, { kind: "images", missing: ["radarr:1"] });
});

test("das Ergebnis trägt den Abgleich mit, statt ihn zu verschweigen", async () => {
  const outcome = await run([
    '{"kind":"start","stackName":"medien"}\n',
    '{"kind":"result","applied":{"ok":true},"resync":{"status":"failed","error":"Arm abgelehnt"}}\n'
  ]);
  assert.equal(outcome.kind, "applied");
  // ⚠️ Ein gescheiterter Abgleich lässt das Anwenden gelten und meldet sich
  // trotzdem: der Arm trägt sonst bis zum nächsten Takt die alte Allowlist.
  assert.deepEqual(outcome.resync, { status: "failed", error: "Arm abgelehnt" });
});

test("ein Arm ohne Strom meldet live: false, und keine Schritte werden erfunden", async () => {
  const seen = {};
  const outcome = await run(
    [
      '{"kind":"start","stackName":"medien","projectDir":"","composeFileName":"","live":false}\n',
      '{"kind":"result","applied":{"ok":true},"resync":{"status":"skipped","error":null}}\n'
    ],
    seen
  );
  assert.equal(outcome.kind, "applied");
  assert.equal(seen.start.live, false);
  assert.equal(seen.steps, undefined, "erfundene Schritte wären schlimmer als keine");
});

test("die Schritte kommen einzeln an, auch wenn ein Umschlag über zwei Chunks läuft", async () => {
  const seen = {};
  // ⚠️ EIN CHUNK IST KEINE ZEILE. Der zweite Umschlag ist hier absichtlich
  // mitten durchgeschnitten; ohne den Puffer im Zerleger wäre er zweimal
  // kaputtes JSON und der Schritt fiele lautlos weg.
  await run(
    [
      '{"kind":"start","stackName":"medien"}\n{"kind":"step","step":"ch',
      'eck"}\n{"kind":"step","step":"start"}\n',
      '{"kind":"result","applied":{},"resync":{"status":"synced","error":null}}\n'
    ],
    seen
  );
  assert.deepEqual(seen.steps, ["check", "start"]);
});
