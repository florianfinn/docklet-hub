// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GLOBAL_THEME, THEME_KNOBS } from "contract";
import type { Role } from "../src/platform/session/session-user.js";
import type { Settings } from "contract";
import { GlobalThemeProvider } from "../src/features/appearance/index.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { AppearancePanel } from "../src/features/appearance/AppearancePanel.js";

// WAS DIESE DATEI PRÜFT UND WARUM SIE ÜBERHAUPT ENTSTANDEN IST
//
// Seit B6 (#5) ist die Zeile einer Stellschraube ein GETEILTES Bauteil
// (`web/src/features/appearance/KnobRow.tsx`): „Darstellung" und „Terminal"
// zeichnen dieselbe Komponente. Das ist richtig — zwei Abschriften wären
// schlimmer —, aber es hat eine Pflicht erzeugt: die Komponente hat zwei
// Verwender, und bis hierher wurde nur EINER von ihnen gezeichnet
// (`terminal-panel.test.tsx`). „Darstellung" hatte keinen einzigen Test.
//
// ⚠️ DER KOPF VON `AppearancePanel.tsx` MACHT EINE ZUSAGE ÜBER SEINEN
// GERENDERTEN BAUM: diese Tafel setzt weder `testId` noch `hint`, ihr Baum ist
// damit derselbe wie vor dem Umzug. Diese Zusage war eine ZWEITE WAHRHEIT —
// von Hand geprüft und richtig, aber von keinem Werkzeug gehalten. Setzt
// jemand in `KnobRow` ein Attribut OHNE Bedingung, wird sie still falsch: die
// Tafel „Terminal" bliebe grün, denn dort sind die Attribute erwünscht.
//
// GEPRÜFT WIRD DESHALB, drei Zusicherungen, nicht mehr:
//
//   1. DIE TAFEL ZEICHNET IHRE STELLSCHRAUBEN — mit Adminrecht als
//      Auswahlfelder, ohne Adminrecht als Text. Die Zahl ist aus
//      `THEME_KNOBS` ABGELEITET und nicht hingeschrieben: eine achte globale
//      Stellschraube, die in `AppearancePanel.tsx` nicht nachgetragen wird,
//      fällt hier auf. Eine hingeschriebene 7 verfiele beim nächsten Knopf
//      lautlos.
//   2. KEIN `data-testid` UND KEIN `aria-describedby` AN DIESER TAFEL. Das ist
//      der Kern: er wird rot, sobald in `KnobRow` ein Attribut ohne Bedingung
//      gesetzt wird.
//   3. Beides an ELEMENTEN, DIE GEFUNDEN WURDEN. Eine Abfrage, die nichts
//      liefert, beweist nichts — sie ist auch grün, wenn die Tafel gar nichts
//      gezeichnet hat. Der Fegezug über `[data-testid]` steht deshalb nur als
//      Rückhalt daneben, und die eigentliche Prüfung fragt jede gefundene
//      Zeile einzeln nach ihren Attributen.
//
// ⚠️ `assert.equal(<DOM-Knoten>, null)` kommt hier NICHT vor: es bringt den
// Testläufer um und hängt gegen ein gefundenes Element (Fund aus
// `host-endpoint-field.test.tsx`). Verglichen wird immer das Ergebnis von
// `getAttribute(…)` gegen `null` — ein `string | null` und kein Knoten.
//
// ⚠️ NICHT geprüft und bewusst so: das VERHALTEN dieser Tafel (Vorschau,
// Verwerfen, Rücknahme beim Aushängen) und wie sie AUSSIEHT. Das erste ist ein
// eigener Auftrag, das zweite kann happy-dom nicht — es hat kein Layout.
// Dieser Wächter hält genau die Zusage aus dem Kopf der Datei.

// Die globalen Stellschrauben, aufgeteilt auf ihre zwei Tafeln — beides
// ABGELEITET aus `presets.ts` und nicht aufgezählt.
//
// ⚠️ Die Trennung läuft über den Namen und nicht über `scope`: BEIDE Gruppen
// sind `scope: ["global"]`, die vier des Terminals stehen seit B6 (#5) nur in
// einer eigenen Karte (Begründung im Kopf von `TerminalPanel.tsx`). Der
// Namenspräfix ist damit der einzige Unterschied, den `presets.ts` selbst
// kennt.
const GLOBAL_KNOBS = Object.entries(THEME_KNOBS).filter(([, knob]) => {
  const scopes: readonly string[] = knob.scope;
  return scopes.includes("global");
});
const APPEARANCE_KNOBS = GLOBAL_KNOBS.filter(([name]) => !name.startsWith("terminal"));
const TERMINAL_KNOBS = GLOBAL_KNOBS.filter(([name]) => name.startsWith("terminal"));

// A complete wire shape: every reader of `/api/settings` parses `/api/settings` against the
// contract since #248, and a fixture without a key fails there.
const SETTINGS: Settings = {
  theme: DEFAULT_GLOBAL_THEME,
  logs: { tailLines: 500 },
  containers: { showSystem: false },
  network: {
    externalEndpoint: null,
    internalTarget: "192.0.2.31:51821",
    externalTarget: "192.0.2.31:51821",
    externalTargetUnreachable: true
  }
};

function stubHub(): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(SETTINGS), { status: 200, headers: { "content-type": "application/json" } })
    )) as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

async function mount(role: Role) {
  const server = stubHub();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <GlobalThemeProvider>
        <AppearancePanel role={role} />
      </GlobalThemeProvider>
    </AppLanguageProvider>
  );
  await settle();
  return { server, mounted };
}

/**
 * Die Zeilen der Feldliste.
 *
 * ⚠️ ÜBER DEN BAU UND NICHT ÜBER EINEN GRIFF, und das ist keine Bequemlichkeit:
 * ein `data-testid` in `KnobRow` einzubauen, um zu beweisen, dass diese Tafel
 * kein `data-testid` trägt, hätte die Zusicherung aufgehoben, die hier geprüft
 * wird. Verankert wird deshalb an `[data-slot="card"]` — das ist die
 * Kennzeichnung des shadcn-Bausteins und kein Testgriff — und von dort an der
 * Gliederung der Tafel: Kopf, dann der Kasten mit den Zeilen. Die Zeilen sind
 * dessen unmittelbare `div`-Kinder; der Satz „nur ein Administrator" daneben
 * ist ein `<p>` und zählt damit nicht mit.
 */
function rowsOf(container: HTMLElement): HTMLElement[] {
  const card = container.querySelector('[data-slot="card"]');
  assert.ok(card instanceof HTMLElement, "die Tafel zeichnet keine Karte");
  const body = card.children[1];
  assert.ok(body instanceof HTMLElement, "die Karte hat keinen Kasten mit den Zeilen");
  return [...body.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "DIV");
}

/**
 * Das Element einer Zeile, das ihren WERT trägt — der Auslöser des
 * Auswahlfelds, solange geschrieben werden darf, und sonst der Text daneben.
 * Es ist das letzte Kind der Zeile.
 */
function valueOf(row: HTMLElement): HTMLElement {
  const value = row.lastElementChild;
  assert.ok(value instanceof HTMLElement, "die Zeile trägt keinen Wert");
  return value;
}

test("die Aufteilung der globalen Stellschrauben auf zwei Tafeln ist nicht leer", () => {
  // ⚠️ Der Wächter über den Wächter. Wären die zwei Filter oben leer — etwa
  // weil `scope` einmal umgebaut wird —, prüften die Tests darunter „null
  // Zeilen gegen null erwartete" und blieben grün, während die Tafel nichts
  // mehr zeichnet. Diese Prüfung hält die Ableitung selbst.
  // ⚠️ Das schließende Anführungszeichen ist hier U+201C („…“) und nicht das
  // gerade `"` der Kommentare ringsherum: in einer Zeichenkette beendete das
  // gerade Zeichen das Literal, und esbuild bricht mit „Expected )" ab
  // (gemessen). Dieselbe Schreibweise wie in `terminal-panel.test.tsx`.
  assert.ok(APPEARANCE_KNOBS.length > 0, "kein Eintrag für „Darstellung“ abgeleitet");
  assert.ok(TERMINAL_KNOBS.length > 0, "kein Eintrag für „Terminal“ abgeleitet");
  assert.equal(APPEARANCE_KNOBS.length + TERMINAL_KNOBS.length, GLOBAL_KNOBS.length);
});

test("mit Adminrecht zeichnet die Tafel je Stellschraube ein Auswahlfeld", async () => {
  const { server, mounted } = await mount("admin");
  try {
    const rows = rowsOf(mounted.container);
    // Abgeleitet und nicht hingeschrieben: eine achte globale Stellschraube,
    // die hier nicht nachgetragen wird, macht diese Zeile rot.
    assert.equal(
      rows.length,
      APPEARANCE_KNOBS.length,
      `gezeichnet werden ${rows.length} Zeilen, abgeleitet sind ${APPEARANCE_KNOBS.length}`
    );
    assert.equal(
      mounted.container.querySelectorAll('[role="combobox"]').length,
      APPEARANCE_KNOBS.length,
      "die Zahl der Auswahlfelder passt nicht zur Zahl der Stellschrauben"
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ohne Adminrecht steht jede Stellschraube als Text da, ohne Bedienelement", async () => {
  const { server, mounted } = await mount("user");
  try {
    const rows = rowsOf(mounted.container);
    assert.equal(rows.length, APPEARANCE_KNOBS.length);
    assert.equal(
      mounted.container.querySelectorAll('[role="combobox"]').length,
      0,
      "es steht ein Auswahlfeld da, obwohl `PUT /api/settings/theme` mit 403 abweist"
    );
    // Und der Wert ist zu LESEN. Eine Tafel, die ohne Adminrecht sieben leere
    // Zeilen zeichnete, käme durch die Zählung darüber.
    for (const row of rows) {
      assert.ok((valueOf(row).textContent ?? "").trim().length > 0, "eine Zeile steht ohne Wert da");
    }
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ⚠️ DIE ZUSAGE AUS DEM KOPF VON `AppearancePanel.tsx`, hier aufgehängt. Sie
// läuft über BEIDE Rollen, weil `KnobRow` zwei Zweige hat: mit Adminrecht das
// Auswahlfeld, ohne den Text daneben. Ein Attribut, das nur in einem der
// beiden ohne Bedingung gesetzt wird, fiele durch eine Prüfung über nur eine
// Rolle.
for (const role of ["admin", "user"] as const) {
  test(`die Tafel setzt als ${role} weder einen Testgriff noch einen Hinweis`, async () => {
    const { server, mounted } = await mount(role);
    try {
      const rows = rowsOf(mounted.container);
      assert.equal(rows.length, APPEARANCE_KNOBS.length);

      // ⚠️ GEPRÜFT AN ELEMENTEN, DIE GEFUNDEN WURDEN — an der Zeile selbst und
      // an ihrem Wert. Und verglichen wird das Ergebnis von `getAttribute(…)`,
      // also ein `string | null`, und NIE der Knoten: ein
      // `assert.equal(knoten, null)` bringt den Testläufer um und hängt gegen
      // ein gefundenes Element.
      for (const row of rows) {
        const value = valueOf(row);
        assert.equal(row.getAttribute("data-testid"), null, "eine Zeile trägt einen Testgriff");
        assert.equal(value.getAttribute("data-testid"), null, "der Wert einer Zeile trägt einen Testgriff");
        assert.equal(
          value.getAttribute("aria-describedby"),
          null,
          "der Wert einer Zeile verweist auf einen Hinweis, den diese Tafel nicht setzt"
        );
      }

      // Der Rückhalt: nirgends im Baum der Tafel. Er steht ABSICHTLICH nur
      // hinter der Prüfung darüber — eine Abfrage, die nichts findet, wäre
      // auch grün, wenn die Tafel gar nichts gezeichnet hätte.
      assert.deepEqual(
        [...mounted.container.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")),
        [],
        "im Baum der Tafel steht ein Testgriff"
      );
      assert.deepEqual(
        [...mounted.container.querySelectorAll("[aria-describedby]")].map((el) =>
          el.getAttribute("aria-describedby")
        ),
        [],
        "im Baum der Tafel steht ein Verweis auf einen Hinweis"
      );
    } finally {
      await mounted.unmount();
      server.restore();
    }
  });
}
