// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GLOBAL_THEME,
  TERMINAL_SCROLLBACK_STEPS,
  TERMINAL_SIZE_STEPS,
  type GlobalThemePreset
} from "contract";
import { GlobalThemeProvider, useGlobalTheme } from "../src/features/appearance/index.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ShellWithTheme } from "./shell-harness.js";
import type {
  SurfaceLoader,
  TerminalLook,
  TerminalSize,
  TerminalSurface
} from "../src/features/shell/terminal-look.js";
import {
  canvasColorConverter,
  readTerminalPalette,
  TERMINAL_COLOR_TOKENS,
  type ColorConverter
} from "../src/features/shell/terminal-theme.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Farben und Maße des Terminals (Paket B6, Etappe E6, #5) sind der Teil
// dieses Reiters, an dem ein Fehler AUSSIEHT WIE EINE ENTSCHEIDUNG. Ein
// Terminal, das schwarz auf Schwarz zeichnet oder in `@xterm`s eigenem Rot
// statt in dem gemessenen, sieht auf keinem Bild nach einem Fehler aus — es
// sieht nach einem anderen Theme aus.
//
// Vier Fehler, jeder mit einem eigenen Fall:
//
//   1. DER WERT WIRD GAR NICHT ABGELESEN. Eine Fassung, die `@xterm` ohne
//      `theme` baut, ist gültiger Code und ein grüner Lauf.
//   2. DER WERT WIRD ABGELESEN UND KOMMT NICHT AN. Gemessen in Chromium
//      (siehe den Kopf von `terminal-theme.ts`): die AUSWAHL, in `tokens.css`
//      ein oklch-Wert MIT Deckung, kommt bei `@xterm` 6.0.0 nicht an — dort
//      steht danach dessen eigene weiße Vorgabe über dem Text. Ein Umrechner,
//      der einen Wert nicht versteht, darf ihn deshalb WEGLASSEN statt ihn
//      durchzureichen: ein fehlender Eintrag lässt `@xterm` bei seiner
//      Vorgabe, ein unverständlicher kann Schwarz daraus machen.
//   3. DIE ZAHLEN KOMMEN AUS DEM CSS. `--terminal-size` trägt „13px";
//      `@xterm` will eine Zahl. Ein `parseInt` darauf wäre die zweite
//      Wahrheit neben `TERMINAL_SIZE_STEPS`.
//   4. EINE ÄNDERUNG BAUT DAS TERMINAL NEU. Dann wären Verlauf UND Sitzung
//      weg, weil jemand die Schriftgröße umgestellt hat.
//
// ⚠️ WAS DIESE DATEI NICHT PRÜFEN KANN: ob `@xterm` die Werte am Ende
// annimmt. Der echte Umrechner braucht eine 2D-Leinwand, und happy-dom gibt
// für `canvas.getContext("2d")` `null` zurück (gemessen am 2026-09-08). Der
// Fall unten hält deshalb fest, dass der Rückfall in diesem Zustand der
// EHRLICHE ist — der abgelesene Wert geht unverändert hinaus —, und der
// echte Weg ist mit Playwright in einem Chromium gemessen; das Ergebnis steht
// in der Rückmeldung dieser Etappe.

const TOKEN_SHEET = `
:root {
  --terminal-sunken: #16181c;
  --terminal-surface: var(--terminal-sunken);
  --terminal-foreground: #f0f1f3;
  --terminal-cursor: #f0f1f3;
  --terminal-selection: #334466;
  --terminal-ansi-black: #3b3d41;
  --terminal-ansi-red: #f9837c;
  --terminal-ansi-green: #6bc26f;
  --terminal-ansi-yellow: #cea51d;
  --terminal-ansi-blue: #7caaff;
  --terminal-ansi-magenta: #dd87d6;
  --terminal-ansi-cyan: #0cc3c3;
  --terminal-ansi-white: #cfd1d4;
  --terminal-ansi-bright-black: #67696e;
  --terminal-ansi-bright-red: #ffbfb8;
  --terminal-ansi-bright-green: #a1e5a2;
  --terminal-ansi-bright-yellow: #eece74;
  --terminal-ansi-bright-blue: #b9d2fe;
  --terminal-ansi-bright-magenta: #fcb5f5;
  --terminal-ansi-bright-cyan: #65e9e8;
  --terminal-ansi-bright-white: #f4f5f7;
}
`;

/** Das Blatt anhängen und den Weg zurück mitgeben. */
function withTokens(): () => void {
  const style = document.createElement("style");
  style.textContent = TOKEN_SHEET;
  document.head.appendChild(style);
  return () => style.remove();
}

// ── 1. Der Leser: liest er überhaupt, und liest er das Richtige? ────────────

test("die Palette kommt aus den Token und nicht aus dieser Datei", () => {
  const restore = withTokens();
  const probe = document.createElement("span");
  document.body.appendChild(probe);

  try {
    const palette = readTerminalPalette(probe, null);

    // ⚠️ EINUNDZWANZIG UND NICHT „EINIGE". Ein Leser, der die Hälfte findet,
    // liefert eine plausible Palette, und die fehlende Hälfte kommt aus
    // `@xterm`s Vorgabe — ohne dass irgendetwas rot wird.
    assert.equal(
      Object.keys(palette).length,
      TERMINAL_COLOR_TOKENS.length,
      `gelesen wurden ${Object.keys(palette).length} Farben von ${TERMINAL_COLOR_TOKENS.length}`
    );

    // Ein ANSI-Ton, wörtlich aus dem Blatt.
    assert.equal(palette.red, "#f9837c");
    assert.equal(palette.brightWhite, "#f4f5f7");
    // ⚠️ DER ALIAS. `--terminal-surface` zeigt auf `--terminal-sunken`; der
    // GERECHNETE Wert ist die Farbe und nicht die Kette. Ein Leser über
    // `getPropertyValue("--terminal-surface")` bekäme hier
    // „var(--terminal-sunken)" — eine Zeichenkette, die `@xterm` still
    // verwirft.
    assert.equal(palette.background, "#16181c", "der Alias ist nicht aufgelöst worden");
    // Der Blockcursor braucht die FLÄCHE unter sich und nicht den
    // Vordergrund: sonst steht das Zeichen unter dem Cursor unsichtbar da.
    assert.equal(palette.cursorAccent, "#16181c");
    assert.notEqual(palette.cursorAccent, palette.cursor);
  } finally {
    probe.remove();
    restore();
  }
});

test("das Ableseelement bleibt nicht auf der letzten Farbe stehen", () => {
  const restore = withTokens();
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  try {
    readTerminalPalette(probe, null);
    assert.equal(probe.style.color, "", "das Messgerät ist zur Fläche geworden");
  } finally {
    probe.remove();
    restore();
  }
});

// ── 2. Was der Browser nicht versteht, fehlt — und wird nicht erfunden ──────

test("ein Wert, den der Umrechner verwirft, FEHLT in der Palette", () => {
  // ⚠️ DER FALL, DER IM BROWSER WIRKLICH EINTRITT. `--terminal-selection` ist
  // in `tokens.css` ein oklch-Wert MIT Deckung; `getComputedStyle` gibt ihn
  // als `oklch(0.7 0.1 265 / 0.45)` zurück, und gemessen in Chromium kommt er
  // bei `@xterm` 6.0.0 NICHT an — dort steht danach dessen weiße Vorgabe.
  // Was der Umrechner nicht umrechnen kann, darf deshalb nicht durchgereicht
  // werden: ein fehlender Eintrag lässt `@xterm` bei seiner Vorgabe, ein
  // unverständlicher kann daraus Schwarz machen.
  const restore = withTokens();
  const probe = document.createElement("span");
  document.body.appendChild(probe);

  // Ein Umrechner, der genau eine Farbe nicht versteht.
  const stubborn: ColorConverter = (value) => (value === "#f9837c" ? null : value.toUpperCase());

  try {
    const palette = readTerminalPalette(probe, stubborn);
    assert.equal("red" in palette, false, "der unverständliche Wert steht trotzdem in der Palette");
    assert.equal(palette.green, "#6BC26F", "der Umrechner ist gar nicht gefragt worden");
    assert.equal(
      Object.keys(palette).length,
      TERMINAL_COLOR_TOKENS.length - 1,
      "es fehlt mehr als der eine verworfene Wert"
    );
  } finally {
    probe.remove();
    restore();
  }
});

test("ohne 2D-Leinwand gibt es keinen Umrechner — und das ist der ehrliche Rückfall", () => {
  // ⚠️ EINE MESSUNG DES PRÜFSTANDS UND KEINE ZUSAGE ÜBER DEN BROWSER.
  // happy-dom gibt für `canvas.getContext("2d")` `null` zurück; der echte
  // Umrechner ist hier also gar nicht zu haben. Dieser Fall hält fest, dass
  // die Fläche das WEISS und in den dokumentierten Rückfall geht, statt an
  // einem `null` zu scheitern.
  assert.equal(
    canvasColorConverter(),
    null,
    "happy-dom hat plötzlich eine 2D-Leinwand — dann gehört der echte Umrechner hier geprüft " +
      "statt in einem Chromium daneben"
  );
});

// ── 3. Die Zahlen kommen aus presets.ts und nicht aus dem CSS ───────────────

type FakeSurface = TerminalSurface & { looks: TerminalLook[] };

function surfaceLab(): { load: SurfaceLoader; built: FakeSurface[] } {
  const built: FakeSurface[] = [];
  const load: SurfaceLoader = () =>
    Promise.resolve({
      createTerminalSurface: (_node, look) => {
        const looks: TerminalLook[] = [look];
        const surface: FakeSurface = {
          looks,
          write: () => undefined,
          onData: () => undefined,
          apply: (next) => looks.push(next),
          fit: (): TerminalSize | null => ({ cols: 80, rows: 24 }),
          focus: () => undefined,
          dispose: () => undefined
        };
        built.push(surface);
        return surface;
      }
    });
  return { load, built };
}

/** Ein Griff auf den Anbieter, damit der Test das Theme umstellen kann. */
function ThemeHandle({ onReady }: { onReady: (apply: (theme: GlobalThemePreset) => void) => void }) {
  const { preview } = useGlobalTheme();
  React.useEffect(() => {
    onReady(preview);
  }, [onReady, preview]);
  return null;
}

function pixelsOf(name: string): number {
  const step = TERMINAL_SIZE_STEPS.find((entry) => entry.name === name);
  assert.ok(step, `die Stufe „${name}“ gibt es in TERMINAL_SIZE_STEPS nicht`);
  return step.pixels;
}

function linesOf(name: string): number {
  const step = TERMINAL_SCROLLBACK_STEPS.find((entry) => entry.name === name);
  assert.ok(step, `die Stufe „${name}“ gibt es in TERMINAL_SCROLLBACK_STEPS nicht`);
  return step.lines;
}

test("Schriftgröße und Verlauf kommen als ZAHL aus presets.ts", async () => {
  const restore = withTokens();
  const surfaces = surfaceLab();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <GlobalThemeProvider>
        <ShellWithTheme hostId="host-1" containerId="container-1" load={surfaces.load} observeSize={() => () => undefined} />
      </GlobalThemeProvider>
    </AppLanguageProvider>
  );
  await settle();

  try {
    const surface = surfaces.built[0];
    assert.ok(surface, "das Terminal ist gar nicht gebaut worden");
    const look = surface.looks[surface.looks.length - 1];

    // ⚠️ GEGEN `presets.ts` UND NICHT GEGEN EINE ZAHL IM TEST. Eine hier
    // abgetippte 13 wäre dieselbe zweite Wahrheit, gegen die dieser Fall
    // steht.
    assert.equal(look.fontSize, pixelsOf(DEFAULT_GLOBAL_THEME.terminalSize));
    assert.equal(look.scrollback, linesOf(DEFAULT_GLOBAL_THEME.terminalScrollback));
    // ⚠️ EINE ZAHL UND KEINE ZEICHENKETTE. `--terminal-size` trägt „13px";
    // `@xterm` nimmt eine Zahl und verwirft alles andere still.
    assert.equal(typeof look.fontSize, "number");
    assert.equal(typeof look.scrollback, "number");
    // Und die Farben sind mitgekommen — sonst prüfte der Fall darunter nichts.
    assert.equal(look.palette.red, "#f9837c");
  } finally {
    await mounted.unmount();
    restore();
  }
});

// ── 4. Eine Änderung setzt die Optionen neu und baut NICHT neu ──────────────

test("ein Wechsel der Schriftgröße setzt die Optionen neu, ohne das Terminal neu zu bauen", async () => {
  const restore = withTokens();
  const surfaces = surfaceLab();
  const handle: { apply: ((theme: GlobalThemePreset) => void) | null } = { apply: null };

  const mounted = await renderInDom(
    <AppLanguageProvider>
      <GlobalThemeProvider>
        <ThemeHandle
          onReady={(apply) => {
            handle.apply = apply;
          }}
        />
        <ShellWithTheme hostId="host-1" containerId="container-1" load={surfaces.load} observeSize={() => () => undefined} />
      </GlobalThemeProvider>
    </AppLanguageProvider>
  );
  await settle();

  try {
    const surface = surfaces.built[0];
    assert.ok(surface);
    assert.ok(handle.apply, "der Griff auf den Anbieter ist nicht angekommen");
    const before = surface.looks.length;

    const larger: GlobalThemePreset = { ...DEFAULT_GLOBAL_THEME, terminalSize: "large", terminalScrollback: "long" };
    await React.act(async () => {
      handle.apply?.(larger);
    });
    await settle();

    assert.equal(surfaces.built.length, 1, "die Änderung hat ein ZWEITES Terminal gebaut — Verlauf und Sitzung weg");
    assert.ok(surface.looks.length > before, "die Änderung ist gar nicht angekommen");

    const look = surface.looks[surface.looks.length - 1];
    assert.equal(look.fontSize, pixelsOf("large"));
    assert.equal(look.scrollback, linesOf("long"));
  } finally {
    await mounted.unmount();
    restore();
  }
});
