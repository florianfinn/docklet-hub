// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// irgendetwas geladen wird, das ein `document` erwartet (siehe
// `dom-harness.tsx`).
import "./dom-harness.js";

import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

import { record, reset } from "./xterm-double.mjs";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// `web/src/features/shell/terminal-surface.ts` ist die einzige Datei
// des Bestands, die `@xterm` anfasst — 152 Zeilen, in denen die ganze
// Verdrahtung sitzt: `new Terminal`, `FitAddon`, `proposeDimensions`, `write`,
// `onData`, `terminal.options`, `dispose`.
//
// ⚠️ SIE WAR VON KEINEM EINZIGEN FALL BERÜHRT. Belegt von der unabhängigen
// Prüfung am 2026-09-08, mit ihrem Rohbefehl:
//
//     sed -i '93s/fontSize: look.fontSize,/fontSize: 999,/' \
//       web/src/features/shell/terminal-surface.ts
//     cd web && npx node --import tsx --test "tests/**/*.test.{mjs,tsx}"
//       → code=0, # tests 415 / # pass 415 / # fail 0
//
// Die Schriftgröße des Terminals fest auf 999, und die volle Web-Suite blieb
// grün. Alle Fälle fahren über den eingespeisten Lader `loadSurface` des
// Reiters und sehen die Datei nie. `terminal-theme.test.tsx` prüft die
// BERECHNUNG der Palette, `terminal-contrast.test.mjs` die Werte im
// Stylesheet — die Stelle, an der beides an `@xterm` übergeben wird, war die
// Lücke dazwischen.
//
// Sechs Fehler, jeder mit einem eigenen Fall:
//
//   1. EIN WERT WIRD GAR NICHT WEITERGEREICHT. Genau die Mutation der Prüfung:
//      eine feste Zahl statt `look.fontSize` ist gültiger Code.
//   2. EINE FESTE OPTION KIPPT. `cursorBlink`, `allowProposedApi` — und
//      `convertEol`, das aus einem gemessenen Grund NICHT dastehen darf: der
//      Agent hängt an einer echten PTY, ein `convertEol: true` machte aus
//      jeder Zeile zwei.
//   3. DIE SCHRIFT KOMMT AUS EINER ZWEITEN AUFZÄHLUNG statt aus `--font-mono`.
//      Eine hier hingeschriebene Schriftliste sähe im Bild richtig aus und
//      wäre die zweite Wahrheit neben dem Blatt des Hubs.
//   4. EINE ÄNDERUNG BAUT DAS TERMINAL NEU. Dann sind Verlauf UND Sitzung weg,
//      weil jemand die Schriftgröße umgestellt hat.
//   5. `fit` MELDET EINE GRÖSSE, DIE ES NICHT GIBT. Eine Fläche ohne Layout
//      liefert `undefined`; wer daraus 0×0 macht, schickt dem Arm eine
//      Falschmeldung.
//   6. DER GRIFF GIBT DAS TERMINAL HERAUS. `TerminalSurface` hat bewusst
//      keinen Durchgriff; was der Reiter nicht anfassen kann, kann er nicht
//      falsch anfassen.
//
// WIE GEPRÜFT WIRD, UND WAS DABEI ECHT IST
//
// Geprüft wird die ECHTE Datei: `terminal-surface.ts` wird unverändert geladen
// und ausgeführt. Doppel sind nur ihre beiden fremden Abhängigkeiten
// (`xterm-double.mjs`), umgebogen über registrierte Auflösungshaken
// (`xterm-stub-loader.mjs`, dort steht auch, warum die Datei sich ohne sie im
// Testlauf gar nicht laden lässt). Ein Test, der stattdessen eine nachgebaute
// Fläche prüfte, prüfte sich selbst — die Warnung dazu steht im Kopf von
// `log-view.test.tsx` und in `terminal-look.ts`.
//
// ⚠️ WAS OHNE ECHTEN BROWSER NICHT PRÜFBAR IST — und deshalb hier NICHT
// scheinbar abgedeckt wird. Eine ehrliche Lücke ist besser als ein Fall, der
// eine Attrappe prüft und ihren Namen trägt:
//
//   (a) OB `@xterm` DIE WERTE ANNIMMT UND ZEICHNET. Das Doppel nimmt jede
//       Option entgegen, auch eine erfundene. Der letzte Fall hält deshalb die
//       NAMEN gegen die echte Bibliothek (6.0.0, unter happy-dom gebaut) —
//       aber ob das Bild danach stimmt, sagt auch er nicht. Das hat die
//       Playwright-Messung aus Baustein 5 einmal gesehen; sie läuft in keiner
//       Kette mit (#96).
//   (b) DIE ECHTE RECHNUNG VON `proposeDimensions`. happy-dom hat kein
//       Layout: die echte `FitAddon` liefert dort `undefined`, gemessen im
//       letzten Fall. Damit ist der Weg „Knoten hat eine Größe → cols/rows"
//       nur gegen ein vorgelegtes Ergebnis geprüft, nicht gegen eine echte
//       Messung an Zeichenbreite und Zeilenhöhe.
//   (c) `terminal.open(node)` ALS ZEICHENVORGANG. Dass der Knoten ankommt,
//       hält der Fall über das Öffnen; was `@xterm` hineinbaut, sieht hier
//       niemand.
//   (d) DIE AUFLÖSUNG VON `--font-mono` DURCH DEN ECHTEN HUB. Der Fall über
//       die Schrift legt dafür ein eigenes Blatt vor. Dass der Reiter im
//       Bündel unter einem Knoten hängt, der `--font-mono` wirklich erbt, ist
//       eine Zusage der Kaskade und keine dieser Datei.

// ── Der Prüfstand ───────────────────────────────────────────────────────────

// Die ECHTE Bibliothek, geladen BEVOR die Haken sie umbiegen — der letzte Fall
// hält die Optionsnamen gegen sie.
//
// ⚠️ ALS DYNAMISCHER IMPORT UND NICHT ALS NAMENTLICHER OBEN, und der Grund ist
// gemessen: `import { Terminal } from "@xterm/xterm"` endet unter
// `node --import tsx` mit „SyntaxError: The requested module '@xterm/xterm'
// does not provide an export named 'Terminal'", derselbe Pfad als
// `await import(…)` liefert `[ 'Terminal' ]`. Die Ursache ist die
// CommonJS-Naht des Pakets; für diese Datei zählt nur, dass der eine Weg geht
// und der andere nicht. Er muss ohnehin VOR `register(…)` stehen.
const { Terminal: RealTerminal } = await import("@xterm/xterm");
const { FitAddon: RealFitAddon } = await import("@xterm/addon-fit");

// Ab hier sieht jeder weitere Import die Doppel.
register("./xterm-stub-loader.mjs", import.meta.url, {
  data: { doubleUrl: new URL("./xterm-double.mjs", import.meta.url).href }
});

const { createTerminalSurface } = await import("../src/features/shell/terminal-surface.js");

// Das Blatt des Prüfstands. `--font-mono` steht im echten Hub in
// `web/src/platform/theme/palette.css`; hier steht ein eigener Wert, damit der Fall
// zeigt, dass die Datei ABLIEST statt zu raten — und nicht, dass der Hub eine
// bestimmte Schrift führt.
const PROBE_FONT = '"Probe Mono", monospace';
const sheet = document.createElement("style");
sheet.textContent = `:root { --font-mono: ${PROBE_FONT}; } .terminal-probe { font-family: var(--font-mono); }`;
document.head.append(sheet);

const PALETTE = {
  background: "#101114",
  foreground: "#e7e9ec",
  cursor: "#e7e9ec",
  black: "#3b3d41",
  red: "#f9837c",
  brightWhite: "#f4f5f7"
};

const LOOK = { fontSize: 13, scrollback: 5000, palette: PALETTE };

/** Ein Knoten am Dokument, der `--font-mono` erbt. */
function mountedNode() {
  const node = document.createElement("div");
  node.className = "terminal-probe";
  document.body.append(node);
  return node;
}

/**
 * Baut eine Fläche und gibt alles zurück, was der Fall danach ansehen will.
 *
 * ⚠️ `reset()` steht HIER und nicht in einem `beforeEach`: ein Verzeichnis,
 * das über Fälle hinweg wächst, ließe einen Fall grün werden, weil ein anderer
 * vorher etwas gebaut hat.
 */
function build(look = LOOK, node = mountedNode()) {
  reset();
  const surface = createTerminalSurface(node, look);
  assert.equal(record.terminals.length, 1, "es wurde nicht genau ein Terminal gebaut");
  assert.equal(record.fitAddons.length, 1, "es wurde nicht genau eine FitAddon gebaut");
  return { surface, node, terminal: record.terminals[0], fitAddon: record.fitAddons[0] };
}

// ── Die Fälle ───────────────────────────────────────────────────────────────

test("der Prüfstand fasst die echte Datei an und nicht eine nachgebaute", () => {
  // FÄNGT: einen Lader, der still nicht greift. Ohne diesen Fall sähe ein Lauf,
  // in dem `terminal-surface.ts` gar nicht geladen wurde, genauso aus wie
  // einer, in dem alles stimmt — dieselbe Bauart wie „der Wächter liest
  // überhaupt etwas" in `terminal-contrast.test.mjs`.
  assert.equal(typeof createTerminalSurface, "function", "die geprüfte Datei wurde nicht geladen");

  const { terminal, fitAddon } = build();
  assert.equal(terminal.constructor.name, "TerminalDouble", "das Doppel wurde nicht eingesetzt");
  assert.equal(fitAddon.constructor.name, "FitAddonDouble", "das Doppel wurde nicht eingesetzt");
  assert.notEqual(RealTerminal, terminal.constructor, "die echte Klasse und das Doppel sind dieselbe");
});

test("die drei Werte des Aussehens kommen unverändert bei @xterm an", () => {
  // FÄNGT: genau die Mutation der unabhängigen Prüfung (`fontSize: 999`) und
  // ihre zwei Geschwister. Die Zahlen kommen aus `TERMINAL_SIZE_STEPS` und
  // `TERMINAL_SCROLLBACK_STEPS`; wer sie hier durch ein Literal ersetzt, macht
  // die ganze Stellschraube wirkungslos, ohne dass etwas anderes rot wird.
  const { terminal } = build();
  assert.equal(terminal.given.fontSize, LOOK.fontSize, "die Schriftgröße kommt nicht aus dem Aussehen");
  assert.equal(terminal.given.scrollback, LOOK.scrollback, "der Rollverlauf kommt nicht aus dem Aussehen");
  assert.ok(terminal.given.theme === PALETTE, "die Palette wird nicht unverändert durchgereicht");

  // Und mit anderen Werten noch einmal: ein festes `fontSize: 13` im Code
  // bestünde den Fall oben, weil 13 zufällig der Vorgabewert ist.
  const other = build({ fontSize: 20, scrollback: 1000, palette: PALETTE });
  assert.equal(other.terminal.given.fontSize, 20, "die Schriftgröße ist festgenagelt");
  assert.equal(other.terminal.given.scrollback, 1000, "der Rollverlauf ist festgenagelt");
});

test("die festen Optionen stehen, und convertEol steht ausdrücklich nicht da", () => {
  // FÄNGT: ein `convertEol: true`. Der Agent hängt an einer echten PTY, die
  // `\r\n` schickt; ein `convertEol` machte aus jedem `\n` zusätzlich ein `\r`
  // und damit aus jeder Zeile zwei. Der Grund steht als Kommentar über der
  // Funktion — bis heute hielt ihn nichts.
  const { terminal } = build();
  assert.equal(terminal.given.cursorBlink, true, "ein Terminal ohne blinkenden Cursor sieht aus wie ein hängendes");
  assert.equal(terminal.given.allowProposedApi, false, "der DOM-Renderer, ausdrücklich kein WebGL");
  assert.ok(!("convertEol" in terminal.given), "convertEol steht aus einem gemessenen Grund nicht da");

  // Die vollständige Liste der Optionen, die diese Datei setzt. Eine siebte,
  // die jemand dazustellt, ohne sie zu begründen, wird hier rot — dieselbe
  // Bauart wie eine Ankertabelle: der Bestand steht namentlich da.
  assert.deepEqual(
    Object.keys(terminal.given).sort(),
    ["allowProposedApi", "cursorBlink", "fontFamily", "fontSize", "scrollback", "theme"],
    "die Datei setzt eine andere Menge an Optionen als hier steht"
  );
});

test("die Schriftfamilie kommt aus dem Knoten und nicht aus einer zweiten Aufzählung", () => {
  // FÄNGT: eine hier hingeschriebene Schriftliste. Sie sähe im Bild richtig
  // aus und wäre die zweite Wahrheit neben `--font-mono`.
  const { terminal } = build();
  assert.equal(terminal.given.fontFamily, PROBE_FONT, "die Schrift kommt nicht aus dem Knoten");

  // Und der Rückfall. Er ist die Gattung und kein Name — ein Name hier wäre
  // dieselbe zweite Wahrheit noch einmal.
  //
  // ⚠️ Der Knoten hängt dafür NICHT am Dokument: `getComputedStyle` liefert für
  // ihn unter happy-dom die leere Zeichenkette (gemessen am 2026-09-08; ein
  // Knoten AM Dokument bekommt dort immer eine Vorgabe). Das ist eine
  // Eigenschaft von happy-dom und nicht die des Browsers — der Zweig ist damit
  // erreicht, seine Alltagshäufigkeit ist damit nicht behauptet.
  const loose = document.createElement("div");
  const fallback = build(LOOK, loose);
  assert.equal(fallback.terminal.given.fontFamily, "monospace", "der Rückfall ist nicht die Gattung");
});

test("das Terminal wird in den übergebenen Knoten geöffnet, mit genau einem Addon", () => {
  const { terminal, fitAddon, node } = build();
  assert.equal(terminal.addons.length, 1, "es hängt nicht genau ein Addon am Terminal");
  assert.ok(terminal.addons[0] === fitAddon, "das geladene Addon ist nicht die FitAddon");
  assert.equal(terminal.opened.length, 1, "das Terminal wurde nicht genau einmal geöffnet");
  // ⚠️ Verglichen wird ein Wahrheitswert und nicht der Knoten: `assert.equal`
  // gegen einen DOM-Knoten reicht bei ROT den halben Fensterbaum an die
  // Fehlerausgabe, und der Lauf stirbt daran (zweimal gemessen am 2026-09-07).
  assert.ok(terminal.opened[0] === node, "das Terminal wurde in einen anderen Knoten geöffnet");
});

test("apply setzt am lebenden Terminal — je Option einzeln, ohne Neubau", () => {
  // FÄNGT ZWEIERLEI. Erstens einen Neubau: dann wären Verlauf UND Sitzung weg,
  // weil jemand die Schriftgröße umgestellt hat. Zweitens ein
  // `terminal.options = { … }` — bei `@xterm` ist `options` ein Objekt mit
  // Settern je Feld, ein Ersetzen ginge an ihnen vorbei und käme im Bild nicht
  // an. Das Doppel hat für `options` bewusst nur einen Leser; die Zuweisung
  // wirft dort, statt still durchzulaufen.
  const { surface, terminal } = build();
  const next = { fontSize: 17, scrollback: 250, palette: { background: "#ffffff" } };
  surface.apply(next);

  assert.equal(record.terminals.length, 1, "apply hat ein zweites Terminal gebaut");
  assert.deepEqual(
    terminal.assigned.map(([key]) => key),
    ["fontSize", "scrollback", "theme"],
    "apply setzt eine andere Menge an Optionen als die drei des Aussehens"
  );
  assert.equal(terminal.options.fontSize, 17, "die neue Schriftgröße kommt nicht an");
  assert.equal(terminal.options.scrollback, 250, "der neue Rollverlauf kommt nicht an");
  assert.ok(terminal.options.theme === next.palette, "die neue Palette kommt nicht an");
});

test("fit meldet nichts, wenn die Fläche keine messbare Größe hat", () => {
  // FÄNGT: eine Fassung, die aus `undefined` ein 0×0 macht. Der Aufrufer
  // schickte dem Arm dann eine Größe, die es nicht gibt — eine Falschmeldung
  // und keine Auskunft.
  const nothing = build();
  nothing.fitAddon.proposal = undefined;
  assert.equal(nothing.surface.fit(), null, "ohne Vorschlag wird trotzdem etwas gemeldet");
  assert.equal(nothing.fitAddon.fitCount, 0, "ohne Vorschlag wird trotzdem angepasst");

  // Und die zwei Grenzfälle daneben, die `undefined` nicht abdeckt: ein
  // Vorschlag mit 0 Spalten oder 0 Zeilen ist dieselbe Nichtgröße in anderer
  // Form.
  const noColumns = build();
  noColumns.fitAddon.proposal = { cols: 0, rows: 30 };
  assert.equal(noColumns.surface.fit(), null, "0 Spalten gelten als Größe");
  assert.equal(noColumns.fitAddon.fitCount, 0, "bei 0 Spalten wird trotzdem angepasst");

  const noLines = build();
  noLines.fitAddon.proposal = { cols: 100, rows: 0 };
  assert.equal(noLines.surface.fit(), null, "0 Zeilen gelten als Größe");
  assert.equal(noLines.fitAddon.fitCount, 0, "bei 0 Zeilen wird trotzdem angepasst");
});

test("fit passt an und meldet die Größe des Terminals, nicht den Vorschlag", () => {
  // FÄNGT: ein `return proposed`. Der Vorschlag ist die RECHNUNG, `cols`/`rows`
  // sind das ERGEBNIS — sie können auseinanderliegen, und gemeldet wird, was
  // das Terminal danach wirklich hat. Das Doppel legt die zwei absichtlich
  // verschieden hin; ohne diesen Unterschied wären beide Fassungen gleich grün.
  const { surface, fitAddon } = build();
  fitAddon.proposal = { cols: 111, rows: 41 };
  fitAddon.afterFit = { cols: 110, rows: 40 };

  assert.deepEqual(surface.fit(), { cols: 110, rows: 40 }, "gemeldet wird nicht die Größe des Terminals");
  assert.equal(fitAddon.fitCount, 1, "es wurde nicht genau einmal angepasst");
  assert.equal(fitAddon.proposeCount, 1, "der Vorschlag wurde nicht genau einmal geholt");
});

test("write, onData, focus und dispose reichen durch, und das Terminal bleibt drinnen", () => {
  const { surface, terminal } = build();

  surface.write("erste Zeile");
  surface.write("zweite Zeile");
  assert.deepEqual(terminal.written, ["erste Zeile", "zweite Zeile"], "die Ausgabe kommt nicht am Terminal an");

  const arrived = [];
  surface.onData((data) => arrived.push(data));
  assert.equal(terminal.dataHandlers.length, 1, "es wurde nicht genau ein Empfänger angemeldet");
  terminal.dataHandlers[0]("ls\r");
  assert.deepEqual(arrived, ["ls\r"], "der Tastenanschlag kommt nicht beim Aufrufer an");

  surface.focus();
  assert.equal(terminal.focusCount, 1, "focus reicht nicht durch");
  surface.dispose();
  assert.equal(terminal.disposeCount, 1, "dispose reicht nicht durch");

  // ⚠️ KEIN DURCHGRIFF AUF DAS `Terminal`-OBJEKT (`terminal-look.ts`). Was hier
  // nicht steht, kann der Reiter nicht anfassen — und was er nicht anfasst,
  // muss kein Doppel nachbilden.
  assert.deepEqual(
    Object.keys(surface).sort(),
    ["apply", "dispose", "fit", "focus", "onData", "write"],
    "der Griff gibt mehr heraus als die sechs Zusagen von TerminalSurface"
  );
});

test("die Optionsnamen sind die von @xterm 6.0.0 und nicht erfunden", () => {
  // ⚠️ DER EINZIGE FALL DIESER DATEI, DER DIE ECHTE BIBLIOTHEK ANFASST — und
  // er ist nötig, weil ein Doppel jede Option entgegennimmt, auch eine
  // erfundene. Ein `fontSizes` statt `fontSize` bestünde jeden Fall oben und
  // käme im Browser nie an. Hier baut die echte Klasse (oben geladen, VOR den
  // Haken) mit derselben Optionsmenge und wird gefragt, was sie davon kennt.
  const genuine = new RealTerminal({
    fontSize: LOOK.fontSize,
    scrollback: LOOK.scrollback,
    theme: PALETTE,
    fontFamily: PROBE_FONT,
    cursorBlink: true,
    allowProposedApi: false
  });
  try {
    assert.equal(genuine.options.fontSize, LOOK.fontSize, "@xterm kennt fontSize nicht unter diesem Namen");
    assert.equal(genuine.options.scrollback, LOOK.scrollback, "@xterm kennt scrollback nicht unter diesem Namen");
    assert.equal(genuine.options.fontFamily, PROBE_FONT, "@xterm kennt fontFamily nicht unter diesem Namen");
    assert.equal(genuine.options.cursorBlink, true, "@xterm kennt cursorBlink nicht unter diesem Namen");
    assert.equal(genuine.options.allowProposedApi, false, "@xterm kennt allowProposedApi nicht unter diesem Namen");
    // Die Vorgabe, auf die sich der Kommentar an `createTerminalSurface`
    // beruft: `convertEol` ist von sich aus aus. Das Weglassen ist damit
    // wirklich die Zusage „eine Zeile bleibt eine Zeile".
    assert.equal(genuine.options.convertEol, false, "convertEol ist nicht von sich aus aus");
    // Und die Einzelzuweisung, auf die sich `apply` verlässt.
    genuine.options.fontSize = 19;
    assert.equal(genuine.options.fontSize, 19, "eine Zuweisung je Option kommt bei @xterm nicht an");

    // ⚠️ LÜCKE (b) AUS DEM KOPF, hier als Messung und nicht als Behauptung:
    // ohne Layout liefert die echte FitAddon `undefined` — genau der Zustand,
    // den `fit()` mit `null` beantwortet. Der Weg mit einer echten Größe ist
    // damit unter happy-dom nicht erreichbar.
    const fitter = new RealFitAddon();
    genuine.loadAddon(fitter);
    assert.equal(
      fitter.proposeDimensions(),
      undefined,
      "happy-dom hat plötzlich ein Layout — dann gehört Lücke (b) im Kopf berichtigt"
    );
  } finally {
    genuine.dispose();
  }
});
