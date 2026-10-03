import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripCssComments } from "./strip-comments.mjs";

// Wächter über das Token-System aus D1 (#62), Vertrag
// `docs/design/hub-color-and-structure.md`, Abschnitt 8.
//
// Diese drei Dateien entstehen in D1 parallel zu diesem Wächter, in einem
// ANDEREN Bauabschnitt (Agent A). Solange sie fehlen oder noch im alten
// Stand stehen, MUSS dieser Test verständlich rot werden — mit einer
// Meldung, die die fehlende Datei nennt — und NICHT mit einem Absturz, der
// nur „Datei nicht gefunden" von Node selbst zeigt. Deshalb steht vor jeder
// Leseoperation eine eigene `assert.ok(existsSync(...))`.
//
// GEPRÜFT WIRD, sechs Zusicherungen, nicht mehr (Vertrag, Abschnitt 7):
//   1. jeder Tokenname aus der Liste unten ist irgendwo deklariert,
//   2. JEDES `var(--y)` in `tokens.css` UND `palette.css` zeigt auf ein
//      `--y`, das in einer der beiden Dateien deklariert ist — in JEDER
//      Regel, nicht nur in `@theme inline`: ein `--h` zu `--hh` verfälscht
//      in der Ableitungsregel von `palette.css` macht sonst die ganze
//      Palette unsichtbar, ohne dass ein einziges Zeichen rot wird,
//   3. die drei Zustandsfarben stehen fest (kein `var(--h)`, kein `var(--c)`)
//      — ALLE Deklarationen jedes Namens, nicht nur die erste,
//   4. kein Farbwert außerhalb von oklch (`#rrggbb`, `rgb(`, `hsl(`) in den
//      drei Theme-Dateien — mit EINER namentlichen Ausnahme seit B6/E4 (#5):
//      den sechzehn ANSI-Tönen des Terminals, die `@xterm` als Zeichenkette
//      liest und die es in oklch nicht parst. Der Grund steht am Fall selbst,
//      und die Ausnahme ist auf `--terminal-ansi-…` beschränkt,
//   5. `styles.css` trägt nur Importe,
//   6. jeder Attributwert in `tokens.css` UND `palette.css` (Kommentare
//      abgezogen, wie bei den übrigen fünf Prüfungen), mit oder ohne
//      Anführungszeichen, stammt aus dem englischen Vorrat — beide Dateien,
//      weil die Stellschrauben-Umschalter aus 4.2 (Sättigung, Rundung,
//      Dichte, Einrückung) in `tokens.css` stehen und die Ton-, Bereichs-
//      und Markenwerte aus 5.3–5.5 in `palette.css`.
//
// ⚠️ NICHT geprüft und bewusst so — diese Liste wurde einmal als
// unvollständig gemeldet (drei Lücken standen nicht dabei, obwohl zwei
// davon eine der sechs Zusicherungen umgingen); sie wird deshalb so genau
// geführt, wie sie tatsächlich ist, nicht so, wie sie beruhigend klingt:
//   - der HELLE Wertesatz — der entsteht in D7, nicht in D1 (Vertrag,
//     Abschnitt 4.4 und 9).
//   - die Reihenfolge der Zeilen in `@theme inline` — Abschnitt 4.3 des
//     Vertrags schreibt eine Reihenfolge vor, dieser Wächter hält nur, dass
//     keine Referenz ins Leere zeigt, nicht die Zeilenfolge.
//   - OB eine deklarierte Custom Property an der Stelle, an der sie benutzt
//     wird, über die Kaskade tatsächlich ankommt (Spezifität, welches
//     Attribut am Element wirklich gesetzt ist). Geprüft wird nur, ob der
//     Name irgendwo im Dateitext als `--name:` auftaucht — nicht, ob die
//     deklarierende Regel am Verwendungsort greift.
//   - Prüfung 3 liest nur `tokens.css`. Eine zusätzliche, dem Vertrag
//     widersprechende Deklaration von `--state-ok`, `--state-warn` oder
//     `--state-down` in `palette.css` sähe dieser Test nicht.
//   - `web/src/platform/theme/fonts.css` (Agent B) — das ist eine andere Fläche.
//   - ob die Werte selbst „richtig" aussehen (Kontrast, Geschmack) — das ist
//     das Artboard, nicht dieser Test.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const STYLES_PATH = "web/src/styles.css";
const TOKENS_PATH = "web/src/platform/theme/tokens.css";
const PALETTE_PATH = "web/src/platform/theme/palette.css";

// Liest eine Datei und meldet FEHLT verständlich, statt mit einer
// Node-eigenen ENOENT-Meldung abzustürzen. Die drei Theme-Dateien werden
// parallel gebaut (Agent A) und existieren in diesem Worktree möglicherweise
// noch nicht — das ist der Normalfall, kein Bug in diesem Test.
function readOrFail(relativePath) {
  const absolute = new URL(relativePath, `file://${ROOT}`);
  assert.ok(
    existsSync(absolute),
    `Datei fehlt: ${relativePath} (wird parallel in D1 gebaut — siehe Vertrag Abschnitt 1)`
  );
  return readFileSync(absolute, "utf8");
}

// ⚠️ `stripCssComments` und NICHT `stripComments` aus derselben Datei: hier
// werden nur `.css`-Dateien gelesen, und CSS kennt `//` nicht als Kommentar.
// Der Entferner gehört zur gelesenen Sprache — der JavaScript-Entferner führt
// einen Zeichenketten-Zustand mit, den ein `'` in deutscher Prosa innerhalb
// eines CSS-Kommentars aus dem Tritt brächte.
//
// Bis zum 2026-09-05 stand hier eine eigene dritte Fassung, die den Kommentar
// LÖSCHTE statt ihn durch ebenso viele Zeilenumbrüche zu ersetzen. Gemessen
// über `tokens.css`, `palette.css` und `styles.css`: beide Fassungen liefern
// nach Leerraum-Normalisierung denselben Text (3885/3885, 2133/2133,
// 112/112 Zeichen), dieser Wächter nennt ohnehin keine Zeilennummern — die
// Abweichung war also keine, sondern nur eine dritte Wahrheit über dieselbe
// Rechnung.

// Prüft, ob `--name:` als eigene Deklaration vorkommt — nicht als Teilstück
// eines längeren Namens (`--card` darf `--card-foreground` nicht treffen).
function declaresToken(content, name) {
  const pattern = new RegExp(`(?<![\\w-])${name}(?![\\w-])\\s*:`);
  return pattern.test(content);
}

// Abschnitt 4.1 des Vertrags — wörtlich aus `color-system.html` übernommen.
const ROOT_TOKENS = [
  "--background", "--foreground",
  "--card", "--card-foreground",
  "--popover", "--popover-foreground",
  "--secondary", "--secondary-foreground",
  "--muted", "--muted-foreground", "--subtle-foreground",
  "--border", "--input",
  "--state-ok", "--state-warn", "--state-down",
  "--destructive", "--destructive-foreground",
  "--sidebar", "--sidebar-foreground", "--sidebar-border",
  "--sidebar-primary", "--sidebar-primary-foreground",
  "--sidebar-accent", "--sidebar-accent-foreground", "--sidebar-ring"
];

// Abschnitt 4.2 des Vertrags — die Stellschrauben aus D0.
const KNOB_TOKENS = [
  "--chroma", "--radius",
  "--density-size", "--density-leading",
  "--stack-indent",
  "--font-sans-stack", "--font-mono-stack"
];

// Abschnitt 5.1 des Vertrags — die Ableitung aus dem Artboard.
const DERIVED_TOKENS = [
  "--primary", "--primary-foreground",
  "--accent", "--accent-firm", "--accent-strong", "--accent-line", "--accent-foreground",
  "--ring",
  "--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5",
  "--head-face", "--body-face",
  // Aus D7a (#62): die Kante der Host-Karte. Sie war vorher keine Variable —
  // die vier Bauteile trugen `border-accent-line` fest, damit war die Kante
  // IMMER getönt und die Stufe „nur Kante" von „keine Farbe" nicht zu
  // unterscheiden. Jetzt bekommt sie ihren Vorgabewert in der
  // Ableitungsregel und wird vom `[data-ink]`-Block überschrieben wie die
  // beiden Flächen auch.
  "--card-line",
  "--mark-face", "--mark-ink", "--mark-line"
];

// Aus D7a (#62): die Skalare des Schemas. Sie sind keine Farbe und keine
// Stellschraube im Sinne von 4.2, sondern die Zahlen, mit denen die Ableitung
// in `palette.css` rechnet — der helle Wertesatz setzt sie um, statt dieselben
// fünfzehn Formeln ein zweites Mal zu führen. Fehlt eine davon, rechnet jede
// Formel, die sie liest, mit einer ungültigen Farbe und fällt still auf „nicht
// gesetzt" zurück; Prüfung 2 sieht das nicht, weil sie nur fragt, ob der Name
// IRGENDWO deklariert ist — und genau das fragt diese Liste nun ausdrücklich.
const SCHEME_TOKENS = [
  "--tone-l", "--tone-ink-l", "--tone-ink-c", "--accent-ink-l",
  "--focus-chroma", "--chart-turn"
];

const ALL_TOKENS = [...ROOT_TOKENS, ...KNOB_TOKENS, ...DERIVED_TOKENS, ...SCHEME_TOKENS];

test("jeder Tokenname aus dem Vertrag (4.1, 4.2, 5.1) ist deklariert", () => {
  const declarations = stripCssComments(readOrFail(TOKENS_PATH) + "\n" + readOrFail(PALETTE_PATH));

  const missing = ALL_TOKENS.filter((name) => !declaresToken(declarations, name));
  assert.deepEqual(
    missing,
    [],
    `Nicht deklariert in tokens.css/palette.css:\n${missing.join("\n")}`
  );
});

test("keine var(--…)-Referenz in tokens.css oder palette.css zeigt ins Leere", () => {
  const files = {
    [TOKENS_PATH]: stripCssComments(readOrFail(TOKENS_PATH)),
    [PALETTE_PATH]: stripCssComments(readOrFail(PALETTE_PATH))
  };
  const declarations = files[TOKENS_PATH] + "\n" + files[PALETTE_PATH];

  assert.ok(
    /@theme\s+inline\s*\{/.test(files[TOKENS_PATH]),
    "tokens.css enthält keinen @theme-inline-Block (Vertrag, Abschnitt 4.3)"
  );

  // JEDES `var(--…)` in BEIDEN Dateien, egal in welcher Regel oder
  // Eigenschaft es steht — nicht nur innerhalb von `@theme inline`. Ein
  // unabhängiger Prüfer hat `var(--h)` zu `var(--hh)` in der
  // Ableitungsregel von `palette.css` verfälscht: 53/53 grün, Lint grün,
  // Bau grün, und jede `bg-primary`-Fläche rendert als `rgba(0,0,0,0)`,
  // weil die Prüfung vorher nur den `@theme-inline`-Block gelesen hat
  // (Nachtrag Leitstand). Eine Referenz kann in JEDER Deklaration stehen —
  // in `body { background: var(--background); }` genauso wie in
  // `--primary: oklch(0.78 var(--c) var(--h))` — deshalb wird der ganze
  // Dateiinhalt durchsucht, nicht nur Zeilen, die selbst eine
  // Custom-Property deklarieren.
  const findings = [];
  let referenceCount = 0;
  for (const [path, content] of Object.entries(files)) {
    for (const reference of content.matchAll(/var\(\s*(--[\w-]+)/g)) {
      referenceCount++;
      const target = reference[1];
      if (!declaresToken(declarations, target)) {
        findings.push(`${path}: var(${target}) ist nirgends deklariert`);
      }
    }
  }
  assert.ok(
    referenceCount > 0,
    "keine var(--…)-Referenz in tokens.css/palette.css gefunden — Muster geändert?"
  );
  assert.deepEqual(
    findings,
    [],
    `Referenzen ins Leere in tokens.css/palette.css:\n${findings.join("\n")}`
  );
});

test("die drei Zustandsfarben stehen fest, unabhängig von --h und --c", () => {
  const tokens = stripCssComments(readOrFail(TOKENS_PATH));
  const STATE_TOKENS = ["--state-ok", "--state-warn", "--state-down"];

  const findings = [];
  for (const name of STATE_TOKENS) {
    // ALLE Deklarationen dieses Namens, nicht nur die erste: eine zweite,
    // spätere Deklaration gewinnt in der Kaskade und muss deshalb genauso
    // geprüft werden — sonst läuft sie unbemerkt grün durch (Nachtrag
    // Leitstand).
    const pattern = new RegExp(`(?<![\\w-])${name}(?![\\w-])\\s*:\\s*([^;]+);`, "g");
    const matches = [...tokens.matchAll(pattern)];
    if (matches.length === 0) {
      findings.push(`${name}: nicht deklariert`);
      continue;
    }
    for (const match of matches) {
      const value = match[1];
      if (/var\(\s*--h\b/.test(value) || /var\(\s*--c\b/.test(value)) {
        findings.push(`${name}: „${value.trim()}" hängt an --h oder --c`);
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `Zustandsfarben sind Bedeutung, kein Geschmack (Vertrag, Abschnitt 7):\n${findings.join("\n")}`
  );
});

test("kein Farbwert außerhalb von oklch in den drei Theme-Dateien", () => {
  const files = {
    [STYLES_PATH]: readOrFail(STYLES_PATH),
    [TOKENS_PATH]: readOrFail(TOKENS_PATH),
    [PALETTE_PATH]: readOrFail(PALETTE_PATH)
  };

  // Genau 3, 4, 6 oder 8 Hexziffern nach dem `#` — die gültigen CSS-Längen.
  // Eine Ausgaben- oder Issue-Nummer wie „#62" hat nur zwei Ziffern und fällt
  // damit schon durch die Länge durch; der Kommentartext selbst ist über
  // `stripCssComments` ohnehin außen vor (Vertrag, Abschnitt 7, letzter Satz).
  const HEX_COLOR = /(?<![\w#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w])/g;
  const FUNCTIONAL_COLOR = /\b(rgb|rgba|hsl|hsla)\(/g;

  // ⚠️ DIE EINE AUSNAHME, namentlich und mit Grund: die sechzehn ANSI-Töne des
  // Terminals (B6/E4, #5) stehen als Hex.
  //
  // Nicht aus Bequemlichkeit: `@xterm` bekommt seine Farben als Zeichenkette
  // aus `getComputedStyle` und parst `oklch(…)` nicht. Ein oklch-Wert an
  // dieser Stelle wäre eine Farbe, die im Terminal NICHT ankommt — und kein
  // Test sähe es, weil im Stylesheet alles richtig aussieht. Der Grund für
  // diesen Wächter (eine Farbe soll nicht am Wertesatz vorbei entstehen) trägt
  // hier also in die andere Richtung.
  //
  // Die Ausnahme gilt AUSSCHLIESSLICH für eine Deklaration
  // `--terminal-ansi-…: #rrggbb;` — jedes andere Hex in jeder anderen Zeile
  // bleibt ein Befund, und ein Hex in einem Wert wie `--card` ebenso.
  const ANSI_HEX = /--terminal-ansi-[a-z-]+\s*:\s*#[0-9a-fA-F]{6}\s*(?:;|\})/g;

  const findings = [];
  let ansiCount = 0;
  for (const [path, content] of Object.entries(files)) {
    const withoutComments = stripCssComments(content);
    const allowed = new Set();
    for (const match of withoutComments.matchAll(ANSI_HEX)) {
      ansiCount += 1;
      allowed.add(match.index + match[0].indexOf("#"));
    }
    for (const match of withoutComments.matchAll(HEX_COLOR)) {
      if (allowed.has(match.index)) continue;
      findings.push(`${path}: Hex-Farbe ${match[0]}`);
    }
    for (const match of withoutComments.matchAll(FUNCTIONAL_COLOR)) {
      findings.push(`${path}: ${match[1]}(…)`);
    }
  }

  // Die Ausnahme darf nicht dadurch grün bleiben, dass es sie nicht mehr gibt:
  // drei Sätze zu je sechzehn Tönen (dunkel in `:root`, hell unter
  // `[data-scheme="light"]`, dunkel noch einmal unter
  // `[data-scheme="light"][data-terminal-scheme="dark"]`) sind 48
  // Deklarationen. Findet dieser Zähler weniger, ist entweder ein Satz
  // verschwunden oder das Muster passt nicht mehr — beides gehört gemeldet und
  // nicht stillschweigend erlaubt.
  assert.equal(
    ansiCount,
    48,
    `${ansiCount} Deklarationen --terminal-ansi-…: #rrggbb gefunden, erwartet 48 (drei Sätze zu 16).`
  );

  assert.deepEqual(findings, [], `Farbwert außerhalb von oklch:\n${findings.join("\n")}`);
});

test("styles.css trägt nur Importe", () => {
  const content = stripCssComments(readOrFail(STYLES_PATH));
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  assert.ok(lines.length > 0, "styles.css ist nach Entfernen der Kommentare leer");

  const findings = lines.filter((line) => !/^@import\s+"[^"]+";$/.test(line));
  assert.deepEqual(
    findings,
    [],
    `styles.css darf nur Importe tragen (Vertrag, Abschnitt 3):\n${findings.join("\n")}`
  );
});

test("alle Attributwerte in tokens.css und palette.css stammen aus dem englischen Vorrat", () => {
  // Durch `stripCssComments`, wie die übrigen fünf Prüfungen — diese hier war
  // die einzige, die den Quelltext roh gelesen hat. Fiel nicht auf, solange
  // kein Kommentar einen Attributselektor MIT Wert enthielt; ein Prosa-Satz
  // in `palette.css`, der über die Form eines Selektors redet und dafür
  // `[data-hue="…"]` als Platzhalter schreibt, hat diese Schwelle
  // überschritten und wurde als deutscher Wert „…" gemeldet — ein
  // Fehlalarm, kein Befund, denn ein Kommentar ist in diesem Projekt
  // ohnehin deutsch (Nachtrag Leitstand, gemessen auf 6a6b702).
  const files = {
    [TOKENS_PATH]: stripCssComments(readOrFail(TOKENS_PATH)),
    [PALETTE_PATH]: stripCssComments(readOrFail(PALETTE_PATH))
  };

  // Der Vorrat aus dem Vertrag, Abschnitt 7, Prüfung 6 — wörtlich. Die
  // ersten neun (Ton, Bereich, Farbeinsatz, Marke) stehen in `palette.css`
  // (Abschnitt 5.3–5.5); die letzten acht sind die Stellschrauben-Umschalter
  // aus Abschnitt 4.2 (Sättigung, Rundung, Dichte, Einrückung) und stehen in
  // `tokens.css`. Ein Wächter, der nur `palette.css` liest, lässt genau die
  // Datei ungeprüft, in der diese acht Werte tatsächlich stehen (Nachtrag
  // Leitstand).
  const ALLOWED_VALUES = new Set([
    // palette.css
    "amber", "green", "teal", "blue", "violet", "rose", "neutral",
    "operations", "management",
    "none", "edge", "head", "card",
    "label", "fill",
    // tokens.css
    "subtle", "normal", "bold",
    "sharp", "soft", "round",
    // „nested" ist seit D7b (#62) eine eigene Regel und nicht mehr nur der
    // Wert, den `:root` ohnehin trägt.
    "compact", "flat", "nested",
    // tokens.css, ergänzt in D7a (#62): die vier Stellschrauben aus D0 §4, für
    // die D1 noch keinen Umschalter angelegt hatte. „dark" steht in der Liste,
    // obwohl es dafür keine Regel gibt — `:root` trägt den dunklen Satz, und
    // ein Editor, der das Attribut ausdrücklich auf „dark" setzt, soll nicht
    // an einem Wächter scheitern, der den Wert nicht kennt.
    "dark", "light",
    "plex", "system",
    "rotate", "mono",
    "hue",
    // tokens.css, ergänzt in B6/E4 (#5): die vier Stellschrauben des
    // Terminals. „card", „normal" und „dark" stehen schon oben und sind
    // dieselben Wörter für etwas anderes — der Vorrat kennt Werte, nicht
    // Stellschrauben, und das ist Absicht: dieselbe Stufe soll überall gleich
    // heißen. Neu sind deshalb nur die sechs, die es bisher nicht gab.
    // „follow" fehlt und fehlt zu Recht: die Stufe hat keine eigene Regel, das
    // Terminal folgt dann dem Hub.
    "sunken", "ink",
    "small", "large",
    "short", "long"
  ]);

  // Anführungszeichen sind bei einem einfachen CSS-Bezeichner optional —
  // `[data-hue=blau]` ist ebenso gültiges CSS wie `[data-hue="blau"]` und
  // entkam dem alten Muster, das nur die Form mit Anführungszeichen kannte
  // (Nachtrag Leitstand). Beide Formen werden deshalb erfasst.
  const ATTRIBUTE_VALUE = /\[data-[\w-]+=(?:"([^"]*)"|'([^']*)'|([^\]'"]+))\]/g;

  let totalFound = 0;
  const findings = [];
  for (const [path, content] of Object.entries(files)) {
    const values = [...content.matchAll(ATTRIBUTE_VALUE)].map(
      (match) => match[1] ?? match[2] ?? match[3]
    );
    totalFound += values.length;
    for (const value of new Set(values)) {
      if (!ALLOWED_VALUES.has(value)) findings.push(`${path}: ${value}`);
    }
  }
  assert.ok(
    totalFound > 0,
    "keine Attributselektoren in tokens.css/palette.css gefunden — Muster geändert?"
  );
  assert.deepEqual(
    findings,
    [],
    `Nicht im Vorrat der englischen Attributwerte (Vertrag, Abschnitt 4.2 und 5.3–5.5):\n${findings.join(", ")}`
  );
});
