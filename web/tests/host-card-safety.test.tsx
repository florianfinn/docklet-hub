// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`). Wer hier
// alphabetisch sortiert, bekommt „document is not defined".
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import type { DockerHost } from "../src/domain/hosts/index.js";
import type { HostStatus } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { HostCard } from "../src/features/hosts/HostCard.js";
import { HostsScreen } from "../src/app/screens/HostsScreen.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Vier Fehler dieser Fläche sind gültiges JSX, gültiges TypeScript und eine
// grüne Prüfkette. Gemessen am 2026-09-06, unmittelbar nachdem der erste echte
// Arm angebunden war — die Karte davor trug alle vier:
//
//   1. DIE ROTATION OHNE RÜCKFRAGE. „Archiv erneut laden" war ein unmittelbares
//      `<a download>` auf `GET /hosts/:id/archive`. Diese Route ist ein GET und
//      ändert trotzdem Zustand: sie würfelt Schlüsselpaar, Agent-Secret und
//      Token neu und sperrt damit den Agenten aus, der auf dem Zielhost GERADE
//      LÄUFT (§4, `enrollment.ts`). Die Warnung stand in einem Tooltip — der
//      erscheint beim Zeigen, ist beim Klicken weg und auf einem
//      Berührungsgerät nie da. Ein Fehlgriff neben „Entfernen" kostete damit
//      einen arbeitenden Arm, ohne dass irgendwo eine Frage gestanden hätte.
//   2. DER KNOPF, DER NUR SCHEITERN KANN. Dieselbe Schaltfläche stand auch auf
//      der Karte des LOKALEN Arms. `buildArchive` wirft dort „host-is-local"
//      (409): der lokale Agent steht im Compose-Stack und nicht im Tunnel, für
//      ihn gibt es kein Archiv. Weil es ein `<a download>` war, lud ein Klick
//      die Fehlermeldung als DATEI herunter, statt sie zu zeigen.
//   3. DIE MESSUNG, DIE NIE WIEDER STATTFAND. Zustand und Zähler entstehen beim
//      Laden aus `probeAgent` und einer Frage an den Agenten. Danach gab es
//      keinen Weg zu neuen Werten außer dem Neuladen der ganzen Anwendung — ein
//      Arm, der beim Anlegen `pending` war und inzwischen läuft, blieb auf
//      `pending` stehen.
//   4. DIE LISTE, DIE BEIM MESSEN VERSCHWINDET. Der bequeme Weg für 3 wäre
//      `setHosts(null)` und „lädt" — dann wäre die Liste bei jedem Klick für
//      die Dauer der langsamsten Agentenantwort weg. Ebenso bliebe eine einmal
//      gezeigte Fehlermeldung für den Rest der Sitzung stehen, wenn die
//      geglückte Messung sie nicht zurücknähme.
//
// Keiner der bestehenden Wächter über Dateitexte sieht das, `tsc` und
// `vite build` auch nicht: alle vier Fassungen übersetzen und bündeln sich.
// Geprüft wird deshalb am gerenderten Baum und an dem, was `fetch` zu sehen
// bekommt.

const ARCHIVE_LINK = 'a[href*="/archive"]';

function hostOf(overrides: Partial<DockerHost> = {}): DockerHost {
  return {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    status: "online" as HostStatus,
    agentVersion: "0.19.1",
    tunnelAddress: "10.254.0.2",
    display: { hue: "neutral", ink: "head" },
    agentUpdate: null,
    lastSeenAt: null,
    ...overrides
  };
}

/** Ein Element mit dieser Kennung, IRGENDWO im Dokument — der Dialog reist
 *  durch ein Portal an `document.body` und steht nicht im Container. */
function find(testId: string): HTMLElement {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element instanceof HTMLElement, `„${testId}" steht nicht im Dokument`);
  return element;
}

/**
 * Ob dieser Wähler im Dokument NICHTS trifft — als Wahrheitswert.
 *
 * ⚠️ ES GIBT KEIN ELEMENT ZURÜCK, und das ist der Sinn dieser Hilfe. Der erste
 * Entwurf schrieb `assert.equal(document.body.querySelector(sel), null)`. Im
 * grünen Fall geht das durch; im ROTEN — also genau dann, wenn der Fall etwas
 * zu sagen hätte — reicht `assert` das gefundene Element an seine
 * Fehlerausgabe weiter und versucht, es abzubilden. Unter happy-dom hängt an
 * jedem Element der halbe Fensterbaum mit Zyklen: gemessen am 2026-09-06 in
 * zwei Mutationsproben endete der Lauf nach 71 und 82 Sekunden mit
 * `RangeError: Array buffer allocation failed` — statt mit dem Satz, der
 * danebensteht. Ein Wächter, der im Fehlerfall den Läufer umbringt, ist keiner.
 * Verglichen wird deshalb ein `boolean`.
 */
function nothingAt(selector: string): boolean {
  return document.body.querySelector(selector) === null;
}

/**
 * Ein Klick, der zurückkehrt, wenn React fertig ist.
 *
 * ⚠️ `element.click()` steht IN `act(…)` und nicht davor — sonst warnt React
 * bei jedem Klick, der einen Zustand setzt, auf stderr.
 */
async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

// ---------------------------------------------------------------------------
// Teil 1 — die Rotation gehört hinter eine Rückfrage
// ---------------------------------------------------------------------------

test("der Auslöser ist ein Knopf und KEIN Link auf die Archivroute", async () => {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCard host={hostOf()} role="admin" counters={{ state: "loading" }} onRemoved={() => {}} onAgentUpdated={() => {}} />
    </AppLanguageProvider>
  );

  try {
    const trigger = find("archive-reload-host-1");
    // ⚠️ DIE EIGENTLICHE ZUSAGE DIESER DATEI. Wer den Auslöser wieder zu einem
    // `<a download>` macht, hat den Dialog nicht entschärft, sondern zur Zierde
    // gemacht: die Rotation liefe beim ERSTEN Klick, und die Rückfrage öffnete
    // sich hinterher über einem Arm, der schon ausgesperrt ist. Von außen sähe
    // beides gleich aus — derselbe Knopf, derselbe Text, derselbe Dialog.
    assert.equal(trigger.tagName, "BUTTON", "der Auslöser der Rotation ist ein Knopf");
    assert.ok(nothingAt(ARCHIVE_LINK), "vor der Rückfrage steht nirgends ein Link auf die Archivroute");
  } finally {
    await mounted.unmount();
  }
});

test("erst hinter der Rückfrage steht der Download — und der ist ein `a download`", async () => {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCard host={hostOf()} role="admin" counters={{ state: "loading" }} onRemoved={() => {}} onAgentUpdated={() => {}} />
    </AppLanguageProvider>
  );

  try {
    await click(find("archive-reload-host-1"));

    const confirm = find("archive-reload-confirm-host-1");
    // ⚠️ Ein `a download` und ausdrücklich kein `fetch` + Blob: das verlöre den
    // Dateinamen aus `Content-Disposition` und in manchen Browsern die Sitzung.
    // Wer den Bestätigen-Knopf auf einen Aufruf umbaut, bekommt ein Archiv ohne
    // Namen — oder gar keins, weil die Route dann unangemeldet aufgerufen wird.
    assert.equal(confirm.tagName, "A", "bestätigt wird über einen echten Download-Link");
    assert.ok(confirm.hasAttribute("download"), "der Link trägt `download`");
    assert.equal(confirm.getAttribute("href"), "/api/hosts/host-1/archive");
  } finally {
    await mounted.unmount();
  }
});

test("der lokale Arm bekommt gar keinen Archiv-Griff", async () => {
  const local = hostOf({ id: "host-local", name: "local", kind: "local", tunnelAddress: null });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCard host={local} role="admin" counters={{ state: "loading" }} onRemoved={() => {}} onAgentUpdated={() => {}} />
    </AppLanguageProvider>
  );

  try {
    // Weder Auslöser noch Link: für `kind = "local"` antwortet die Route mit
    // 409 („host-is-local"), der Griff könnte also nie etwas anderes tun als
    // eine Fehlermeldung als Datei abzulegen.
    assert.ok(nothingAt('[data-testid="archive-reload-host-local"]'), "kein Auslöser");
    assert.ok(nothingAt(ARCHIVE_LINK), "kein Link auf die Archivroute");
  } finally {
    await mounted.unmount();
  }
});

// ---------------------------------------------------------------------------
// Teil 2 — erneut messen, ohne die Liste zu verlieren
// ---------------------------------------------------------------------------

type Pending = { resolve: () => void };

/**
 * Ein Hub, dessen Antworten der Test einzeln freigibt.
 *
 * `hostsCalls` zählt die Aufrufe von `GET /api/hosts`; `gate` hält die NÄCHSTE
 * dieser Antworten fest, bis der Test sie durchlässt. Ohne das Tor ließe sich
 * „während der Messung" nicht beobachten — die Antwort käme im selben Zug wie
 * der Klick, und ein Test auf den Zwischenstand wäre grün, ohne ihn je gesehen
 * zu haben.
 */
function stubHub(options: { hosts: DockerHost[]; failFirst?: boolean }): {
  hostsCalls: () => number;
  hold: () => void;
  release: () => Promise<void>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let calls = 0;
  let holding = false;
  let pending: Pending | null = null;

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/containers")) {
      // `load: null` seit #214: die Route sendet das Feld immer, und ohne
      // bekannte Ausstattung des Arms ist es `null`.
      // The complete wire shape: the card parses this response against the
      // contract since #248.
      const host = options.hosts.find((entry) => url.includes(`/hosts/${entry.id}/`)) ?? options.hosts[0];
      return Promise.resolve(
        json({
          host,
          agent: { reachable: true, version: null, contractVersion: null, readOnly: null, entries: null },
          containers: [],
          load: null,
          error: null
        })
      );
    }

    calls += 1;
    const failing = options.failFirst === true && calls === 1;
    const answer = () => (failing ? json({ error: "boom" }, 500) : json({ hosts: options.hosts }));

    if (!holding) return Promise.resolve(answer());
    return new Promise<Response>((resolve) => {
      pending = { resolve: () => resolve(answer()) };
    });
  }) as typeof fetch;

  return {
    hostsCalls: () => calls,
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      pending?.resolve();
      pending = null;
      await settle();
    },
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

test("„Erneut prüfen“ misst wirklich neu", async () => {
  const server = stubHub({ hosts: [hostOf()] });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostsScreen role="admin" />
    </AppLanguageProvider>
  );

  try {
    await settle();
    assert.equal(server.hostsCalls(), 1, "der Bildschirm misst beim Aufbau einmal");

    await click(find("hosts-refresh"));
    // Ohne diese Zusage wäre ein Knopf, der nur `busy` setzt und wieder
    // zurücknimmt, vollständig grün — er sähe aus wie eine Messung und wäre
    // keine.
    assert.equal(server.hostsCalls(), 2, "der Klick fragt den Hub ein zweites Mal");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("die Liste bleibt während der Messung stehen", async () => {
  const server = stubHub({ hosts: [hostOf()] });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostsScreen role="admin" />
    </AppLanguageProvider>
  );

  try {
    await settle();
    assert.ok(find("archive-reload-host-1"), "die Karte steht nach dem Aufbau da");

    // The counter requests of the card may still be in flight after the first
    // settle. While anything is fetching the button is disabled and a click on
    // it does nothing, so the measurement below would never start.
    for (let round = 0; round < 20 && find("hosts-refresh").hasAttribute("disabled"); round += 1) {
      await settle();
    }

    server.hold();
    await click(find("hosts-refresh"));

    // ⚠️ HIER läuft die Messung noch. Ein `setHosts(null)` zu Beginn wäre der
    // bequeme Weg — und die Liste verschwände bei jedem Klick für die Dauer der
    // langsamsten Agentenantwort, bei einem Arm im Zeitüberlauf mehrere
    // Sekunden lang.
    assert.ok(
      document.body.querySelector('[data-testid="archive-reload-host-1"]'),
      "die Karte steht auch WÄHREND der Messung noch da"
    );
    assert.ok(find("hosts-refresh").hasAttribute("disabled"), "der Knopf ist währenddessen gesperrt");

    await server.release();
    assert.ok(find("archive-reload-host-1"), "und danach immer noch");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine geglückte Messung nimmt die Fehlermeldung zurück", async () => {
  const server = stubHub({ hosts: [hostOf()], failFirst: true });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostsScreen role="admin" />
    </AppLanguageProvider>
  );

  try {
    await settle();
    // ⚠️ Auf die MELDUNG gezielt und nicht auf ihre Farbe. Der erste Entwurf
    // zählte `.text-destructive` — und traf damit auch den „Entfernen"-Knopf
    // der Karte, die nach der geglückten Messung wieder dasteht. Der Fall war
    // rot gegen eine richtige Oberfläche.
    const ALERT = '[data-testid="hosts-failed"]';
    assert.ok(!nothingAt(ALERT), "der fehlgeschlagene Aufbau meldet sich");

    await click(find("hosts-refresh"));
    await settle();

    // Ohne `setFailed(false)` im Erfolgsfall stünde die rote Zeile für den Rest
    // der Sitzung über einer Liste, die längst wieder stimmt.
    assert.ok(nothingAt(ALERT), "die geglückte Messung nimmt die Meldung weg");
    assert.ok(find("archive-reload-host-1"), "und die Liste steht da");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
