// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { de, en } from "../src/app/i18n/messages.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { LogView } from "../src/features/logs/LogView.js";
import { HELD_LINE_CAP } from "../src/features/logs/log-stream.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Log-Ansicht (#5, Etappe H2) hängt an einem laufenden Strom, und an einem
// Strom ist genau das still falsch, was ein Test mit drei fertigen Zeilen nicht
// sieht. Acht Fälle, jeder gegen einen anderen dieser stillen Fehler:
//
//   1. DURCHREICHEN STATT SAMMELN. Eine Fassung, die den Rumpf erst
//      vollständig liest und dann alles auf einmal zeigt, bestünde JEDEN Test,
//      der nur das Endergebnis prüft. Der Fall unten schaut deshalb hin,
//      SOLANGE der Strom noch offen ist, und speist die zweite Zeile erst ein,
//      nachdem die erste angekommen ist.
//   2. EIN CHUNK IST KEINE ZEILE. Die Bytes kommen in beliebigem Schnitt.
//   3. EIN ZEICHEN IST KEIN BYTE. Ein „ß" sind zwei, und die Chunk-Grenze
//      läuft nicht an Zeichengrenzen.
//   4. FÜNF FEHLER SIND NICHT EINER. Der 429 ist die Zahl der offenen Ströme
//      und keine Störung; sein Text muss das sagen.
//   5. DER ABBRUCH. Ohne ihn belegt ein geschlossener Reiter weiter einen der
//      acht Plätze des Arms.
//   6. DER DECKEL. Ohne ihn wächst der Reiter, bis der Browser steht.
//   7. A FAILURE IN THE STREAM IS NO RAW SENTENCE. `failureReason` comes from
//      the agent and stays its word
//      (`server/src/features/logs/agent-client.ts`); the view maps only the
//      KNOWN reasons to a text of its own (`FAILURE_KEY_BY_REASON` in
//      `log-errors.ts`) and lets an unknown reason through the existing
//      fallback sentence. And: lines already read stay when a failure
//      arrives afterwards.
//   8. AUS DEM FEHLER FÜHRT EIN WEG ZURÜCK (#126) — und zwar genau einer:
//      eine Schaltfläche, die ein Mensch drückt. Am Augenschein wäre keine
//      der beiden Hälften zu sehen: dass der Klick WIRKLICH einen zweiten
//      Strom eröffnet (gezählt an `fetch`), und dass die Fläche das NICHT von
//      selbst tut (dieselbe Zählung, nachdem Zeit vergangen ist). Eine
//      Schleife dort sperrte die acht Plätze des Arms für alle.
//
// ⚠️ WARUM DER RUMPF HIER VON HAND GEBAUT IST und nicht als echte `Response`
// mit `ReadableStream`: dieser Lauf steht unter happy-dom, und ob dessen
// `Response` einen Strom durchreicht, wäre eine Zusage der Attrappe und nicht
// dieses Bauteils. Der handgebaute Leser gibt dafür zwei Dinge her, die ein
// echter Strom verschweigt — wie oft gelesen wurde (`reads`) und ob der Leser
// freigegeben wurde (`cancelled`). Fall 5 lebt von genau diesen beiden.

const ENCODER = new TextEncoder();

function envelope(text: string, stream: "stdout" | "stderr" = "stdout", ts = "2026-09-07T10:00:00.000Z"): string {
  return `${JSON.stringify({ kind: "line", stream, ts, text })}\n`;
}

/** Der Umschlag, mit dem der Agent einen Fehler IM Strom meldet. */
function failureEnvelope(reason: string): string {
  return `${JSON.stringify({ kind: "error", reason })}\n`;
}

type Pipe = {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
  fail: (error: unknown) => void;
  state: { reads: number; cancelled: boolean };
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> };
};

/** Ein Rumpf, in den der Test Byte für Byte einspeist — wann er will. */
function pipe(): Pipe {
  const queue: Uint8Array[] = [];
  const state = { reads: 0, cancelled: false };
  let waiting: { resolve: (value: { done: boolean; value?: Uint8Array }) => void; reject: (error: unknown) => void } | null =
    null;
  let closed = false;
  let failure: unknown = null;

  return {
    state,
    push: (chunk) => {
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.resolve({ done: false, value: chunk });
        return;
      }
      queue.push(chunk);
    },
    finish: () => {
      closed = true;
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.resolve({ done: true });
      }
    },
    fail: (error) => {
      failure = error;
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.reject(error);
      }
    },
    reader: {
      read: () => {
        state.reads += 1;
        if (failure !== null) return Promise.reject(failure);
        const chunk = queue.shift();
        if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
        if (closed) return Promise.resolve({ done: true });
        return new Promise((resolve, reject) => {
          waiting = { resolve, reject };
        });
      },
      cancel: () => {
        state.cancelled = true;
        return Promise.resolve();
      }
    }
  };
}

type Hub = {
  /** Der Rumpf des ZULETZT eröffneten Stroms — der, in den ein Test einspeist. */
  readonly body: Pipe;
  urls: string[];
  signals: AbortSignal[];
  restore: () => void;
};

/**
 * Der Hub als Attrappe.
 *
 * `status` ist der Code VOR der ersten Zeile — der einzige Zeitpunkt, an dem
 * es überhaupt noch einen geben kann. Ab `200` gehört der Rumpf dem Leser.
 */
function stubHub(status = 200): Hub {
  const original = globalThis.fetch;
  // ⚠️ JE STROM EIN EIGENER RUMPF, und das ist kein Aufwand ohne Grund
  // (derselbe Grund wie in `shell-harness.tsx`). Der Abbruch des ERSTEN Stroms
  // lässt seinen Rumpf abreissen; ein geteilter Rumpf trüge diesen Abriss
  // danach für immer, und der zweite Strom — der nach einem Klick auf „neu
  // verbinden" (Fall 8) — endete sofort, ohne dass die Fläche etwas falsch
  // gemacht hätte. Der Fall prüfte dann eine Attrappe.
  const bodies: Pipe[] = [pipe()];
  const urls: string[] = [];
  const signals: AbortSignal[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    // Der erste Strom bekommt den Rumpf, der schon steht; jeder weitere einen
    // frischen.
    const body = signals.length === 0 ? bodies[0] : (bodies[bodies.length] = pipe());
    const signal = init?.signal;
    if (signal) {
      signals.push(signal);
      // Ein echter Rumpf reisst beim Abbruch ab. Ohne das bliebe der Leser in
      // seinem `read()` hängen, und Fall 5 prüfte einen Zustand, den es im
      // Browser nicht gibt.
      signal.addEventListener("abort", () => body.fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }
    if (status !== 200) {
      return Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve({ error: "stub" })
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => body.reader }
    } as unknown as Response);
  }) as typeof fetch;

  return {
    get body() {
      return bodies[bodies.length - 1];
    },
    urls,
    signals,
    restore: () => (globalThis.fetch = original)
  };
}

async function mount(status = 200) {
  const server = stubHub(status);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <LogView hostId="host-1" containerId="container-1" />
    </AppLanguageProvider>
  );
  // Der erste Durchlauf hängt an einer Zusage: ohne ihn steht der Strom noch
  // gar nicht.
  await settle();
  return { server, mounted };
}

/** Einspeisen und React die Runde machen lassen. */
async function send(server: Hub, text: string): Promise<void> {
  await React.act(async () => {
    server.body.push(ENCODER.encode(text));
  });
  await settle();
}

function shownLines(): string[] {
  return [...document.body.querySelectorAll('[data-testid="log-line-text"]')].map((node) => node.textContent ?? "");
}

function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

// ── 1. Durchreichen statt sammeln ───────────────────────────────────────────

test("eine Zeile steht in der Ansicht, bevor die nächste geschickt wird", async () => {
  // ⚠️ DER EIGENTLICHE NACHWEIS DIESER BAUART. Der Strom wird hier NIE
  // geschlossen: eine Fassung, die erst am Ende ausliefert, käme aus dem
  // Wartezustand nicht heraus und zeigte gar nichts. Geprüft wird deshalb
  // mitten im laufenden Strom.
  const { server, mounted } = await mount();
  try {
    await send(server, envelope("erste"));
    assert.deepEqual(shownLines(), ["erste"], "die erste Zeile steht nicht da, bevor die zweite kommt");

    await send(server, envelope("zweite"));
    assert.deepEqual(shownLines(), ["erste", "zweite"]);

    // Und der Strom läuft noch: nichts hier hing an seinem Ende.
    assert.equal(at("log-view")?.getAttribute("data-phase"), "open");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 2. Ein Chunk ist keine Zeile ────────────────────────────────────────────

test("EIN Umschlag in ZWEI Chunks ergibt GENAU EINE vollständige Zeile", async () => {
  const { server, mounted } = await mount();
  try {
    const raw = envelope("eine Zeile über zwei Chunks");
    const cut = Math.floor(raw.length / 2);

    await send(server, raw.slice(0, cut));
    // Die halbe Zeile darf NICHTS ergeben — weder eine kaputte Zeile noch
    // einen Fehler. Sie wartet auf ihre zweite Hälfte.
    assert.deepEqual(shownLines(), [], "die halbe Zeile ist schon angezeigt worden");

    await send(server, raw.slice(cut));
    assert.deepEqual(shownLines(), ["eine Zeile über zwei Chunks"]);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 3. Ein Zeichen ist kein Byte ────────────────────────────────────────────

test("ein ß mitten auf der Chunk-Grenze bleibt ein ß", async () => {
  // ⚠️ Der Fall, den ein `TextDecoder` je Chunk verlöre — und zwar dauerhaft:
  // die zweite Hälfte des Zeichens kommt zwar an, hätte aber niemanden mehr,
  // zu dem sie gehört.
  const { server, mounted } = await mount();
  try {
    const bytes = ENCODER.encode(envelope("Grüße aus dem Container"));
    // „ß" ist in UTF-8 `C3 9F`. Geschnitten wird ZWISCHEN den beiden Bytes.
    const cut = bytes.indexOf(0x9f);
    assert.ok(cut > 0, "die Probe trägt kein ß mehr");
    assert.equal(bytes[cut - 1], 0xc3, "geschnitten wird nicht mitten im ß");

    await React.act(async () => {
      server.body.push(bytes.slice(0, cut));
    });
    await settle();
    await React.act(async () => {
      server.body.push(bytes.slice(cut));
    });
    await settle();

    assert.deepEqual(shownLines(), ["Grüße aus dem Container"]);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 4. Fünf Fehler sind nicht einer ─────────────────────────────────────────

test("ein 409 nennt den zu alten Agenten statt eines leeren Logs", async () => {
  // An arm below the current contract: the hub refuses the stream with
  // `409 agent-outdated` (`server/src/features/logs/service.ts`) instead of
  // relaying lines the reader would drop.
  const { server, mounted } = await mount(409);
  try {
    const shown = at("log-error")?.textContent ?? "";
    assert.ok(
      [de.logErrorAgentOutdated, en.logErrorAgentOutdated].includes(shown),
      `gezeigt wurde: ${JSON.stringify(shown)}`
    );
    assert.equal(at("log-view")?.getAttribute("data-phase"), "failed");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein 429 zeigt seinen eigenen Text und nicht den allgemeinen", async () => {
  // ⚠️ Geprüft wird gegen die Sprachdateien und nicht gegen einen abgetippten
  // Satz: die Sprache dieses Laufs hängt am Browser, und ein Wächter, der
  // deutschen Text erwartet, wäre auf Englisch rot gegen eine richtige
  // Oberfläche. Beide Fassungen des RICHTIGEN Schlüssels gelten, beide
  // Fassungen des allgemeinen sind ausgeschlossen.
  const { server, mounted } = await mount(429);
  try {
    const alert = at("log-error");
    assert.ok(alert, "die Ansicht meldet den 429 gar nicht");
    const shown = alert.textContent ?? "";

    assert.ok(
      [de.logErrorTooManyStreams, en.logErrorTooManyStreams].includes(shown),
      `gezeigt wurde: ${JSON.stringify(shown)}`
    );
    // Der Fall, der ohne die Tabelle grün wäre: ein einziger Sammeltext für
    // alle fünf Statuscodes.
    assert.ok(
      ![de.logErrorUnknown, en.logErrorUnknown].includes(shown),
      "der 429 fällt in den allgemeinen Text — dann sagt er dem Menschen nicht, dass ein geschlossener Reiter genügt"
    );
    assert.ok(document.body.querySelector('[role="alert"]'), "die Meldung ist für den Screenreader keine");
    assert.equal(at("log-view")?.getAttribute("data-phase"), "failed");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 5. Der Abbruch ──────────────────────────────────────────────────────────

test("beim Aushängen wird der Strom abgebrochen und der Leser gibt ihn frei", async () => {
  // ⚠️ NICHT daran geprüft, dass nichts mehr gerendert wird — das wäre auch
  // wahr, wenn der Strom munter weiterliefe und nur niemand mehr hinsähe.
  // Geprüft wird das Signal, die Freigabe des Lesers und dass er nicht noch
  // einmal liest.
  const { server, mounted } = await mount();
  await send(server, envelope("noch da"));
  assert.deepEqual(shownLines(), ["noch da"]);

  const signal = server.signals[0];
  assert.ok(signal, "der Aufruf ist ohne Abbruchsignal hinausgegangen");
  assert.equal(signal.aborted, false, "das Signal war schon vor dem Aushängen gebrochen");

  const readsBefore = server.body.state.reads;
  await mounted.unmount();
  await settle();

  assert.equal(signal.aborted, true, "das Aushängen bricht den Strom nicht ab — der Platz am Arm bleibt belegt");
  assert.equal(server.body.state.cancelled, true, "der Leser wurde nicht freigegeben");
  assert.equal(
    server.body.state.reads,
    readsBefore,
    `der Leser hat nach dem Abbruch weitergelesen (${server.body.state.reads} statt ${readsBefore})`
  );

  server.restore();
});

// ── 6. Der Deckel ───────────────────────────────────────────────────────────

test("über der Obergrenze fallen die ältesten Zeilen weg", async () => {
  const { server, mounted } = await mount();
  try {
    const excess = 5;
    // Alles in EINEM Chunk: der Deckel hat mit dem Schnitt der Chunks nichts
    // zu tun, und ein Chunk je Zeile machte aus diesem Fall einen Zeitfresser.
    const all = Array.from({ length: HELD_LINE_CAP + excess }, (_, index) => envelope(`line-${index}`)).join("");
    await send(server, all);

    const shown = shownLines();
    assert.equal(shown.length, HELD_LINE_CAP, `gehalten werden ${shown.length} Zeilen statt ${HELD_LINE_CAP}`);
    // ⚠️ Vorne wird weggeworfen und nicht hinten: das Neueste ist das, was
    // jemand lesen will.
    assert.equal(shown[0], `line-${excess}`, "die ältesten Zeilen stehen noch da");
    assert.equal(shown[shown.length - 1], `line-${HELD_LINE_CAP + excess - 1}`, "die neuesten Zeilen fehlen");
    // Und die Ansicht sagt, dass sie etwas weggeworfen hat — ein stiller
    // Deckel sähe aus wie ein Log mit Lücken.
    assert.ok(at("log-trimmed") !== null, "die Ansicht verschweigt, dass sie Zeilen verworfen hat");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 7. Ein Fehler im Strom ist kein roher Satz ──────────────────────────────

// Die vier Gründe des Agenten (v0.24.0) und der eine des Hubs — je Grund ein
// eigener Satz, und das rohe Wort steht dann nicht mehr im Dokument.
//
// ⚠️ ALS TABELLE UND NICHT ALS FÜNF FÄLLE: der Gegenstand ist bei allen
// derselbe, und fünf abgeschriebene Rümpfe wären die Stelle, an der beim
// nächsten Grund einer vergessen wird. Der Wert daneben ist der Nachweis, dass
// jeder einen EIGENEN Satz hat und nicht alle denselben.
const NAMED_REASONS: ReadonlyArray<readonly [string, keyof typeof de]> = [
  ["container-gone", "logStreamFailedContainerGone"],
  ["engine-refused", "logStreamFailedEngineRefused"],
  ["engine-unreachable", "logStreamFailedEngineUnreachable"],
  ["logs-failed", "logStreamFailedUnreadable"],
  // ⚠️ Der einzige Grund, den der HUB schreibt (#130) — er kommt aus derselben
  // Zeile des Stroms und muss denselben Weg nehmen. Stünde er hier nicht, wäre
  // die zweite Tabelle in `log-errors.ts` ungeprüft, und ein Tippfehler darin
  // zeigte den rohen Wortlaut, ohne dass irgendetwas rot würde.
  ["agent-stream-broken", "logStreamFailedHubBroken"]
];

for (const [reason, key] of NAMED_REASONS) {
  test(`„${reason}“ zeigt seinen eigenen Text, und das rohe Wort steht nicht im Dokument`, async () => {
    const { server, mounted } = await mount();
    try {
      await send(server, failureEnvelope(reason));

      const alert = at("log-stream-failed");
      assert.ok(alert, "die Ansicht meldet den Fehler im Strom gar nicht");
      const shown = alert.textContent ?? "";

      assert.ok([de[key], en[key]].includes(shown), `gezeigt wurde: ${JSON.stringify(shown)}`);
      assert.ok(
        !document.body.textContent?.includes(reason),
        `das rohe Wort „${reason}“ steht im Dokument, obwohl es einen eigenen Text gibt`
      );
    } finally {
      await mounted.unmount();
      server.restore();
    }
  });
}

test("ein unbekannter Grund fällt auf den Rückfallsatz zurück, MIT dem rohen Wort", async () => {
  // ⚠️ Denkbar für eine spätere Agentenfassung, die einen fünften Wert
  // schickt — heute kennt keine Fassung ihn, und genau das ist der Punkt:
  // die Anzeige darf ihn nicht verschlucken.
  //
  // ⚠️ DERSELBE WEG TRÄGT EINEN ALTEN ARM. Ein Container auf v0.23.0 schickt
  // weiterhin `abgebrochen` und `logs-fehlgeschlagen`; beide sind seit dem
  // Nachzug auf v0.24.0 unbekannte Werte und kommen hier heraus — roh, aber
  // sichtbar, statt an einem Parser zu scheitern.
  const reason = "verbindung-verloren";
  const { server, mounted } = await mount();
  try {
    await send(server, failureEnvelope(reason));

    const alert = at("log-stream-failed");
    assert.ok(alert, "die Ansicht meldet den Fehler im Strom gar nicht");
    const shown = alert.textContent ?? "";

    assert.ok(shown.includes(reason), `der rohe Grund fehlt im Rückfallsatz: ${JSON.stringify(shown)}`);
    assert.ok(
      [de.logStreamFailed.replace("{reason}", reason), en.logStreamFailed.replace("{reason}", reason)].includes(shown),
      `gezeigt wurde nicht der Rückfallsatz: ${JSON.stringify(shown)}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine fehler-Zeile ohne Grund bekommt ihren eigenen Satz, ohne Klammer und ohne erfundenes Wort (#176)", async () => {
  // ⚠️ Bis #176 setzte der Browser hier `unbekannt` ein, und die Ansicht zeigte
  // „Der Strom endete unerwartet (unbekannt)." — eine Klammer, die wie eine
  // Auskunft aussah und keine war.
  const { server, mounted } = await mount();
  try {
    await send(server, `${JSON.stringify({ kind: "error" })}\n`);

    const alert = at("log-stream-failed");
    assert.ok(alert, "die Ansicht meldet eine fehler-Zeile ohne Grund gar nicht");
    const shown = alert.textContent ?? "";
    assert.ok(
      [de.logStreamFailedWithoutReason, en.logStreamFailedWithoutReason].includes(shown),
      `gezeigt wurde nicht der Satz ohne Grund: ${JSON.stringify(shown)}`
    );
    assert.ok(!shown.includes("("), `der Satz trägt eine Klammer: ${JSON.stringify(shown)}`);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("die schon gelesenen Zeilen bleiben stehen, wenn danach ein Fehler im Strom kommt", async () => {
  const { server, mounted } = await mount();
  try {
    await send(server, envelope("erste"));
    await send(server, envelope("zweite"));
    assert.deepEqual(shownLines(), ["erste", "zweite"]);

    await send(server, failureEnvelope("abgebrochen"));

    assert.deepEqual(shownLines(), ["erste", "zweite"], "die gelesenen Zeilen sind beim Fehler verschwunden");
    assert.ok(at("log-stream-failed") !== null, "der Fehler wird nicht angezeigt");
    assert.equal(at("log-view")?.getAttribute("data-phase"), "failed");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── 8. Aus dem Fehler führt ein Weg zurück ──────────────────────────────────

test("nach einem Fehler IM Strom führt die Schaltfläche in einen neuen Strom", async () => {
  const { server, mounted } = await mount();
  try {
    await send(server, envelope("vor dem Fehler"));
    await send(server, failureEnvelope("abgebrochen"));
    assert.equal(at("log-view")?.getAttribute("data-phase"), "failed");

    // ⚠️ ERST DIE HÄLFTE, DIE NICHT PASSIEREN DARF. Zeit vergehen lassen —
    // mehrfach, damit eine Schleife mit kurzem Takt auffiele.
    for (let round = 0; round < 5; round += 1) await settle();
    assert.equal(
      server.urls.length,
      1,
      `nach dem Fehler sind ${server.urls.length} Ströme eröffnet worden statt einem — die Ansicht verbindet ` +
        "sich von selbst neu und belegt damit die acht Plätze des Arms"
    );

    // Und jetzt drückt ein Mensch.
    const button = at("log-reconnect");
    assert.ok(button, "es gibt keine Schaltfläche, mit der ein Mensch neu verbinden könnte");
    await React.act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    assert.equal(
      server.urls.length,
      2,
      "der Klick eröffnet keinen neuen Strom — dann führt aus dem Fehler gar kein Weg heraus"
    );
    assert.equal(at("log-view")?.getAttribute("data-phase"), "open", "der neue Strom steht nicht");
    assert.equal(at("log-stream-failed"), null, "die alte Fehlermeldung steht über dem neuen Strom");
    // ⚠️ UND DIE ALTEN ZEILEN SIND WEG, und das ist Absicht: der neue Strom
    // bringt seinen eigenen Ausschnitt der Vergangenheit mit. Behielte die
    // Ansicht die alten, stünde jede davon ein zweites Mal da.
    assert.deepEqual(shownLines(), [], "die Zeilen des abgerissenen Stroms stehen noch da");

    // Der neue Rumpf ist ein anderer — der alte ist beim Abbruch abgerissen.
    await send(server, envelope("nach dem Neuversuch"));
    assert.deepEqual(shownLines(), ["nach dem Neuversuch"]);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("auch der Fehler VOR der ersten Zeile trägt die Schaltfläche", async () => {
  // ⚠️ The 429 is the case that needs it most: "the arm is full" means try
  // again as soon as a tab is closed, and for exactly that an automatic loop
  // is the opposite of help.
  const { server, mounted } = await mount(429);
  try {
    const button = at("log-reconnect");
    assert.ok(button, "aus dem 429 führt kein Weg zurück");

    await React.act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    assert.equal(server.urls.length, 2, "der Klick fragt nicht noch einmal am Hub nach");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("solange der Strom läuft oder sauber endet, steht keine Schaltfläche da", async () => {
  // ⚠️ Zwei Zustände in EINEM Fall, weil beide dieselbe Aussage tragen: die
  // Schaltfläche gehört dem Fehler. Bei laufendem Strom wäre sie eine
  // Einladung, die gehaltenen Zeilen wegzuwerfen; nach einem sauberen Ende
  // brächte ein neuer Strom dieselbe Auskunft noch einmal.
  const { server, mounted } = await mount();
  try {
    await send(server, envelope("es läuft"));
    assert.equal(at("log-view")?.getAttribute("data-phase"), "open");
    assert.equal(at("log-reconnect"), null, "die Schaltfläche steht da, während der Strom läuft");

    await React.act(async () => {
      server.body.finish();
    });
    await settle();

    assert.equal(at("log-view")?.getAttribute("data-phase"), "ended");
    assert.equal(at("log-reconnect"), null, "die Schaltfläche steht nach einem sauberen Ende da");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
