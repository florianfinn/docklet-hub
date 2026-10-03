// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`). `shell-harness.js` zieht ihn
// als erstes.
import {
  at,
  CONTAINER,
  ENCODER,
  execCalls,
  HOST,
  lab,
  line,
  mount,
  open,
  phase,
  send,
  SESSION,
  status,
  stubHub
} from "./shell-harness.js";
import { settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { de, en } from "../src/app/i18n/messages.js";
import type { SurfaceLoader } from "../src/features/shell/terminal-look.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Was in den Reiter „Shell" HEREINKOMMT (Paket B6, Etappe E6, #5): das
// Nachladen von `@xterm`, der Strom des Hubs und die fünf Zustände des Kopfs.
// Was HINAUSGEHT, steht in `shell-input.test.tsx`; der Prüfstand ist beiden
// gemeinsam und steht in `shell-harness.tsx`.
//
// Fünf stille Fehler, jeder mit eigenem Fall:
//
//   1. DER IMPORT LÖST NACH DEM AUSHÄNGEN AUF. Wer danach ein Terminal baut,
//      hängt es in einen Knoten, den React entfernt hat — und niemand räumt es
//      wieder ab. Im StrictMode passiert das bei JEDEM Einhängen einmal.
//   2. DAS AUFRÄUMEN BEIM AUSHÄNGEN. Ein `Terminal` ohne `dispose()` hält
//      seine Zeitgeber und seinen Puffer; eine Sitzung ohne `close` hält einen
//      von VIER Plätzen des ganzen Arms.
//   3. DURCHREICHEN STATT SAMMELN. Eine Fassung, die den Rumpf erst
//      vollständig liest, bestünde jeden Test, der nur das Ende prüft — und
//      ein Terminal, das erst am Ende etwas zeigt, ist keines.
//   4. FÜNF ZUSTÄNDE SIND NICHT EINER. `end` mit einer Zahl und `end` mit
//      `null` sind zwei verschiedene Auskünfte, keine Varianten voneinander.
//   5. EIN UNBEKANNTER GRUND DARF NICHT IN EINEN LEEREN KOPF MÜNDEN.

// ── 1. Aushängen, während der Import noch läuft ─────────────────────────────

test("wird ausgehängt, während der Import läuft, entsteht kein Terminal", async () => {
  const surfaces = lab();
  const server = stubHub();
  const mounted = await mount(surfaces.load);

  assert.equal(surfaces.calls > 0, true, "der Reiter hat @xterm gar nicht erst angefordert");
  assert.equal(surfaces.built.length, 0, "es steht schon ein Terminal, bevor der Import da ist");
  assert.deepEqual(execCalls(server), [], "der Strom geht auf, bevor das Terminal gemessen ist");

  await mounted.unmount();

  // JETZT kommt der Import an — in einen Baum, den es nicht mehr gibt.
  await React.act(async () => {
    surfaces.arrive();
  });
  await settle();

  assert.equal(
    surfaces.built.length,
    0,
    `nach dem Aushängen ist noch ein Terminal entstanden (${surfaces.built.length}) — es hängt in ` +
      "einem Knoten, den React entfernt hat, und niemand räumt es je wieder ab"
  );
  assert.deepEqual(execCalls(server), [], "und es hat dazu noch eine Shell auf dem Arm eröffnet");
  server.restore();
});

// ── 2. Aufräumen beim Aushängen: dispose, Abbruch UND close ─────────────────

test("das Aushängen baut das Terminal ab, bricht den Strom ab und schließt die Sitzung", async () => {
  const { surfaces, server, mounted } = await open();
  await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));

  const surface = surfaces.built[0];
  assert.ok(surface, "der Reiter hat kein Terminal gebaut");
  assert.equal(phase(), "connected");
  const signal = server.signals[0];
  assert.ok(signal, "der Strom ist ohne Abbruchsignal hinausgegangen");
  assert.equal(signal.aborted, false, "das Signal war schon vor dem Aushängen gebrochen");

  const readsBefore = server.body.state.reads;
  await mounted.unmount();
  await settle();

  assert.equal(surface.log.includes("dispose"), true, "das Terminal ist nicht abgebaut worden");
  assert.equal(signal.aborted, true, "der Strom ist nicht abgebrochen worden");
  assert.equal(server.body.state.cancelled, true, "der Leser wurde nicht freigegeben");
  assert.equal(
    server.body.state.reads,
    readsBefore,
    `der Leser hat nach dem Abbruch weitergelesen (${server.body.state.reads} statt ${readsBefore})`
  );

  // ⚠️ DER KERN DIESES FALLES. `close` ist Pflicht und keine Höflichkeit: der
  // Hub bindet die Sitzung an den `close` seiner ANTWORT, und darauf darf sich
  // der Browser nicht verlassen. Eine Sitzung, die niemand schließt, belegt
  // einen von vier Plätzen des ganzen Arms, bis der Agent nach 30 Minuten
  // abriegelt.
  const closes = server.calls.filter((call) => call.url.endsWith("/close"));
  assert.equal(closes.length, 1, `beim Aushängen ist ${closes.length}-mal „close" gerufen worden statt einmal`);
  assert.equal(closes[0].method, "POST");
  assert.equal(
    closes[0].url,
    `/api/hosts/${HOST}/containers/${CONTAINER}/exec/${SESSION}/close`,
    "der Aufruf trägt nicht Arm, Container und Sitzung im Pfad — der Hub hält genau diese drei gegen sein Register"
  );
  server.restore();
});

// ── 3. Durchreichen statt sammeln ───────────────────────────────────────────

test("eine Ausgabe steht im Terminal, bevor die nächste geschickt wird", async () => {
  const { surfaces, server, mounted } = await open();
  try {
    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    const surface = surfaces.built[0];
    assert.ok(surface);

    await send(server, line({ kind: "output", text: "erste" }));
    assert.deepEqual(surface.written, ["erste"], "die erste Ausgabe steht nicht da, bevor die zweite kommt");

    await send(server, line({ kind: "output", text: "zweite" }));
    assert.deepEqual(surface.written, ["erste", "zweite"]);

    // Und der Strom läuft noch: nichts hier hing an seinem Ende.
    assert.equal(phase(), "connected");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein ß auf der Chunk-Grenze kommt als ß im Terminal an", async () => {
  const { surfaces, server, mounted } = await open();
  try {
    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    const surface = surfaces.built[0];
    assert.ok(surface);

    const bytes = ENCODER.encode(line({ kind: "output", text: "Grüße aus dem Container" }));
    // „ß" ist in UTF-8 `C3 9F`. Geschnitten wird ZWISCHEN den beiden Bytes.
    const cut = bytes.indexOf(0x9f);
    assert.ok(cut > 0, "die Probe trägt kein ß mehr");
    assert.equal(bytes[cut - 1], 0xc3, "geschnitten wird nicht mitten im ß");

    await React.act(async () => {
      server.body.push(bytes.slice(0, cut));
    });
    await settle();
    assert.deepEqual(surface.written, [], "die halbe Ausgabe ist schon geschrieben worden");

    await React.act(async () => {
      server.body.push(bytes.slice(cut));
    });
    await settle();
    assert.deepEqual(surface.written, ["Grüße aus dem Container"]);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 4. Die fünf Zustände des Kopfs ──────────────────────────────────────────

test("der Kopf geht von „verbindet“ auf den Containernamen aus der start-Zeile", async () => {
  const { server, mounted } = await open();
  try {
    assert.equal(phase(), "connecting");
    assert.ok(
      [de.shellConnecting, en.shellConnecting].includes(status()),
      `vor der start-Zeile steht: ${JSON.stringify(status())}`
    );

    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    assert.equal(phase(), "connected");
    // ⚠️ Geprüft wird der NAME aus der Zeile und nicht der Satz: die Sprache
    // dieses Laufs hängt am Browser, und beide Fassungen tragen die Angabe.
    assert.ok(
      status().includes("demo-web-1"),
      `der Kopf nennt den Container aus der start-Zeile nicht: ${JSON.stringify(status())}`
    );
    assert.equal(at("shell-reconnect"), null, "die Schaltfläche steht schon da, während der Strom läuft");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ende mit einer Zahl und ende mit null sind ZWEI verschiedene Auskünfte", async () => {
  // ⚠️ DER FALL, DEN EINE FASSUNG MIT EINEM GEMEINSAMEN SATZ BESTÜNDE. Eine
  // Zahl heißt: der Prozess ist von selbst zu Ende gegangen. `null` heißt: der
  // Agent hat abgeriegelt — 30 Minuten Gesamtdauer oder 15 Minuten Leerlauf,
  // und WELCHES von beidem, kann der Hub nicht wissen. Wer beide gleich
  // beschriftet, behauptet eine Auskunft, die niemand hat.
  const first = await open();
  await send(first.server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
  await send(first.server, line({ kind: "end", exitCode: 137 }));
  const withCode = status();
  assert.equal(phase(), "ended");
  assert.ok(withCode.includes("137"), `der Exit-Code steht nicht im Kopf: ${JSON.stringify(withCode)}`);
  assert.ok(at("shell-reconnect"), "nach einem Ende gibt es keinen Weg zurück");
  await first.mounted.unmount();
  first.server.restore();

  const second = await open();
  await send(second.server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
  await send(second.server, line({ kind: "end", exitCode: null }));
  const withoutCode = status();
  assert.equal(phase(), "broken");
  await second.mounted.unmount();
  second.server.restore();

  assert.notEqual(
    withCode,
    withoutCode,
    "beide Ausgänge tragen denselben Satz — dann behauptet der eine eine Auskunft, die es nicht gibt"
  );
  assert.equal(withoutCode.includes("137"), false);
});

test("ein bekannter Grund im Strom bekommt seinen Satz, ein unbekannter den rohen", async () => {
  const known = await open();
  await send(known.server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
  await send(known.server, line({ kind: "error", reason: "permission-revoked" }));
  const shown = status();
  assert.equal(phase(), "broken");
  assert.ok(
    [de.shellFailureRevoked, en.shellFailureRevoked].includes(shown),
    `der Entzug bekommt nicht seinen eigenen Satz: ${JSON.stringify(shown)}`
  );
  await known.mounted.unmount();
  known.server.restore();

  const strange = await open();
  await send(strange.server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
  await send(strange.server, line({ kind: "error", reason: "ein-grund-aus-der-zukunft" }));
  const raw = status();
  await strange.mounted.unmount();
  strange.server.restore();

  // ⚠️ EIN UNBEKANNTER GRUND DARF NICHT IN EINEN LEEREN KOPF MÜNDEN. Der
  // Rückfall zeigt das rohe Wort — das ist mehr als „ein Fehler ist
  // aufgetreten", und der Log-Ansicht ist genau das schon einmal aufgefallen.
  assert.ok(raw.length > 0, "ein unbekannter Grund führt zu einem leeren Kopf");
  assert.ok(
    raw.includes("ein-grund-aus-der-zukunft"),
    `der Rückfall nennt den rohen Grund nicht: ${JSON.stringify(raw)}`
  );
});

// ── 5. Die Ablehnung VOR der ersten Zeile ───────────────────────────────────

test("die zwei 429 des Hubs tragen verschiedene Sätze", async () => {
  // ⚠️ DER FALL, DEN EINE ABBILDUNG NACH DEM STATUS NICHT BESTEHT.
  // `too-many-sessions` ist der Deckel des ARMS — man wartet, bis jemand
  // anderes eine Shell schließt. `own-session-limit` ist der eigene — man
  // schließt seine eigene. Ein gemeinsamer Satz gäbe der Hälfte der Leser den
  // falschen Rat, und beide sind `429`.
  const arm = await open({ status: 429, error: "too-many-sessions" });
  const armText = status();
  assert.equal(phase(), "rejected");
  await arm.mounted.unmount();
  arm.server.restore();

  const own = await open({ status: 429, error: "own-session-limit" });
  const ownText = status();
  assert.equal(phase(), "rejected");
  await own.mounted.unmount();
  own.server.restore();

  assert.ok(
    [de.shellErrorTooManySessions, en.shellErrorTooManySessions].includes(armText),
    `der Deckel des Arms zeigt: ${JSON.stringify(armText)}`
  );
  assert.ok(
    [de.shellErrorOwnSessionLimit, en.shellErrorOwnSessionLimit].includes(ownText),
    `der eigene Deckel zeigt: ${JSON.stringify(ownText)}`
  );
  assert.notEqual(armText, ownText, "beide 429 tragen denselben Satz");
});

test("eine Kennung, die diese Fläche nicht führt, zeigt sie ROH statt gar nichts", async () => {
  const { server, mounted } = await open({ status: 503, error: "eine-kennung-aus-der-zukunft" });
  try {
    assert.equal(phase(), "rejected");
    const shown = status();
    assert.ok(shown.length > 0, "der Kopf bleibt leer");
    assert.ok(
      shown.includes("eine-kennung-aus-der-zukunft"),
      `der Rückfall nennt die rohe Kennung nicht: ${JSON.stringify(shown)}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 6. Ein Lader, der nicht ankommt, sagt es ────────────────────────────────

test("scheitert das Nachladen, steht ein Satz da und kein leerer Kasten", async () => {
  const server = stubHub();
  const load: SurfaceLoader = () => Promise.reject(new Error("kein Netz"));
  const mounted = await mount(load);
  await settle();

  try {
    assert.equal(phase(), "load-failed");
    const alert = at("shell-load-failed");
    assert.ok(alert, "der Reiter sagt nicht, dass das Nachladen gescheitert ist");
    assert.ok((alert.textContent ?? "").length > 0, "die Meldung ist leer");
    assert.ok(document.body.querySelector('[role="alert"]'), "die Meldung ist für den Screenreader keine");
    assert.deepEqual(execCalls(server), [], "ohne Terminal ist trotzdem eine Shell auf dem Arm eröffnet worden");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 7. Die Fläche wächst nicht mit dem Terminal ─────────────────────────────

test("das Terminal hängt ohne Padding in einem Rahmen mit fester Höhe", async () => {
  // ⚠️ DIE LÜCKE DIESES PRÜFSTANDS, benannt statt umgangen: happy-dom rechnet
  // kein Layout, der Fehler selbst ist hier also nicht nachzustellen. Gemessen
  // am 2026-09-29 in Chromium: hing das Terminal direkt im Knoten mit `p-2`,
  // schlug `addon-fit` je `fit()` eine Zeile mehr vor (25 → 26 → … → 32), und
  // weil die Fläche am Inhalt hing, rief der `ResizeObserver` den nächsten —
  // die Shell lief ins Unendliche. Dieser Fall hält die Bauweise, die das
  // ausschließt: kein Padding am Knoten des Terminals, und sein Rahmen hat
  // eine Höhe, die nicht vom Inhalt kommt.
  const { surfaces, server, mounted } = await open();
  try {
    const node = surfaces.built[0]?.node;
    assert.ok(node, "der Reiter hat kein Terminal gebaut");
    assert.ok(
      !/(^|\s)p[xytrbl]?-/.test(node.className),
      `der Knoten des Terminals trägt Padding („${node.className}") — addon-fit zieht es nicht ab`
    );
    const frame = node.parentElement;
    assert.ok(frame, "der Knoten des Terminals hängt in keinem Rahmen");
    assert.ok(
      /(^|\s)h-\[/.test(frame.className) && !/(^|\s)flex-1(\s|$)/.test(frame.className),
      `der Rahmen hat keine feste Höhe („${frame.className}") — er wüchse mit dem Terminal`
    );
    // Gemessen am 2026-09-29 am laufenden Hub: ohne `font-mono` erbte der
    // Knoten IBM Plex Sans, `@xterm` maß die Zelle an einer
    // Proportionalschrift, und zwischen den Buchstaben stand Luft.
    assert.ok(
      /(^|\s)font-mono(\s|$)/.test(node.className),
      `der Knoten des Terminals trägt keine Festbreitenschrift („${node.className}")`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
