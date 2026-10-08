import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GLOBAL_THEME } from "contract";

import { LOG_TAIL_LINE_OPTIONS } from "contract";
import type { Role } from "../src/platform/session/session-user.js";
import type { Settings } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { LogSettingsPanel } from "../src/features/logs/LogSettingsPanel.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Tafel „Logansicht" (#5, Etappe H) ist klein, und genau drei Dinge daran
// können still falsch werden — jedes davon übersetzt und bündelt sich:
//
//   1. THE STRING ON THE WIRE. A `<select>` in the browser ALWAYS delivers a
//      `string`, even for a number. The server checks strictly
//      (`typeof value === "number"`, server/src/features/logs/store.ts) and
//      answers a `"1000"` with `400 { error: "invalid-input" }`. A test that
//      only checks THAT something was sent would stay green, so the type of
//      the sent value is checked here, not only its look.
//   2. DER KNOPF FÜR DEN, DER NICHT DARF. Die Route steht hinter
//      `requireAdmin`. Ein Knopf, der einem Benutzer angeboten wird und
//      verlässlich in eine 403 läuft, ist eine Falle: er kostet eine Anfrage,
//      erzeugt eine 403 im Serverprotokoll und endet in einer Meldung, die
//      niemandem etwas sagt.
//   3. DER VORRAT. Vier Werte, weil der Agent seinen Ausschnitt bei 2000 hart
//      deckelt (`Math.min(tail, 2000)`). Ein fünfter Eintrag wäre eine Zusage,
//      die die Gegenseite nicht hält — gezählt wird deshalb auf GENAU vier und
//      nicht auf „mindestens vier".
//
// Dazu der vierte Fall, der nichts mit dieser Tafel allein zu tun hat und
// trotzdem jede betrifft: ein gescheitertes Speichern muss der Betreiber
// SEHEN. Sonst steht seine Auswahl da, als wäre sie abgelegt.

type Call = { method: string; url: string; body: unknown };

// A complete wire shape: every reader of `/api/settings` parses `/api/settings` against the
// contract since #248, and a fixture without a key fails there.
const SETTINGS: Settings = {
  theme: DEFAULT_GLOBAL_THEME,
        runtime: { applyComposeDefinition: true },
        selfHealing: { config: DEFAULT_SELF_HEALING_CONFIG, revision: 1, hosts: [] },
  logs: { tailLines: 500 },
  containers: { showSystem: false },
  network: {
    externalEndpoint: null,
    internalTarget: "192.0.2.31:51821",
    externalTarget: "192.0.2.31:51821",
    externalTargetUnreachable: true
  }
};

/**
 * Der Hub als Attrappe.
 *
 * `logsStatus` ist der Rückgabecode von `PUT /api/settings/logs`: 200 für den
 * gelungenen Fall, 500 für den Fall, in dem der Betreiber die Meldung sehen
 * soll. Ein 403 verhielte sich für diese Tafel genauso — geprüft wird die
 * Anzeige, nicht die Kennung.
 */
function stubHub(logsStatus = 200): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });

    if (url.includes("/api/settings/logs")) {
      if (logsStatus !== 200) return Promise.resolve(json({ error: "boom" }, logsStatus));
      // ⚠️ Die Attrappe antwortet mit dem UMSCHLAG `{ logs: … }`, so wie die
      // Route es tut. Gäbe sie das nackte Objekt zurück, prüfte dieser Test
      // eine Form, die es auf der Leitung nicht gibt.
      return Promise.resolve(json({ logs: (body as { logs: unknown }).logs }));
    }
    return Promise.resolve(json(SETTINGS));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

function need(testId: string): HTMLElement {
  const element = at(testId);
  assert.ok(element, `„${testId}“ steht nicht im Dokument`);
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

async function mount(role: Role, logsStatus = 200) {
  const server = stubHub(logsStatus);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <LogSettingsPanel role={role} />
    </AppLanguageProvider>
  );
  // Der erste Abruf hängt an einer Zusage: ohne diesen Durchlauf steht das
  // Auswahlfeld noch leer da.
  await settle();
  return { server, mounted };
}

/**
 * Die Auswahl aufklappen.
 *
 * ⚠️ ÜBER DIE TASTATUR und nicht über einen Zeiger — derselbe Grund wie in
 * `host-endpoint-field.test.tsx`: der Ausklapper von Radix ruft beim Öffnen
 * `releasePointerCapture` auf dem Auslöser auf, und happy-dom kennt die
 * Methode nicht.
 */
async function openChoices(): Promise<HTMLElement> {
  const trigger = document.body.querySelector("#log-tail-lines");
  assert.ok(trigger instanceof HTMLElement, "das Auswahlfeld für die Zeilenzahl steht da");
  await React.act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  await settle();
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "die Auswahl steht offen");
  return trigger;
}

test("die Tafel bietet genau die vier erlaubten Zeilenzahlen an", async () => {
  const { server, mounted } = await mount("admin");
  try {
    await openChoices();
    const offered = [...document.body.querySelectorAll('[data-testid^="log-tail-lines-option-"]')].map((item) =>
      (item.getAttribute("data-testid") ?? "").replace("log-tail-lines-option-", "")
    );

    // ⚠️ GENAU vier und nicht „mindestens vier". Ein fünfter Eintrag — etwa
    // 5000 — sähe im Bild harmlos aus und liefe in ein `400` des Servers;
    // über 2000 kürzte der Agent zusätzlich still auf 2000.
    assert.equal(offered.length, 4, `angeboten werden ${offered.length} Werte: ${offered.join(", ")}`);
    // Und es sind DIESE vier: die Liste aus `client.ts` ist die Quelle, aus
    // der die Tafel baut. Eine Tafel mit vier beliebigen Zahlen bestünde die
    // Zählung darüber.
    assert.deepEqual(offered, LOG_TAIL_LINE_OPTIONS.map(String));
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ohne Adminrecht wird kein Speichern angeboten — der Wert steht trotzdem da", async () => {
  const { server, mounted } = await mount("user");
  try {
    // ⚠️ Gegen einen Wahrheitswert verglichen und nicht gegen den Knoten: ein
    // `assert.equal(knoten, null)` reichte im ROTEN Fall den halben
    // Fensterbaum an die Fehlerausgabe weiter (derselbe Fund wie in
    // `host-endpoint-field.test.tsx`).
    assert.ok(
      at("log-tail-lines-save") === null,
      "der Knopf steht da, obwohl die Route diesen Benutzer mit 403 abweist"
    );
    // Sehen darf er den geltenden Stand: das Auswahlfeld ist abgeschaltet und
    // nicht verschwunden.
    const trigger = document.body.querySelector("#log-tail-lines");
    assert.ok(trigger instanceof HTMLElement, "das Auswahlfeld steht da");
    assert.equal(trigger.getAttribute("data-disabled"), "");
    assert.match(trigger.textContent ?? "", /500/);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("das Speichern sendet eine ZAHL und keine Zeichenkette", async () => {
  const { server, mounted } = await mount("admin");
  try {
    await openChoices();
    await click(need("log-tail-lines-option-1000"));
    await click(need("log-tail-lines-save"));

    const written = server.calls.find((call) => call.url.includes("/api/settings/logs"));
    assert.ok(written, "es wurde gar nicht gespeichert");
    assert.equal(written.method, "PUT");

    const sent = (written.body as { logs: { tailLines: unknown } }).logs.tailLines;
    // ⚠️ DIE ZUSAGE DIESES FALLS. Ohne die Umwandlung in `LogSettingsPanel`
    // stünde hier `"1000"`, und der Server antwortete mit
    // `400 { error: "invalid-input" }` — ein `assert.deepEqual` auf den Rumpf
    // allein fiele darüber ebenfalls, aber ein Test, der nur auf das
    // Vorhandensein des Aufrufs prüft, bliebe grün.
    assert.equal(typeof sent, "number", `gesendet wurde ${JSON.stringify(sent)}`);
    assert.equal(sent, 1000);
    assert.deepEqual(written.body, { logs: { tailLines: 1000 } });
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("scheitert das Speichern, sieht der Betreiber es", async () => {
  const { server, mounted } = await mount("admin", 500);
  try {
    await openChoices();
    await click(need("log-tail-lines-option-2000"));
    await click(need("log-tail-lines-save"));

    // ⚠️ Am `role="alert"` geprüft und nicht am Wortlaut: die Sprache des
    // Testlaufs hängt am Browser, und ein Wächter, der deutschen Text
    // erwartet, wäre auf Englisch rot gegen eine richtige Oberfläche.
    assert.ok(document.body.querySelector('[role="alert"]'), "die Meldung steht in der Tafel");
    assert.ok(at("log-tail-lines-failed") !== null, "die Tafel meldet den Fehlschlag nicht");
    // Und der Knopf ist wieder benutzbar: ein Fehlschlag, der die Tafel
    // gesperrt zurückließe, verlangte ein Neuladen für einen zweiten Versuch.
    const save = need("log-tail-lines-save");
    assert.ok(save instanceof HTMLButtonElement && !save.disabled, "der Knopf bleibt nach dem Fehlschlag gesperrt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
