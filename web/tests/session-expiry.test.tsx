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
import { register } from "node:module";
import test from "node:test";

import { MemoryRouter } from "react-router";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Befund aus #127: eine Sitzung, die WÄHREND der Arbeit abläuft, wird
// nirgends als solche erkannt. Jede Fläche bekommt denselben 401 als
// gewöhnlichen `ApiError` und zeigt ihre allgemeine Fehlermeldung; der Weg
// zurück zur Anmeldung führt allein über ein Neuladen von Hand.
//
// Drei Fehler sind an dieser Behebung möglich, und alle drei sind gültiges
// TypeScript mit einer grünen Prüfkette:
//
//   1. DER MELDER HÄNGT AN DER FALSCHEN STELLE. Sitzt er in `request` statt
//      im Konstruktor von `ApiError`, dann melden die Aufrufe über `request` —
//      und der Log-Strom, die Shell, das Anwenden eines Compose-Standes und
//      der Datei-Upload melden nicht. Das sind genau die Flächen, auf denen
//      jemand LANGE steht, also die, auf denen eine Sitzung abläuft. Ein Test,
//      der nur `fetchOverview` prüft, bliebe dabei grün.
//   2. DER START WIRD MITGERISSEN. Der 401 beim ersten Abruf ist kein Ablauf,
//      sondern die Antwort „niemand angemeldet". Eine Fassung, die ihn wie
//      einen Ablauf behandelt, zeigt jedem, der die Seite öffnet, „Die Sitzung
//      ist abgelaufen" — auch dem, der sich zum ersten Mal anmeldet.
//   3. DER SATZ FEHLT. Der Sprung zum Anmeldeformular ohne ein Wort dazu ist
//      aus Sicht des Menschen ein Absturz mitten in seiner Arbeit.
//
// NICHT geprüft: dass der Server nach Ablauf tatsächlich mit 401 antwortet.
// `fetch` ist hier eine Attrappe. Die Sitzung selbst prüft der
// `server`-Workspace.
//
// ⚠️ DIE SRC-MODULE KOMMEN ÜBER `await import(…)` UND NICHT ÜBER EINEN
// KOPF-IMPORT, und das ist kein Stil, sondern eine gemessene Notwendigkeit.
// `App` zieht den `DotWave` herein (seit #269 reicht es ihn an `AuthCard` weiter), und der trägt in Zeile 3
// ein `import "./dot-wave.css"` — ein Vite-Import, den `node --import tsx`
// nicht kennt:
//
//     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".css"
//       for …/web/src/platform/ui/dot-wave/dot-wave.css
//
// Gemessen am 2026-09-09. Der Lader daneben (`xterm-stub-loader.mjs`, E8)
// macht aus jedem `.css` ein leeres Modul und biegt `@xterm/*` auf das Doppel
// um; sein Kopf begründet beides. Seine Haken greifen aber erst AB dem
// `register(…)` — ein statischer Import oben stünde davor und liefe in
// denselben Fehler. Das Erzeugnis bleibt dafür unangetastet (AGENTS.md, „Der
// Wächter passt sich dem Code an, nie umgekehrt").
register("./xterm-stub-loader.mjs", import.meta.url, {
  data: { doubleUrl: new URL("./xterm-double.mjs", import.meta.url).href }
});

// ⚠️ `__HUB_VERSION__` IST EIN `define` AUS `web/vite.config.ts` UND KEIN
// MODUL. `AuthCard` zeigt es in seiner Fußzeile; im Testlauf gibt es keinen
// Bündler, der es einsetzt, und der Aufbau des Anmeldebildschirms endet ohne
// diesen Wert mit „__HUB_VERSION__ is not defined" (gemessen am 2026-09-09).
// Der Platzhalter steht hier und nicht in `dom-harness.tsx`: er gehört zum
// Bauschritt dieses einen Bildschirms, nicht zum DOM.
(globalThis as unknown as { __HUB_VERSION__: string }).__HUB_VERSION__ = "0.0.0-test";

const { DEFAULT_GLOBAL_THEME } = await import("contract");
const { App } = await import("../src/App.js");
const { ApiError } = await import("../src/platform/http/transport.js");
const { fetchOverview } = await import("../src/features/containers/api.js");
const { onUnauthorized } = await import("../src/platform/http/session-expiry.js");
const { GlobalThemeProvider } = await import("../src/features/appearance/index.js");
const { AppLanguageProvider } = await import("../src/app/i18n/AppLanguageProvider.js");
const { de, en } = await import("../src/app/i18n/messages.js");

/**
 * Der Hub ohne Hub: die vier Antworten, die der angemeldete Baum beim
 * Einhängen holt.
 *
 * ⚠️ `unauthorized` ist ein SCHALTER und keine feste Antwort. Der Fall, um den
 * es geht, ist ein Wechsel MITTEN im Betrieb: erst antwortet der Hub, dann ist
 * die Sitzung weg. Eine Attrappe, die von Anfang an 401 sagt, prüft den Start
 * und nicht den Ablauf.
 */
function stubHub(): { unauthorized: () => void; restore: () => void } {
  const original = globalThis.fetch;
  let expired = false;

  const user = {
    id: "u1",
    name: "Betreiberin",
    email: "b@hub.test",
    role: "admin",
    language: "de"
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });

  const routes: Record<string, () => Response> = {
    "/api/setup": () => json({ open: false }),
    "/api/session": () => json({ user }),
    "/api/settings": () =>
      json({
        theme: DEFAULT_GLOBAL_THEME,
        logs: { tailLines: 200 },
        containers: { showSystem: false },
        network: {
          externalEndpoint: null,
          internalTarget: null,
          externalTarget: null,
          externalTargetUnreachable: false
        }
      }),
    "/api/overview": () => json({ hosts: [] })
  };

  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (expired) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      );
    }
    const path = new URL(String(input), "https://hub.test/").pathname;
    const answer = routes[path];
    // Eine Route, die diese Attrappe nicht kennt, ist ein Befund und kein
    // Grund für eine erfundene Antwort: die käme als leeres Objekt durch und
    // machte den Test grün über eine Fläche, die niemand nachgesehen hat.
    return Promise.resolve(answer ? answer() : new Response(null, { status: 501 }));
  }) as typeof fetch;

  return {
    unauthorized: () => {
      expired = true;
    },
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function renderApp() {
  return renderInDom(
    <MemoryRouter>
      <AppLanguageProvider>
        <GlobalThemeProvider>
          <App />
        </GlobalThemeProvider>
      </AppLanguageProvider>
    </MemoryRouter>
  );
}

// ⚠️ Die Sprache des Prüfstands kommt aus der Fensterwelt: `LanguageProvider`
// liest sie aus dem Browser. Beide Fassungen sind deshalb zugelassen — ein
// fest verdrahtetes Deutsch bräche, sobald happy-dom eine andere Sprache
// meldet.
function shows(container: HTMLElement, texts: string[]): boolean {
  const shown = container.textContent ?? "";
  return texts.some((text) => shown.includes(text));
}

function signInFormStands(container: HTMLElement): boolean {
  return container.querySelector("#sign-in-email") instanceof HTMLInputElement;
}

// ---------------------------------------------------------------------------
// 1. Der Fall selbst: 401 mitten in der Arbeit
// ---------------------------------------------------------------------------
test("ein 401 während der Arbeit führt zur Anmeldung, mit dem Grund dabei", async () => {
  const hub = stubHub();
  const { container, unmount } = await renderApp();

  try {
    await settle();

    // Die Ausgangslage, und sie ist keine Formsache: ohne sie prüfte der Test
    // unten ein Anmeldeformular, das die ganze Zeit dastand.
    assert.ok(
      !signInFormStands(container),
      "vor dem Ablauf steht die angemeldete Ansicht und kein Anmeldeformular"
    );
    assert.ok(
      !shows(container, [de.signInExpired, en.signInExpired]),
      "der Satz über die abgelaufene Sitzung steht nicht im Voraus da"
    );

    // Der Ablauf: der Hub sagt ab jetzt 401, und eine Fläche fragt etwas —
    // genau das, was jede Fläche im Hintergrund tut.
    //
    // ⚠️ Der Aufruf wird ANGESTOSSEN und nicht abgewartet; abgewartet wird
    // `settle`. React verlangt jede Zustandsänderung in `act(…)`, und der
    // Zustand ändert sich erst, wenn die abgelehnte Zusage durchgelaufen ist:
    // ein `await` davor legte sie außerhalb von `act` ab und brächte bei jedem
    // Lauf dieselbe Warnung auf stderr — eine Warnung, die immer kommt, liest
    // niemand mehr.
    hub.unauthorized();
    void fetchOverview().catch(() => undefined);
    await settle();

    assert.ok(
      signInFormStands(container),
      "nach dem 401 steht das Anmeldeformular — ohne Neuladen von Hand"
    );
    assert.ok(
      shows(container, [de.signInExpired, en.signInExpired]),
      `der Grund steht dabei. Gezeigt wurde:\n${container.textContent}`
    );
  } finally {
    await unmount();
    hub.restore();
  }
});

// ---------------------------------------------------------------------------
// 2. Der Start bleibt ein Start
// ---------------------------------------------------------------------------
//
// ⚠️ Dieser Fall ist der teurere von beiden. Fehlt er, ist der naheliegende
// Bau — „bei 401 zeige den Ablaufsatz" — grün, und jeder, der die Seite
// öffnet, ohne angemeldet zu sein, liest, seine Sitzung sei abgelaufen. Er hat
// nie eine gehabt.
test("der 401 beim ersten Abruf ist kein Ablauf, sondern die Anmeldung", async () => {
  const hub = stubHub();
  hub.unauthorized();
  const { container, unmount } = await renderApp();

  try {
    await settle();

    assert.ok(signInFormStands(container), "ohne Sitzung steht das Anmeldeformular");
    assert.ok(
      !shows(container, [de.signInExpired, en.signInExpired]),
      `wer nie angemeldet war, liest nichts von einer abgelaufenen Sitzung. Gezeigt wurde:\n${container.textContent}`
    );
  } finally {
    await unmount();
    hub.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Der Melder hängt am Konstruktor, nicht an `request`
// ---------------------------------------------------------------------------
//
// ZWECK: `request` und `requestNoContent` sind zwei von zwölf Stellen, an
// denen ein `ApiError` entsteht (gemessen am 2026-09-09 auf `00b6c22`:
// `grep -rn "new ApiError" web/src | wc -l`). Der Log-Strom, die Shell, das
// Anwenden eines Compose-Standes und der Datei-Upload bauen ihn selbst — der
// Upload nicht einmal über `fetch`, sondern über einen `XHR`.
//
// FÄNGT: den Melder an der bequemen Stelle. Ein `if (response.status === 401)`
// in `request` sieht richtig aus und lässt genau die Flächen ohne Meldung, auf
// denen jemand lange genug steht, dass eine Sitzung abläuft.
//
// ⚠️ GEPRÜFT WIRD AM ROHEN `new ApiError`, ohne `fetch` und ohne DOM. Das ist
// die Form, in der `files.ts` ihn baut; kommt die Meldung hier an, kommt sie
// aus jeder der zwölf Stellen.
test("jeder ApiError mit 401 meldet, unabhängig vom Weg", () => {
  const seen: string[] = [];
  const stop = onUnauthorized(() => seen.push("gemeldet"));

  try {
    const expired = new ApiError(401, "abgelaufen");
    assert.equal(expired.status, 401);
    assert.equal(
      seen.length,
      1,
      "ein roher `new ApiError(401, …)` meldet — so baut ihn der Datei-Upload"
    );

    for (const status of [403, 500, 0]) new ApiError(status, "kein Ablauf");
    assert.equal(
      seen.length,
      1,
      "kein anderer Status meldet — sonst spränge jeder Fehler zur Anmeldung"
    );
  } finally {
    stop();
  }

  const afterStop = new ApiError(401, "nach der Abmeldung");
  assert.equal(afterStop.status, 401);
  assert.equal(
    seen.length,
    1,
    "nach `stop()` kommt nichts mehr an — sonst schriebe ein Zuhörer in einen Baum, den es nicht mehr gibt"
  );
});
