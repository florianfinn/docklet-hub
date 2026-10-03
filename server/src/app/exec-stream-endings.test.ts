import test from "node:test";
import assert from "node:assert/strict";

import { HUB_STREAM_BROKEN } from "contract";
import { envelopes, openShell, readAll, startAgent, startHub, waitFor } from "./exec-test-support.js";

// WIE EIN SHELL-STROM OHNE `end` AUFHÖRT — und was der Hub dann schreibt (#173).
//
// Der Agent kennt im Exec-Strom keine `error`-Zeile; hört sein Strom ohne
// `end` auf, sagt er nichts mehr. Die letzte Zeile, die der Browser dann
// liest, kommt vom Hub, und es gibt vier Lagen:
//
//   der Arm endet ohne Abschluss      `agent-stream-broken`
//   der Rumpf zum Arm reißt ab        `agent-stream-broken`
//   der Hub schließt auf Zuruf        `session-closed`  (exec-session-routes.test.ts)
//   der Browser ist weg               nichts
//
// ⚠️ BIS #173 STAND IN DEN ERSTEN DREI LAGEN `abgebrochen`, in der vierten
// auch. Das war das Wort, mit dem der Agent bis v0.23.0 den Abbruch des
// Aufrufers meinte, und derselbe Befund, den #130 für den Log-Strom behoben
// hat.
//
// ⚠️ EINE EIGENE DATEI, weil `exec-routes.test.ts` die Eröffnung und
// `exec-session-routes.test.ts` die drei kurzen Routen hält; das Ende des
// Stroms ist keins von beiden.

test("endet der Strom des Arms ohne Abschluss, schreibt der Hub agent-stream-broken", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);

    // Ein ordentliches Ende ohne `end`-Zeile — beim Hub `unterminated`, und
    // ausgelöst hat es NICHT der Hub.
    agent.finish();
    const rest = await readAll(shell.reader);
    assert.deepEqual(envelopes(rest), [{ kind: "error", reason: HUB_STREAM_BROKEN }]);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("reißt der Rumpf zum Arm ab, schreibt der Hub agent-stream-broken", async () => {
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);

    agent.tear();
    const rest = await readAll(shell.reader);
    assert.deepEqual(envelopes(rest), [{ kind: "error", reason: HUB_STREAM_BROKEN }]);
  } finally {
    await hub.close();
    await agent.close();
  }
});

test("bricht der Browser ab, schreibt der Hub gar keinen Grund", async () => {
  // ⚠️ GEMESSEN WIRD AM MITSCHNITT DES HUBS UND NICHT AM LESER. Nach dem
  // Abbruch ist der Leser fort; was der Hub dann noch schriebe, sähe er nicht
  // mehr. `hub.written` hält jedes Stück fest, das an `response.write` ging.
  const agent = await startAgent();
  const hub = await startHub({ agent });
  try {
    const shell = await openShell(hub, agent);
    const before = hub.written.length;

    shell.controller.abort();
    await waitFor(() => agent.hungUp === 1, "der Hub hat den Strom zum Arm offen gelassen");
    // Der Zweig nach `startExec` läuft erst, nachdem der Strom zum Arm zu ist.
    // Eine Runde der Ereignisschleife mehr, damit er gelaufen sein KANN — sonst
    // wäre das Schweigen unten nur ein zu früher Blick.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = hub.written.slice(before).join("");
    assert.ok(!after.includes('"error"'), `Der Hub hat nach dem Abbruch noch geschrieben: ${after}`);
  } finally {
    await hub.close();
    await agent.close();
  }
});
