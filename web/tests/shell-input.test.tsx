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
  pipe,
  send,
  SESSION,
  sizeLab
} from "./shell-harness.js";
import { settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { base64OfText } from "../src/features/shell/api.js";
import { de, en } from "../src/app/i18n/messages.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Was aus dem Reiter „Shell" HINAUSGEHT (Paket B6, Etappe E6, #5): die
// Tastenanschläge, die Fenstergröße, die Zahl der Verbindungsversuche und die
// Sitzungs-Id. Was hereinkommt, steht in `shell-view.test.tsx`; der Prüfstand
// ist beiden gemeinsam und steht in `shell-harness.tsx`.
//
// Vier stille Fehler, jeder mit eigenem Fall:
//
//   1. DIE KODIERUNG. Ein Terminal überträgt BYTES und keinen Text. Eine
//      falsche Kodierung wird mit `200` quittiert, und im Container steht
//      Zeichensalat — bei einem `ls` fällt es nicht einmal auf.
//   2. DIE GRÖSSE BEI JEDEM BILDAUFBAU. Ohne Vergleich gegen die zuletzt
//      gemeldete ginge bei jedem Ziehen am Fenster eine Anfrage an den Arm,
//      und jede schriebe dort einen Audit-Eintrag.
//   3. DER AUTO-RECONNECT. Er sieht auf jedem Bild aus wie ein Reiter, der
//      gerade verbindet, und belegt dabei die vier Sitzungsplätze des Arms.
//   4. DIE SITZUNGS-ID IM BILD. Sie ist ein Schlüssel und keine Auskunft.

// ── 7. Die Eingabe: Bytes, nicht Zeichen ────────────────────────────────────

// ⚠️ DER GEFÄHRLICHSTE FALL DES GANZEN PAKETS, und er hat kein Bild. Ein
// Terminal überträgt beliebige BYTES: Strg-C ist das Byte 3, ein „ß" sind
// ZWEI Bytes. Wer den rohen String von `onData` als base64 ausgibt, bekommt
// eine Antwort `200`, der Agent nimmt die Bytes an, und im Container steht
// Zeichensalat — bei einem `ls` fällt es nicht einmal auf.
//
// Deshalb steht hier ein LITERAL und keine zweite Rechnung: eine Erwartung,
// die denselben Weg noch einmal rechnet, ist mit dem Fehler einverstanden.
//
// Die Probe ist „ß" (C3 9F) gefolgt vom Steuerzeichen 3. Drei Bytes,
// C3 9F 03, ergeben in base64 genau vier Zeichen.
const ESZETT_AND_CONTROL = `ß${String.fromCharCode(3)}`;
const ESZETT_AND_CONTROL_BASE64 = "w58D";

test("ein ß und ein Steuerzeichen gehen als die richtigen BYTES hinaus", () => {
  assert.equal(
    base64OfText(ESZETT_AND_CONTROL),
    ESZETT_AND_CONTROL_BASE64,
    "die Eingabe wird nicht über ihre Bytes kodiert — im Container stünde Zeichensalat, und der Hub " +
      "antwortete trotzdem 200"
  );
  // Die Gegenprobe, dass die Probe überhaupt etwas Schwieriges enthält: ein
  // reines ASCII-Zeichen käme auch bei der falschen Bauart richtig an.
  assert.equal(ESZETT_AND_CONTROL.length, 2, "die Probe trägt nicht mehr zwei Zeichen");
  assert.equal(new TextEncoder().encode(ESZETT_AND_CONTROL).length, 3, "die zwei Zeichen sind nicht drei Bytes");
});

test("ein Tastenanschlag geht base64-kodiert an die input-Route", async () => {
  const { surfaces, server, mounted } = await open();
  try {
    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    const surface = surfaces.built[0];
    assert.ok(surface);

    await React.act(async () => {
      surface.type(ESZETT_AND_CONTROL);
    });
    await settle();

    const inputs = server.calls.filter((call) => call.url.endsWith("/input"));
    assert.equal(inputs.length, 1, `es sind ${inputs.length} Eingaben hinausgegangen statt einer`);
    assert.equal(inputs[0].method, "POST");
    assert.equal(
      inputs[0].url,
      `/api/hosts/${HOST}/containers/${CONTAINER}/exec/${SESSION}/input`,
      "der Aufruf trägt nicht Arm, Container und Sitzung im Pfad"
    );
    // ⚠️ GEGEN DAS LITERAL und nicht gegen `base64OfText(...)`: eine Erwartung,
    // die denselben Weg noch einmal rechnet, ist mit jedem Fehler darin
    // einverstanden.
    assert.equal(
      inputs[0].body,
      JSON.stringify({ data: ESZETT_AND_CONTROL_BASE64 }),
      `hinausgegangen ist: ${String(inputs[0].body)}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("vor der start-Zeile geht KEINE Eingabe hinaus", async () => {
  // ⚠️ Bis zur Kopplung kennt das Register des Hubs die Sitzung nicht und
  // antwortete `404 session-unknown` — auf einen Tastendruck, den der Mensch
  // für angekommen hält. Und die Sitzungs-Id gäbe es an dieser Stelle gar
  // nicht: der Pfad trüge ein `undefined`.
  const { surfaces, server, mounted } = await open();
  try {
    const surface = surfaces.built[0];
    assert.ok(surface);
    assert.equal(phase(), "connecting");

    await React.act(async () => {
      surface.type("x");
    });
    await settle();

    assert.deepEqual(
      server.calls.filter((call) => call.url.includes("/input")),
      [],
      "vor der start-Zeile ist eine Eingabe hinausgegangen"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine abgelehnte Eingabe wird gemeldet und beendet die Sitzung nicht", async () => {
  // ⚠️ Eine Eingabe, die hinausgeht und nichts tut, ist der Fehler, den
  // niemand findet: der Betreiber tippt, es passiert nichts, und keine Zeile
  // sagt warum.
  const surfaces = lab();
  const original = globalThis.fetch;
  const body = pipe();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/input")) {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "agent-read-only", message: "Attrappe" })
      } as unknown as Response);
    }
    const signal = init?.signal;
    signal?.addEventListener("abort", () => body.fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => body.reader } } as unknown as Response);
  }) as typeof fetch;

  const mounted = await mount(surfaces.load);
  await React.act(async () => {
    surfaces.arrive();
  });
  await settle();
  await React.act(async () => {
    body.push(ENCODER.encode(line({ kind: "start", session: SESSION, containerName: "demo-web-1" })));
  });
  await settle();

  try {
    const surface = surfaces.built[0];
    assert.ok(surface);
    await React.act(async () => {
      surface.type("x");
    });
    await settle();

    const alert = at("shell-send-error");
    assert.ok(alert, "die abgelehnte Eingabe wird gar nicht gemeldet");
    assert.ok(
      [de.shellErrorAgentReadOnly, en.shellErrorAgentReadOnly].includes(alert.textContent ?? ""),
      `gemeldet wurde: ${JSON.stringify(alert.textContent)}`
    );
    // Der Strom läuft weiter: der Kill-Switch beendet die Sitzung beim Arm,
    // aber das erfährt diese Fläche über den Strom und nicht über die Antwort
    // auf einen Tastendruck.
    assert.equal(phase(), "connected", "eine abgelehnte Eingabe hat den Kopf auf ein Ende gestellt");
  } finally {
    await mounted.unmount();
    globalThis.fetch = original;
  }
});

// ── 8. Die Größe ────────────────────────────────────────────────────────────

test("die Startgröße steht im Rumpf der Eröffnung", async () => {
  const { server, mounted } = await open();
  try {
    const [call] = execCalls(server);
    assert.ok(call, "der Strom ist nie eröffnet worden");
    assert.equal(call.method, "POST");
    assert.equal(
      call.body,
      JSON.stringify({ cols: 100, rows: 30 }),
      `im Rumpf der Eröffnung steht: ${String(call.body)}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine geänderte Fläche meldet ihre neue Größe — und dieselbe kein zweites Mal", async () => {
  const sizes = sizeLab();
  const { surfaces, server, mounted } = await open({ observeSize: sizes.observeSize });
  try {
    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    const surface = surfaces.built[0];
    assert.ok(surface);

    const sizeCalls = () => server.calls.filter((call) => call.url.endsWith("/size"));
    assert.deepEqual(sizeCalls(), [], "die unveränderte Größe ist gemeldet worden");

    // Die Seitenleiste klappt zu: die Fläche wird breiter.
    surface.measured.cols = 120;
    await React.act(async () => {
      sizes.change();
    });
    await settle();

    assert.equal(sizeCalls().length, 1, `es sind ${sizeCalls().length} Größen gemeldet worden statt einer`);
    assert.equal(
      sizeCalls()[0].url,
      `/api/hosts/${HOST}/containers/${CONTAINER}/exec/${SESSION}/size`,
      "der Aufruf trägt nicht Arm, Container und Sitzung im Pfad"
    );
    assert.equal(sizeCalls()[0].body, JSON.stringify({ cols: 120, rows: 30 }));

    // ⚠️ DER ZWEITE TEIL IST DER WICHTIGERE. Ein `ResizeObserver` feuert bei
    // jedem Bildaufbau; ohne den Vergleich gegen die zuletzt gemeldete Größe
    // ginge bei jedem Ziehen am Fenster eine Anfrage an den Arm — und jede
    // schriebe dort einen Audit-Eintrag unter dem Namen des Betreibers.
    await React.act(async () => {
      sizes.change();
      sizes.change();
    });
    await settle();
    assert.equal(sizeCalls().length, 1, "dieselbe Größe ist ein zweites Mal gemeldet worden");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ohne Sitzung wird keine Größe gemeldet", async () => {
  const sizes = sizeLab();
  const { surfaces, server, mounted } = await open({ observeSize: sizes.observeSize });
  try {
    const surface = surfaces.built[0];
    assert.ok(surface);
    // Noch keine `start`-Zeile: es gibt keine Sitzungs-Id, und der Pfad trüge
    // ein `undefined`.
    surface.measured.cols = 120;
    await React.act(async () => {
      sizes.change();
    });
    await settle();
    assert.deepEqual(
      server.calls.filter((call) => call.url.includes("/size")),
      [],
      "ohne Sitzung ist eine Größe hinausgegangen"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 9. Kein Auto-Reconnect ──────────────────────────────────────────────────

test("nach einem ende stellt der Reiter KEINE neue Anfrage, bis ein Mensch drückt", async () => {
  // ⚠️ GEZÄHLT UND NICHT ANGESEHEN. Eine Wiederverbindungsschleife sieht auf
  // jedem Bild aus wie ein Reiter, der gerade verbindet — und belegt dabei die
  // VIER Sitzungsplätze des Arms, schreibt bei jedem Versuch einen
  // Audit-Eintrag unter dem Namen eines Menschen, der nicht am Rechner sitzt,
  // und öffnet eine Shell erneut, deren Recht gerade entzogen wurde.
  const { surfaces, server, mounted } = await open();
  try {
    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    assert.equal(execCalls(server).length, 1, "der Strom ist nicht genau einmal eröffnet worden");

    await send(server, line({ kind: "end", exitCode: 0 }));
    assert.equal(phase(), "ended");

    // Zeit vergehen lassen — mehrfach, damit eine Schleife mit kurzem Takt
    // auffiele.
    for (let round = 0; round < 5; round += 1) await settle();

    assert.equal(
      execCalls(server).length,
      1,
      `nach dem Ende sind ${execCalls(server).length} Ströme eröffnet worden statt einem — der Reiter ` +
        "verbindet sich von selbst neu"
    );

    // Und jetzt drückt ein Mensch.
    const button = at("shell-reconnect");
    assert.ok(button, "es gibt keine Schaltfläche, mit der ein Mensch neu verbinden könnte");
    await React.act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    // Der Klick fängt den Effekt von vorn an, also auch das Nachladen. Der
    // Lader dieses Prüfstands löst erst auf, wenn der Test es sagt.
    await React.act(async () => {
      surfaces.arrive();
    });
    await settle();

    assert.equal(
      execCalls(server).length,
      2,
      "der Klick eröffnet keinen neuen Strom — dann führt aus dem Ende gar kein Weg heraus"
    );
    assert.equal(phase(), "connecting", "nach dem Klick steht der Kopf nicht wieder auf „verbindet“");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("auch nach einer Ablehnung und nach einem Abriss bleibt es bei einem Versuch", async () => {
  const rejected = await open({ status: 503, error: "agent-read-only" });
  for (let round = 0; round < 5; round += 1) await settle();
  assert.equal(
    execCalls(rejected.server).length,
    1,
    "nach einer Ablehnung versucht der Reiter es von selbst noch einmal"
  );
  await rejected.mounted.unmount();
  rejected.server.restore();

  const broken = await open();
  await send(broken.server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
  await send(broken.server, line({ kind: "error", reason: "permission-revoked" }));
  for (let round = 0; round < 5; round += 1) await settle();
  assert.equal(
    execCalls(broken.server).length,
    1,
    "nach einem Entzug versucht der Reiter es von selbst noch einmal — genau der Fall, in dem das " +
      "am teuersten ist"
  );
  await broken.mounted.unmount();
  broken.server.restore();
});

// ── 10. Die Sitzungs-Id steht in nichts, was der Browser zeigt ──────────────

test("die Sitzungs-Id taucht in nichts auf, was der Browser zeigt", async () => {
  // ⚠️ ES IST DIE ID DES HUBS UND NICHT DIE DES AGENTEN — die verlässt den
  // Server nie (`exec-sessions.ts`, `clientViewOf`). Auch die des Hubs ist
  // aber ein SCHLÜSSEL und keine Auskunft: wer sie in ein `data-`-Merkmal, in
  // eine Überschrift oder in eine Fehlermeldung schreibt, legt sie in jeden
  // Screenshot und in jede Bildschirmfreigabe. Sie gehört in den Pfad der
  // Anfrage und sonst nirgendwohin.
  const { surfaces, server, mounted } = await open();
  try {
    await send(server, line({ kind: "start", session: SESSION, containerName: "demo-web-1" }));
    assert.equal(phase(), "connected");

    const view = at("shell-view");
    assert.ok(view, "der Reiter ist gar nicht da");

    assert.equal(
      (view.textContent ?? "").includes(SESSION),
      false,
      "die Sitzungs-Id steht im sichtbaren Text des Reiters"
    );
    // ⚠️ AUCH DIE MERKMALE, und nicht nur der Text. Ein `data-session` wäre im
    // Bild unsichtbar, im DOM aber für jeden lesbar, der die Entwicklerwerkzeuge
    // öffnet — und in jedem Fehlerbericht, den ein Werkzeug mitschneidet.
    assert.equal(
      view.outerHTML.includes(SESSION),
      false,
      "die Sitzungs-Id steht in einem Merkmal des Reiters"
    );

    // Und die Gegenprobe, dass die Sitzung überhaupt eine ist: sie steht im
    // Pfad der Anfragen. Ohne sie prüfte dieser Fall eine Abwesenheit, die es
    // ohnehin gäbe.
    const surface = surfaces.built[0];
    assert.ok(surface);
    await React.act(async () => {
      // Ein Tastenanschlag, damit ein Pfad mit Sitzung entsteht.
      surface.type("x");
    });
    await settle();
    assert.ok(
      server.calls.some((call) => call.url.includes(SESSION)),
      "die Sitzungs-Id steht in keinem Pfad — dann sagt dieser Fall über sie gar nichts"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
