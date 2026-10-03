import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";

import type { TerminalLook, TerminalSize, TerminalSurface } from "./terminal-look";

// Die EINZIGE Datei des Bestands, die `@xterm` anfasst (Paket B6, Etappe E6,
// #5). Sie wird NACHGELADEN und steht deshalb allein in ihrem eigenen Bündel.
//
// ── DIE ZWEI ABHÄNGIGKEITEN UND WARUM GENAU DIESE ZWEI ─────────────────────
//
// AGENTS.md: eine Abhängigkeit wird BEGRÜNDET, nicht bemerkt.
//
//   * `@xterm/xterm` (6.0.0) — der Terminal-Emulator selbst. Ein Terminal ist
//     kein Textfeld: es sind Steuersequenzen, ein Zellenraster, ein
//     Zeilenpuffer, eine Cursorstellung, Auswahl und Rollverlauf. Das von Hand
//     zu bauen hieße, den VT100-Zeichensatz nachzubilden — die Sorte Arbeit,
//     bei der jedes fehlende Prozent als Zeichensalat im Bild landet. Es ist
//     zudem die Fassung, die der Entwurf des Hubs nennt, und die, gegen die
//     `tokens.css` (Hex statt oklch) und `presets.ts` (Zahl statt „13px")
//     schon gebaut sind.
//   * `@xterm/addon-fit` (0.11.0) — rechnet aus der Pixelgröße des Knotens die
//     Zellengröße. Ohne es müsste der Reiter Zeichenbreite und Zeilenhöhe
//     selbst messen; das ist genau die Rechnung, die bei jeder Schriftart und
//     jeder Zoomstufe anders ausgeht.
//
// KEINE WEITEREN ADDONS. Weder WebGL noch Canvas noch „web-links": der
// DOM-Renderer reicht für eine Shell, und jedes weitere Paket wäre eines mehr
// im nachgeladenen Bündel und eines mehr, das ein Mensch bei jeder Fassung
// nachziehen muss.
//
// ⚠️ DIE FASSUNGEN STEHEN OHNE BEREICHSZEICHEN IN `web/package.json`, und das
// hält KEIN Wächter: `web/tests/vendored-origin.test.mjs:463` prüft nur die
// Ritus-Pakete, und seine Importsperre gilt nur unter `web/src/platform/ui`. Ein
// `^6.0.0` bliebe grün und holte beim nächsten Install eine Fassung, gegen die
// die 48 ANSI-Werte nicht gemessen sind.
//
// ── DIE CSS STEHT HIER UND NICHT IN `web/src/styles.css` ────────────────────
//
// `@xterm/xterm/css/xterm.css` ist ein FREMDES Blatt. In `styles.css` wäre es
// zweimal falsch: es lüde für jeden Menschen, der nie eine Shell öffnet, und es
// stellte eine Datei, die uns nicht gehört, unter die Aufsicht von
// `web/tests/design-tokens.test.mjs` — jener liest `styles.css` und lässt dort
// nur Importzeilen zu. Hier hängt sie am nachgeladenen Bündel und kommt mit
// ihm.
//
// ── WIE `@xterm` FARBEN LIEST, GEMESSEN STATT VERMUTET ─────────────────────
//
// Diese Fassung parst eine Farbe über eine 2D-LEINWAND, wenn es eine gibt.
// Das hat zwei Folgen, und beide sind am 2026-09-08 gemessen (5.5.0, für
// 6.0.0 am 2026-10-03 mit denselben Werten wiederholt) — gegen die
// INNERE Farbtafel (`_core._themeService.colors`, Feld `rgba`) und nicht
// gegen das Echo von `terminal.options.theme`, das nur zurückgibt, was man
// hineingelegt hat.
//
// (1) IN EINEM ECHTEN BROWSER KOMMT FAST ALLES AN. Gemessen in Chromium 1194
//     über Playwright, mit den echten Werten aus `tokens.css`:
//
//       oklch(0.165 0.008 265)      → rgba 0x0d0e12ff   genommen
//       oklch(0.945 0.005 265)      → rgba 0xebedf0ff   genommen
//       rgb(249, 131, 124)          → rgba 0xf9837cff   genommen
//       oklch(0.7 0.1 265 / 0.45)   → rgba 0xffffff4d   VERWORFEN
//
//     Die letzte Zeile ist die Ausnahme und sie ist teuer: das ist die
//     AUSWAHL, und `0xffffff4d` ist `@xterm`s eigene Vorgabe. Eine
//     oklch-Farbe MIT Deckung kommt nicht an; ohne Deckung schon.
//
// (2) OHNE 2D-LEINWAND FÄLLT ALLES AUF DIE VORGABE ZURÜCK. Gemessen unter
//     happy-dom, das für `getContext("2d")` `null` liefert: `oklch(…)`,
//     `color(srgb …)` und die leere Zeichenkette werden dort ausnahmslos zu
//     `#000000` bzw. `#cc0000`. Hex und `rgb(…)` kommen weiterhin an.
//
// ⚠️ DIE ERSTE MESSUNG DIESER ETAPPE WAR DIE ZWEITE, UND SIE WURDE ZUERST
// FALSCH GELESEN: „`@xterm` verwirft oklch still" gilt für happy-dom und
// NICHT für den Browser. Der Satz stand schon in einem Commit-Text, bevor die
// Messung in Chromium ihn berichtigt hat. Er steht hier als Warnung: eine
// Messung am Prüfstand ist eine Aussage über den Prüfstand.
//
// Was bleibt, ist die Umrechnung in `terminal-theme.ts` — sie holt die
// Auswahl zurück und macht das Ergebnis unabhängig davon, ob `@xterm` intern
// eine Leinwand findet. Sie rechnet nicht selbst, sondern lässt den Browser
// einen Bildpunkt malen.

/**
 * Baut ein Terminal in `node` und gibt den Griff darauf zurück.
 *
 * ⚠️ `convertEol` STEHT AUS EINEM GEMESSENEN GRUND NICHT DA. Der Agent hängt
 * an einer echten PTY; die schickt `\r\n`. Ein `convertEol: true` machte aus
 * jedem `\n` zusätzlich ein `\r` und damit aus jeder Zeile zwei.
 */
export function createTerminalSurface(node: HTMLElement, look: TerminalLook): TerminalSurface {
  const terminal = new Terminal({
    fontSize: look.fontSize,
    scrollback: look.scrollback,
    theme: look.palette,
    // Die Schriftfamilie kommt aus dem Blatt des Hubs und nicht aus einer
    // zweiten Aufzählung hier: `--font-mono` trägt IBM Plex Mono samt
    // Rückfallkette, und `@xterm` nimmt sie als Zeichenkette entgegen.
    fontFamily: readFontFamily(node),
    // Ein Terminal ohne blinkenden Cursor sieht aus wie ein hängendes.
    cursorBlink: true,
    // ⚠️ Der DOM-Renderer und ausdrücklich kein WebGL. Er ist die Vorgabe von
    // `@xterm` und braucht kein weiteres Paket; für eine Shell, in der jemand
    // tippt, ist er schnell genug.
    allowProposedApi: false
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(node);

  return {
    write: (text) => terminal.write(text),
    onData: (handler) => {
      terminal.onData(handler);
    },
    apply: (next) => {
      // ⚠️ EINE ZUWEISUNG JE OPTION UND KEIN `terminal.options = { … }`.
      // `options` ist bei `@xterm` ein Proxy mit Settern; ein Ersetzen des
      // ganzen Objekts ginge an ihnen vorbei, und die Änderung käme im Bild
      // nicht an.
      terminal.options.fontSize = next.fontSize;
      terminal.options.scrollback = next.scrollback;
      terminal.options.theme = next.palette;
    },
    fit: (): TerminalSize | null => {
      // ⚠️ `proposeDimensions` UND NICHT `fit()` ALLEIN. `fit()` gibt nichts
      // zurück; der Aufrufer muss die neue Größe aber an den Arm melden, und
      // `terminal.cols` nach einem `fit()` wäre eine zweite Frage an dasselbe
      // Ergebnis. Hat der Knoten keine Größe (noch nicht gezeichnet,
      // ausgeblendet), liefert `proposeDimensions` `undefined` — dann wird
      // NICHT angepasst und nichts gemeldet.
      const proposed = fitAddon.proposeDimensions();
      if (proposed === undefined || proposed.cols < 1 || proposed.rows < 1) return null;
      fitAddon.fit();
      return { cols: terminal.cols, rows: terminal.rows };
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose()
  };
}

/**
 * Die Schriftfamilie der Umgebung, in der das Terminal hängt.
 *
 * Der Rückfall ist die Gattung und kein Name: eine hier hingeschriebene
 * Schriftliste wäre die zweite Wahrheit neben `--font-mono`.
 */
function readFontFamily(node: HTMLElement): string {
  const computed = getComputedStyle(node).fontFamily;
  return computed === "" ? "monospace" : computed;
}
