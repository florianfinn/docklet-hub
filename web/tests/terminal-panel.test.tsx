// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GLOBAL_THEME,
  THEME_KNOBS,
  type GlobalThemePreset
} from "contract";
import type { Role } from "../src/platform/session/session-user.js";
import type { Settings } from "contract";
import { GlobalThemeProvider, useGlobalTheme } from "../src/features/appearance/index.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { TerminalPanel } from "../src/app/settings/TerminalPanel.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Tafel „Terminal" (B6, #5) trägt vier Stellschrauben, und vier Dinge
// daran können still falsch werden:
//
//   1. DER VORRAT. Die Stufen müssen die aus `presets.ts` sein und nicht eine
//      zweite, hier abgetippte Liste. Eine Stufe, die es dort nicht gibt,
//      käme als `400` des Servers zurück; eine, die fehlt, wäre eine Wahl, die
//      der Betreiber nicht hat. Verglichen wird deshalb gegen `THEME_KNOBS`
//      und nicht gegen vier Zahlen im Test.
//   2. ⚠️ DER VOLLE SATZ AUF DER LEITUNG. `PUT /api/settings/theme` nimmt die
//      elf globalen Stellschrauben und keine Teilmenge — ein unvollständiger
//      Rumpf endet in `server/src/features/appearance/input.ts` in einem `400` und
//      erreicht den Speicher nie. Ein Test, der nur prüft, DASS geschrieben
//      wurde, bliebe darüber grün. Geprüft wird deshalb, dass eine der
//      ANDEREN sieben Schrauben unverändert mitgeht — und zwar eine, die
//      NICHT auf ihrem Vorgabewert steht: der Hub in diesem Test trägt
//      `scheme: "light"`, die Vorgabe ist `dark`. Ein `save({ ...DEFAULT,
//      ...draft })` ginge beim Server durch, stellte dabei aber die
//      Darstellung des Betreibers zurück — genau das fällt hier auf und sonst
//      nirgends.
//   3. DER KNOPF FÜR DEN, DER NICHT DARF. Die Route steht hinter
//      `requireAdmin`. Ein Bedienelement, das verlässlich in eine 403 läuft,
//      ist eine Falle. Sehen darf ein Benutzer den geltenden Stand trotzdem.
//   4. EIN GESCHEITERTES SPEICHERN MUSS DER BETREIBER SEHEN. Sonst steht seine
//      Auswahl da, als wäre sie abgelegt.
//
// ⚠️ NICHT geprüft und bewusst so: wie die Tafel AUSSIEHT. happy-dom hat kein
// Layout — über Größen, Abstände und Überlappungen sagt dieser Wächter nichts
// zu.

type Call = { method: string; url: string; body: unknown };

/**
 * Der Satz, den der Hub dieses Tests gespeichert hat.
 *
 * ⚠️ `scheme: "light"` und `chroma: "bold"` weichen ABSICHTLICH von
 * `DEFAULT_GLOBAL_THEME` ab (`dark`, `normal`). Ohne diese Abweichung wäre
 * Prüfung 2 zahnlos: eine Tafel, die stur die Vorgabe schickte, träfe sonst
 * denselben Rumpf.
 */
const STORED: GlobalThemePreset = { ...DEFAULT_GLOBAL_THEME, scheme: "light", chroma: "bold" };

// A complete wire shape: every reader of `/api/settings` parses `/api/settings` against the
// contract since #248, and a fixture without a key fails there.
const SETTINGS: Settings = {
  theme: STORED,
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
 * `themeStatus` ist der Rückgabecode von `PUT /api/settings/theme`: 200 für
 * den gelungenen Fall, 500 für den, in dem der Betreiber die Meldung sehen
 * soll. Ein 403 verhielte sich für diese Tafel genauso — geprüft wird die
 * Anzeige, nicht die Kennung.
 */
function stubHub(themeStatus = 200): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });

    if (url.includes("/api/settings/theme")) {
      if (themeStatus !== 200) return Promise.resolve(json({ error: "boom" }, themeStatus));
      // ⚠️ Die Attrappe antwortet mit dem UMSCHLAG `{ theme: … }`, so wie die
      // Route es tut. Gäbe sie das nackte Objekt zurück, prüfte dieser Test
      // eine Form, die es auf der Leitung nicht gibt.
      return Promise.resolve(json({ theme: (body as { theme: unknown }).theme }));
    }
    return Promise.resolve(json(SETTINGS));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

/**
 * Der Anbieter, geladen — wie nach der Anmeldung.
 *
 * ⚠️ `GlobalThemeProvider` ruft `load()` NICHT selbst: `GET /api/settings`
 * steht hinter `withSession`, und der Abruf hängt deshalb an der Sitzung
 * (`web/src/App.tsx` ruft ihn, sobald sie steht). Dieser Aufruf hier ist
 * dasselbe an derselben Stelle — ohne ihn stünde im Anbieter
 * `DEFAULT_GLOBAL_THEME`, und Prüfung 2 könnte ihren Fall nicht bauen.
 */
function ThemeLoader({ children }: { children: React.ReactNode }) {
  const { load } = useGlobalTheme();
  React.useEffect(() => {
    load();
  }, [load]);
  return <>{children}</>;
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

async function mount(role: Role, themeStatus = 200) {
  const server = stubHub(themeStatus);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <GlobalThemeProvider>
        <ThemeLoader>
          <TerminalPanel role={role} />
        </ThemeLoader>
      </GlobalThemeProvider>
    </AppLanguageProvider>
  );
  // Der Abruf des Anbieters hängt an einer Zusage: ohne diesen Durchlauf
  // stünde noch die Vorgabe in den Feldern.
  await settle();
  return { server, mounted };
}

/**
 * Ein Auswahlfeld aufklappen.
 *
 * ⚠️ ÜBER DIE TASTATUR und nicht über einen Zeiger — derselbe Grund wie in
 * `log-settings-panel.test.tsx`: der Ausklapper von Radix ruft beim Öffnen
 * `releasePointerCapture` auf dem Auslöser auf, und happy-dom kennt die
 * Methode nicht.
 */
async function open(testId: string): Promise<HTMLElement> {
  const trigger = need(testId);
  await React.act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  await settle();
  assert.equal(trigger.getAttribute("aria-expanded"), "true", `„${testId}“ steht offen`);
  return trigger;
}

/** Wieder zuklappen — zwei offene Listen gleichzeitig gibt es nicht. */
async function close(trigger: HTMLElement): Promise<void> {
  await React.act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await settle();
}

// Die vier Zeilen der Tafel, jede mit ihrem Griff und ihrer Stufenliste aus
// `presets.ts`. Als Tabelle und nicht als vier abgeschriebene Prüfungen: eine
// fünfte Stellschraube gehört hier ergänzt, und mehr ist es dann nicht.
const ROWS = [
  { testId: "terminal-knob-scheme", steps: THEME_KNOBS.terminalScheme.steps },
  { testId: "terminal-knob-surface", steps: THEME_KNOBS.terminalSurface.steps },
  { testId: "terminal-knob-size", steps: THEME_KNOBS.terminalSize.steps },
  { testId: "terminal-knob-scrollback", steps: THEME_KNOBS.terminalScrollback.steps }
] as const;

test("die Tafel zeichnet vier Auswahlfelder mit den Stufen aus presets.ts", async () => {
  const { server, mounted } = await mount("admin");
  try {
    for (const row of ROWS) {
      const trigger = await open(row.testId);
      const offered = [...document.body.querySelectorAll(`[data-testid^="${row.testId}-"]`)].map((item) =>
        (item.getAttribute("data-testid") ?? "").replace(`${row.testId}-`, "")
      );
      // GENAU die Stufen aus `presets.ts`, in deren Reihenfolge — nicht
      // „mindestens" und nicht „irgendwelche vier".
      assert.deepEqual(
        offered,
        row.steps.map((step) => step.name),
        `„${row.testId}“ bietet ${offered.join(", ")} an`
      );
      await close(trigger);
    }
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("eine Änderung schickt den VOLLEN Satz — die anderen sieben gehen unverändert mit", async () => {
  const { server, mounted } = await mount("admin");
  try {
    // Der geltende Stand steht in den Feldern, bevor etwas angefasst wird.
    // Ohne diese Zusicherung könnte der Rumpf unten auch aus einem Zufall
    // stimmen, der nie auf dem Schirm stand.
    assert.equal(need("terminal-knob-surface").getAttribute("aria-expanded"), "false");

    const trigger = await open("terminal-knob-surface");
    await click(need("terminal-knob-surface-ink"));
    await close(trigger);
    await click(need("terminal-save"));

    const written = server.calls.find((call) => call.url.includes("/api/settings/theme"));
    assert.ok(written, "es wurde gar nicht gespeichert");
    assert.equal(written.method, "PUT");

    const sent = (written.body as { theme: GlobalThemePreset }).theme;
    // ⚠️ DIE ZUSAGE DIESES FALLS, dreifach und jedes Mal gegen einen anderen
    // Fehler:
    //
    //   - `scheme` ist „light" und nicht „dark". Das fällt gegen eine Tafel,
    //     die `DEFAULT_GLOBAL_THEME` als Grundlage nähme — ihr Rumpf ginge
    //     beim Server durch und stellte die Darstellung zurück.
    //   - `terminalSurface` ist „ink". Das fällt gegen eine Tafel, die den
    //     Entwurf nicht mitschickt.
    //   - der GANZE Satz ist gleich. Das fällt gegen eine Teilmenge, die schon
    //     `features/appearance/input.ts` mit `400` abwiese.
    assert.equal(sent.scheme, "light", `gesendet wurde scheme=${JSON.stringify(sent.scheme)}`);
    assert.equal(sent.chroma, "bold");
    assert.equal(sent.terminalSurface, "ink");
    assert.deepEqual(sent, { ...STORED, terminalSurface: "ink" });

    // Und der Betreiber sieht, dass es abgelegt ist.
    assert.ok(at("terminal-saved") !== null, "die Tafel meldet das Speichern nicht");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ohne Adminrecht gibt es kein Schreibmittel — die Werte stehen trotzdem da", async () => {
  const { server, mounted } = await mount("user");
  try {
    // ⚠️ Gegen einen Wahrheitswert verglichen und nicht gegen den Knoten: ein
    // `assert.equal(knoten, null)` reichte im ROTEN Fall den halben
    // Fensterbaum an die Fehlerausgabe weiter (Fund aus
    // `host-endpoint-field.test.tsx`).
    assert.ok(at("terminal-save") === null, "der Knopf steht da, obwohl die Route mit 403 abweist");
    assert.equal(
      document.body.querySelectorAll('[role="combobox"]').length,
      0,
      "es steht ein Auswahlfeld da, obwohl dieser Benutzer nicht schreiben darf"
    );

    // Sehen darf er den geltenden Stand: jede der vier Zeilen trägt ihren Wert
    // als Text. Geprüft wird, dass der Griff da ist und NICHT leer — nicht der
    // Wortlaut: die Sprache des Testlaufs hängt am Browser, und ein Wächter,
    // der deutschen Text erwartet, wäre auf Englisch rot gegen eine richtige
    // Oberfläche.
    for (const row of ROWS) {
      const shown = need(row.testId);
      assert.equal(shown.getAttribute("role"), null, `„${row.testId}“ ist ein Bedienelement`);
      assert.ok((shown.textContent ?? "").trim().length > 0, `„${row.testId}“ steht leer da`);
    }
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("der Verlauf trägt seinen Hinweis, und er hängt am Auswahlfeld", async () => {
  const { server, mounted } = await mount("admin");
  try {
    // ⚠️ WARUM DIESE PRÜFUNG. „5.000 Zeilen" liest sich wie eine Zusage über
    // die Vergangenheit. Die Zahl ist aber Speicher IM BROWSER — der Agent
    // kennt keinen Verlauf und schickt, was kommt. Der Satz, der das
    // geradezieht, muss deshalb da sein UND am Feld hängen: nur daneben
    // gestellt, hört ihn niemand, der sich die Zeile vorlesen lässt.
    const described = need("terminal-knob-scrollback").getAttribute("aria-describedby");
    assert.ok(described, "das Feld für den Verlauf nennt keinen Hinweis");
    const hint = document.body.querySelector(`#${described}`);
    assert.ok(hint, `der Hinweis „${described}“ steht nicht im Dokument`);
    assert.ok((hint.textContent ?? "").trim().length > 0, "der Hinweis steht leer da");

    // Und nur dort: ein Hinweis an jeder Zeile wäre Lärm, und die drei
    // anderen Stufen tragen ihre Bedeutung im Namen.
    for (const row of ROWS.filter((entry) => entry.testId !== "terminal-knob-scrollback")) {
      assert.equal(
        need(row.testId).getAttribute("aria-describedby"),
        null,
        `„${row.testId}“ trägt einen Hinweis, der nicht vorgesehen ist`
      );
    }
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("scheitert das Speichern, sieht der Betreiber es", async () => {
  const { server, mounted } = await mount("admin", 500);
  try {
    const trigger = await open("terminal-knob-size");
    await click(need("terminal-knob-size-large"));
    await close(trigger);
    await click(need("terminal-save"));

    // Am `role="alert"` geprüft und nicht am Wortlaut — siehe oben.
    assert.ok(document.body.querySelector('[role="alert"]'), "die Meldung steht in der Tafel");
    assert.ok(at("terminal-failed") !== null, "die Tafel meldet den Fehlschlag nicht");
    assert.ok(at("terminal-saved") === null, "die Tafel meldet ein Speichern, das nicht geschehen ist");

    // Und der Knopf ist wieder benutzbar: ein Fehlschlag, der die Tafel
    // gesperrt zurückließe, verlangte ein Neuladen für einen zweiten Versuch.
    const save = need("terminal-save");
    assert.ok(save instanceof HTMLButtonElement && !save.disabled, "der Knopf bleibt nach dem Fehlschlag gesperrt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
