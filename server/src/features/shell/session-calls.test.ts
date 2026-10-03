import test from "node:test";
import assert from "node:assert/strict";

import { ACTOR, agentAnswering, agentSending, DEADLINE_MS, line, NEVER_ABORTED, TARGET } from "./agent-client-test-support.js";
import { closeExec, resize, sendInput, startExec } from "./agent-client.js";

// The three short calls of the agent client of the feature `shell` (#260) —
// input, size and close — and the promise that holds over all four calls: the
// caller is always the signed-in person. The stream is `agent-client.test.ts`.

// ── Die Eingabe ─────────────────────────────────────────────────────────────

test("die Eingabe geht als base64 hinaus — an einem Fall, der es erzwingt", async () => {
  // ⚠️ EIN `ls` LIEFE AUCH MIT DEM FALSCHEN BAU GRÜN DURCH. Geprüft wird
  // deshalb an einem Zeichen außerhalb von ASCII (ein „ß", in UTF-8 zwei
  // Bytes) und an einem Steuerzeichen (Ctrl-C, 0x03) — beide sind in Klartext
  // im JSON-Rumpf sofort zu unterscheiden.
  const agent = agentAnswering();
  const bytes = new Uint8Array([0xc3, 0x9f, 0x03]);
  await sendInput(TARGET, "agent-7", bytes, { actor: ACTOR, fetchImpl: agent.fetchImpl });

  assert.equal(agent.calls[0].url, "http://docker-agent:8099/exec/agent-7/input");
  assert.equal(agent.calls[0].method, "POST");
  const sent = JSON.parse(agent.calls[0].body ?? "null");
  // Der erwartete Wert steht als LITERAL da und wird nicht mit demselben
  // `Buffer` gerechnet, mit dem der Client ihn erzeugt — sonst prüfte der Fall
  // sich selbst.
  assert.deepEqual(sent, { data: "w58D" });
  // Und die Gegenprobe: Klartext sähe anders aus und käme im Container als
  // Zeichensalat an. Das Steuerzeichen steht dabei als Escape und nicht als
  // Zeichen: ein rohes Steuerzeichen in einer Quelldatei hält der Wächter in
  // `web/tests/control-characters.test.mjs` an — und er hat es hier beim ersten
  // Schreiben dieses Falls auch getan. Das „ß" bleibt ein echtes Zeichen; ein
  // Umlaut in ASCII-Umschreibung wäre der Verstoß, den der andere Wächter
  // anhält.
  assert.ok(!(agent.calls[0].body ?? "").includes("ß"), "der Rumpf trägt Klartext statt base64");
  assert.ok(!(agent.calls[0].body ?? "").includes("\u0003"), "der Rumpf trägt ein rohes Steuerzeichen");
});

test("die Sitzungs-Id wird für die Adresse kodiert", async () => {
  const agent = agentAnswering();
  await sendInput(TARGET, "a/b", new Uint8Array([0x61]), { actor: ACTOR, fetchImpl: agent.fetchImpl });
  assert.equal(agent.calls[0].url, "http://docker-agent:8099/exec/a%2Fb/input");
});

test("eine leere Eingabe geht als leere Zeichenkette hinaus", async () => {
  const agent = agentAnswering();
  await sendInput(TARGET, "agent-7", new Uint8Array([]), { actor: ACTOR, fetchImpl: agent.fetchImpl });
  assert.deepEqual(JSON.parse(agent.calls[0].body ?? "null"), { data: "" });
});

// ── Größe und Schließen ─────────────────────────────────────────────────────

test("resize schickt cols und rows an die Sitzung", async () => {
  const agent = agentAnswering();
  await resize(TARGET, "agent-7", { cols: 100, rows: 30 }, { actor: ACTOR, fetchImpl: agent.fetchImpl });
  assert.equal(agent.calls[0].url, "http://docker-agent:8099/exec/agent-7/size");
  assert.equal(agent.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(agent.calls[0].body ?? "null"), { cols: 100, rows: 30 });
});

test("closeExec schickt einen leeren Rumpf an die Schliess-Route", async () => {
  const agent = agentAnswering();
  await closeExec(TARGET, "agent-7", { actor: ACTOR, fetchImpl: agent.fetchImpl });
  assert.equal(agent.calls[0].url, "http://docker-agent:8099/exec/agent-7/close");
  assert.equal(agent.calls[0].method, "POST");
  assert.deepEqual(JSON.parse(agent.calls[0].body ?? "null"), {});
});

// ── Die Zusage, die kein Typ erzwingt ───────────────────────────────────────

test("der Aufrufer ist über ALLE VIER Aufrufe derselbe user:<id> und niemals leer", { timeout: DEADLINE_MS }, async () => {
  // ⚠️ DIE WICHTIGSTE ZUSAGE DIESER ETAPPE, UND SIE IST EIN TEST UND KEIN
  // KOMMENTAR. Der Agent vergleicht `session.actor !== actor` STRIKT gegen
  // `string | null` (`src/exec.ts:194`): zwei Aufrufer mit `actor === null`
  // gelten damit als DERSELBE. Ein leerer Aufrufer an einer dieser vier Routen
  // machte jede offene Shell für jeden zugänglich, der eine Sitzungs-Id in die
  // Hand bekommt — und zwar OHNE dass irgendetwas fehlschlägt: der Aufruf
  // gelingt, die Shell antwortet, und niemand merkt es.
  //
  // ⚠️ Geprüft wird über alle vier Aufrufe HINWEG und nicht je Aufruf einzeln.
  // Die Gefahr ist nicht, dass einer der vier keinen Aufrufer sendet, sondern
  // dass DREI ihn senden und einer nicht — dann trägt die Sitzung einen
  // Aufrufer, und der eine Weg hinein trägt keinen.
  const stream = agentSending([line({ kind: "end", exitCode: 0 })]);
  const short = agentAnswering();
  const options = { actor: ACTOR, fetchImpl: short.fetchImpl };

  await startExec(
    TARGET,
    "abc",
    { actor: ACTOR, fetchImpl: stream.fetchImpl, signal: NEVER_ABORTED, cols: 80, rows: 24 },
    () => undefined
  );
  await sendInput(TARGET, "agent-7", new Uint8Array([0x61]), options);
  await resize(TARGET, "agent-7", { cols: 90, rows: 30 }, options);
  await closeExec(TARGET, "agent-7", options);

  const calls = [...stream.calls, ...short.calls];
  assert.equal(calls.length, 4, "es sind vier Aufrufe und nicht mehr oder weniger");
  for (const call of calls) {
    const actor = call.headers["x-docker-agent-actor"];
    assert.equal(actor, "user:u-1", `${call.url}: der Aufrufer ist nicht user:u-1, sondern „${String(actor)}"`);
    // Die drei Formen, in denen ein leerer Aufrufer beim Agenten als `null`
    // ankäme — jede einzeln benannt, damit die Meldung sagt, welche es war.
    assert.notEqual(actor, undefined, `${call.url}: keine Aufrufer-Kopfzeile`);
    assert.notEqual(actor, "", `${call.url}: leere Aufrufer-Kopfzeile`);
    assert.ok(actor.startsWith("user:"), `${call.url}: der Aufrufer ist kein Mensch`);
    assert.ok(actor.length > "user:".length, `${call.url}: user: ohne Kennung dahinter`);
  }
  // Und alle vier tragen DENSELBEN Wert. Vier verschiedene wären beim Agenten
  // vier verschiedene Menschen, und drei von ihnen kämen nicht in die Sitzung.
  assert.equal(new Set(calls.map((call) => call.headers["x-docker-agent-actor"])).size, 1);
});
