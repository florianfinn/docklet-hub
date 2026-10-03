import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripCssComments } from "./strip-comments.mjs";

// Wächter über die Preset-Schicht aus D7a (#62): die Richtung der
// Abhängigkeit zwischen den beiden Arbeitsbereichen, und die Deckung zwischen
// der Stufenliste in `contract/src/presets.ts` und den Umschaltern in den
// beiden Theme-Stylesheets.
//
// WARUM DIE RICHTUNG EINEN WÄCHTER BRAUCHT
//
// `contract/src/presets.ts` ist die eine Quelle für beide Bereiche. Das
// Web importiert sie relativ über die Bereichsgrenze; Vite bündelt sie zur
// Bauzeit ins Web-Ergebnis, `tsc` schreibt sie nach `server/dist/theme/`. Das
// Web hat damit zur Laufzeit KEINE Abhängigkeit auf den Quellbaum des Servers.
//
// Kehrt sich die Richtung um — importiert also irgendwann eine Datei unter
// `server/src/` etwas aus `web/` —, dann bleibt in dieser Werkstatt alles
// grün: `tsc` findet die Datei, `pnpm run build` läuft durch, jeder Test
// besteht. Rot wird erst der Container, denn `server/Dockerfile` kopiert
// `server/dist` und `server/node_modules` in die Laufzeitstufe und `web/`
// gerade nicht. Ein Fehler, den kein Bau zeigt und der erst beim Start
// auffällt, gehört unter eine Maschine.
//
// ⚠️ Geprüft wird der aufgelöste Pfad, nicht der Wortlaut: `../../web/x`,
// `../../../wt/p1/web/x` und ein nacktes `web/x` sind derselbe Fehler in drei
// Schreibweisen. Nur so hilft der Wächter auch dem, der ihn nicht kennt.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const PRESETS_PATH = "contract/src/presets.ts";
const TOKENS_PATH = "web/src/platform/theme/tokens.css";
const PALETTE_PATH = "web/src/platform/theme/palette.css";

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function trackedFiles(...patterns) {
  return execFileSync("git", ["ls-files", ...patterns], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

// Alle Modulangaben einer TypeScript-Datei: `import … from "x"`,
// `export … from "x"`, `import("x")` und `require("x")`. Kommentare sind
// vorher entfernt, sonst zählt ein zitierter Beispielpfad in deutscher Prosa
// als Befund — genau das ist in diesem Projekt schon einmal passiert.
export function moduleSpecifiers(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const found = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g
  ];
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

// Zeigt eine Modulangabe aus `fromFile` in den Web-Bereich?
export function reachesWeb(fromFile, specifier) {
  if (specifier.startsWith(".")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    return resolved === "web" || resolved.startsWith("web/");
  }
  return specifier === "web" || specifier.startsWith("web/");
}

test("der Erkenner selbst: was als Griff nach web/ zählt und was nicht", () => {
  assert.deepEqual(
    moduleSpecifiers('import { a } from "./x";\nexport * from "../y";\nawait import("z");\nrequire("q");'),
    ["./x", "../y", "z", "q"]
  );
  // Ein Pfad im Kommentar ist Prosa, kein Import.
  assert.deepEqual(moduleSpecifiers('// import { a } from "../../web/x";\nconst n = 1;'), []);
  assert.deepEqual(moduleSpecifiers('/* from "../../web/x" */\nconst n = 1;'), []);

  assert.equal(reachesWeb("server/src/theme/presets.ts", "../../../web/src/x"), true);
  assert.equal(reachesWeb("server/src/theme/presets.ts", "web/src/x"), true);
  assert.equal(reachesWeb("server/src/theme/presets.ts", "../../../wt/../web/src/x"), true);
  assert.equal(reachesWeb("server/src/theme/presets.ts", "./other"), false);
  assert.equal(reachesWeb("server/src/domain/hosts/host-store.ts", "../db/pool"), false);
  assert.equal(reachesWeb("server/src/domain/hosts/host-store.ts", "express"), false);
  // „webpack" fängt mit denselben drei Zeichen an und ist kein Bereich.
  assert.equal(reachesWeb("server/src/domain/hosts/host-store.ts", "webpack"), false);
});

test("keine Datei unter server/src importiert etwas aus web/", () => {
  const files = trackedFiles("server/src/**/*.ts", "server/src/**/*.tsx");
  assert.ok(files.length > 0, "git ls-files lieferte keine Serverquelle — der Wächter liefe ins Leere");

  const findings = [];
  for (const file of files) {
    for (const specifier of moduleSpecifiers(read(file))) {
      if (reachesWeb(file, specifier)) findings.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(
    findings,
    [],
    "Der Server darf nicht aus dem Web lesen — `server/Dockerfile` kopiert `web/` nicht in die\n" +
      "Laufzeitstufe, das Image startete also nicht mehr, ohne dass ein Bau rot wird:\n" +
      findings.join("\n")
  );
});

test("das Web liest die Presets über die Bereichsgrenze und nicht aus einer Kopie", () => {
  // Die Gegenrichtung ist erlaubt und soll es bleiben — aber nur EINE Datei
  // darf die Quelle sein. Eine zweite Liste derselben Stufen irgendwo unter
  // `web/src/` wäre der Anfang des Auseinanderlaufens, das diese Schicht
  // gerade verhindern soll.
  const copies = trackedFiles("web/src/**/presets.ts", "web/src/**/presets.tsx");
  assert.deepEqual(copies, [], `Zweite Preset-Liste im Web-Bereich:\n${copies.join("\n")}`);

  const presets = read(PRESETS_PATH);
  assert.deepEqual(
    moduleSpecifiers(presets),
    [],
    "presets.ts trägt Daten und importiert nichts — genau deshalb kann sie in beiden Bereichen liegen"
  );
});

// ---------------------------------------------------------------------------
// Deckung zwischen der Stufenliste und den Umschaltern im Stylesheet
// ---------------------------------------------------------------------------
//
// ⚠️ `presets.ts` wird hier mit einem Muster gelesen und nicht importiert:
// diese Tests laufen als reines `node --test` über `.mjs`, ohne
// TypeScript-Werkzeug. Damit ein geändertes Dateiformat den Wächter nicht
// still leer laufen lässt, prüft `readSteps` jede Liste auf eine Mindestzahl
// Einträge — findet das Muster nichts mehr, wird der Test rot statt grün.

// Liest `export const NAME = [ { name: "a" }, … ]` aus presets.ts.
export function readSteps(source, constantName) {
  const block = new RegExp(`export const ${constantName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(source);
  assert.ok(block, `${constantName} nicht in ${PRESETS_PATH} gefunden — Format geändert?`);
  const names = [...block[1].matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.length > 0, `${constantName} ist leer — Format geändert?`);
  return names;
}

// Welche Stellschraube welchem Attribut entspricht, und welche Stufe ihren
// Umschalter NICHT als eigene Regel trägt, weil `:root` sie schon führt.
const KNOBS = [
  { constant: "SCHEME_STEPS", attribute: "data-scheme", implicit: ["dark"], count: 2 },
  { constant: "CHROMA_STEPS", attribute: "data-chroma", implicit: [], count: 3 },
  { constant: "RADIUS_STEPS", attribute: "data-radius", implicit: [], count: 3 },
  { constant: "DENSITY_STEPS", attribute: "data-density", implicit: [], count: 2 },
  { constant: "FONT_STEPS", attribute: "data-font", implicit: [], count: 2 },
  { constant: "CHART_STEPS", attribute: "data-charts", implicit: [], count: 2 },
  { constant: "FOCUS_STEPS", attribute: "data-focus", implicit: [], count: 2 },
  { constant: "HUE_TONES", attribute: "data-hue", implicit: [], count: 7 },
  { constant: "INK_STEPS", attribute: "data-ink", implicit: [], count: 4 },
  // D7b (#62): die zwei Stellschrauben, deren CSS-Umschalter seit D1 stehen
  // und deren Stufenlisten bis D7a fehlten.
  //
  // ⚠️ Die DRITTE Stellschraube aus D7b — der Farbton einer Marke — hat hier
  // KEINEN eigenen Eintrag, und das ist die Aussage von #62 („nicht vier
  // Stellen mit demselben Standardwert"): sie ist in `THEME_KNOBS` derselbe
  // Eintrag `hue` mit `scope: ["host", "mark"]`, also dieselbe Konstante
  // `HUE_TONES` und dasselbe Attribut `data-hue`. Ein zweiter Eintrag mit
  // denselben drei Angaben prüfte dieselbe Deckung ein zweites Mal und wäre
  // genau die Abschrift, gegen die diese Datei steht.
  { constant: "MARK_STYLE_STEPS", attribute: "data-mark-style", implicit: [], count: 2 },
  { constant: "INDENT_STEPS", attribute: "data-indent", implicit: [], count: 2 },
  // B6/E4 (#5): die vier des Terminals.
  //
  // ⚠️ `follow` steht als `implicit` und hat deshalb keine Regel im
  // Stylesheet: „das Terminal folgt dem Hub" IST der Zustand ohne eigene
  // Regel — `:root` trägt den dunklen Satz, `[data-scheme="light"]` den
  // hellen, und genau das soll dann gelten. Eine leere Regel
  // `[data-terminal-scheme="follow"] {}` wäre eine Behauptung ohne Wirkung.
  // Dieselbe Lage wie bei `dark` in `SCHEME_STEPS`, aus demselben Grund.
  { constant: "TERMINAL_SCHEME_STEPS", attribute: "data-terminal-scheme", implicit: ["follow"], count: 2 },
  { constant: "TERMINAL_SURFACE_STEPS", attribute: "data-terminal-surface", implicit: [], count: 3 },
  { constant: "TERMINAL_SIZE_STEPS", attribute: "data-terminal-size", implicit: [], count: 3 },
  { constant: "TERMINAL_SCROLLBACK_STEPS", attribute: "data-terminal-scrollback", implicit: [], count: 3 }
];

function selectorValues(css, attribute) {
  const pattern = new RegExp(`\\[${attribute}=(?:"([^"]*)"|'([^']*)'|([^\\]'"]+))\\]`, "g");
  return new Set([...css.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]));
}

test("jede Stufe aus presets.ts hat einen Umschalter im Stylesheet und umgekehrt", () => {
  const presets = read(PRESETS_PATH);
  const css = stripCssComments(read(TOKENS_PATH)) + "\n" + stripCssComments(read(PALETTE_PATH));

  const findings = [];
  for (const knob of KNOBS) {
    const steps = readSteps(presets, knob.constant);
    assert.equal(
      steps.length,
      knob.count,
      `${knob.constant} hat ${steps.length} Stufen, erwartet ${knob.count} — ` +
        "wer eine Stufe hinzufügt, trägt sie hier ein und legt ihre CSS-Regel an"
    );
    const inCss = selectorValues(css, knob.attribute);
    for (const step of steps) {
      if (knob.implicit.includes(step)) continue;
      if (!inCss.has(step)) findings.push(`[${knob.attribute}="${step}"] fehlt im Stylesheet`);
    }
    for (const value of inCss) {
      if (!steps.includes(value)) findings.push(`[${knob.attribute}="${value}"] steht im Stylesheet, aber nicht in ${knob.constant}`);
    }
  }
  assert.deepEqual(findings, [], `Stufenliste und Stylesheet laufen auseinander:\n${findings.join("\n")}`);
});

test("die Farbtöne und Bereichstöne in presets.ts stimmen mit palette.css überein", () => {
  const presets = read(PRESETS_PATH);
  const palette = stripCssComments(read(PALETTE_PATH));

  // Aus presets.ts: { name: "amber", hue: 62, … }
  const fromPresets = new Map();
  for (const match of presets.matchAll(/name:\s*"([^"]+)",\s*hue:\s*(\d+)/g)) {
    fromPresets.set(match[1], Number(match[2]));
  }
  assert.ok(fromPresets.size >= 9, `nur ${fromPresets.size} Töne in presets.ts gelesen — Format geändert?`);

  // Aus palette.css: [data-hue="amber"] { --h: 62; }
  const fromCss = new Map();
  for (const match of palette.matchAll(/\[data-(?:hue|area)="([^"]+)"\]\s*\{[^}]*--h:\s*([\d.]+)\s*;/g)) {
    fromCss.set(match[1], Number(match[2]));
  }
  assert.ok(fromCss.size >= 9, `nur ${fromCss.size} Töne in palette.css gelesen — Format geändert?`);

  const findings = [];
  for (const [name, hue] of fromCss) {
    if (!fromPresets.has(name)) findings.push(`${name}: steht in palette.css, aber nicht in presets.ts`);
    else if (fromPresets.get(name) !== hue) findings.push(`${name}: palette.css sagt ${hue}, presets.ts sagt ${fromPresets.get(name)}`);
  }
  for (const name of fromPresets.keys()) {
    if (!fromCss.has(name)) findings.push(`${name}: steht in presets.ts, aber nicht in palette.css`);
  }
  assert.deepEqual(findings, [], `Tonvorrat läuft auseinander:\n${findings.join("\n")}`);
});

test("die Sättigungsstufen und -faktoren in presets.ts stimmen mit dem Stylesheet überein", () => {
  const presets = read(PRESETS_PATH);
  const tokens = stripCssComments(read(TOKENS_PATH));
  const palette = stripCssComments(read(PALETTE_PATH));

  const findings = [];

  // Stufen: { name: "subtle", chroma: 0.055 } gegen [data-chroma="subtle"] { --chroma: 0.055; }
  const steps = new Map(
    [...presets.matchAll(/name:\s*"([^"]+)",\s*chroma:\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])])
  );
  assert.ok(steps.size >= 3, `nur ${steps.size} Sättigungsstufen in presets.ts gelesen — Format geändert?`);
  for (const match of tokens.matchAll(/\[data-chroma="([^"]+)"\]\s*\{\s*--chroma:\s*([\d.]+)\s*;/g)) {
    const [, name, value] = match;
    if (steps.get(name) !== Number(value)) {
      findings.push(`Sättigung ${name}: tokens.css sagt ${value}, presets.ts sagt ${steps.get(name)}`);
    }
  }

  // Faktoren: { name: "host", factor: 1.3, cap: 0.215 } gegen
  // [data-host] { --c: min(calc(var(--chroma) * 1.3), 0.215); }
  const factors = new Map(
    [...presets.matchAll(/name:\s*"([^"]+)",\s*factor:\s*([\d.]+),\s*cap:\s*([\d.]+|null)/g)].map((m) => [
      m[1],
      { factor: Number(m[2]), cap: m[3] === "null" ? null : Number(m[3]) }
    ])
  );
  assert.ok(factors.size >= 4, `nur ${factors.size} Sättigungsfaktoren in presets.ts gelesen — Format geändert?`);
  for (const [layer, selector] of [["host", "\\[data-host\\]"], ["mark", "\\[data-mark\\]"], ["area", "\\[data-area\\]"], ["base", ":root"]]) {
    const rule = new RegExp(`${selector}\\s*\\{[^}]*--c:\\s*([^;]+);`).exec(palette);
    if (!rule) {
      findings.push(`${layer}: keine --c-Regel in palette.css gefunden`);
      continue;
    }
    const expected = factors.get(layer);
    const factorInCss = /\*\s*([\d.]+)\s*\)/.exec(rule[1]);
    if (!factorInCss || Number(factorInCss[1]) !== expected.factor) {
      findings.push(`${layer}: palette.css sagt „${rule[1].trim()}", presets.ts sagt Faktor ${expected.factor}`);
    }
    const capInCss = /min\(.*?,\s*([\d.]+)\s*\)/.exec(rule[1]);
    const cap = capInCss ? Number(capInCss[1]) : null;
    if (cap !== expected.cap) {
      findings.push(`${layer}: palette.css deckelt bei ${cap}, presets.ts bei ${expected.cap}`);
    }
  }

  assert.deepEqual(findings, [], `Sättigung läuft auseinander:\n${findings.join("\n")}`);
});

test("Rundung und Dichte in presets.ts stimmen mit tokens.css überein", () => {
  const presets = read(PRESETS_PATH);
  const tokens = stripCssComments(read(TOKENS_PATH));

  const findings = [];

  const radius = new Map(
    [...presets.matchAll(/name:\s*"([^"]+)",\s*radius:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]])
  );
  assert.ok(radius.size >= 3, `nur ${radius.size} Rundungsstufen in presets.ts gelesen — Format geändert?`);
  for (const match of tokens.matchAll(/\[data-radius="([^"]+)"\]\s*\{\s*--radius:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (radius.get(name) !== value.trim()) {
      findings.push(`Rundung ${name}: tokens.css sagt ${value.trim()}, presets.ts sagt ${radius.get(name)}`);
    }
  }

  const density = new Map(
    [...presets.matchAll(/name:\s*"([^"]+)",\s*size:\s*"([^"]+)",\s*leading:\s*([\d.]+)/g)].map((m) => [
      m[1],
      { size: m[2], leading: Number(m[3]) }
    ])
  );
  assert.ok(density.size >= 2, `nur ${density.size} Dichtestufen in presets.ts gelesen — Format geändert?`);
  for (const match of tokens.matchAll(/\[data-density="([^"]+)"\]\s*\{\s*--density-size:\s*([^;]+);\s*--density-leading:\s*([^;]+);/g)) {
    const [, name, size, leading] = match;
    const expected = density.get(name);
    if (!expected) continue;
    if (expected.size !== size.trim() || expected.leading !== Number(leading)) {
      findings.push(
        `Dichte ${name}: tokens.css sagt ${size.trim()}/${leading.trim()}, presets.ts sagt ${expected.size}/${expected.leading}`
      );
    }
  }

  assert.deepEqual(findings, [], `Rundung oder Dichte laufen auseinander:\n${findings.join("\n")}`);
});

test("Schriftgröße und Verlauf des Terminals stimmen zwischen presets.ts und tokens.css überein", () => {
  // ⚠️ WARUM DIESE ZAHLEN ÜBERHAUPT ZWEIMAL STEHEN, anders als bei der Dichte:
  // `DENSITY_STEPS` trägt „15px" als Zeichenkette, weil der Wert nur ins
  // Stylesheet geht. Die zwei Zahlen des Terminals gehen an ZWEI Stellen —
  // `@xterm` nimmt `fontSize` und `scrollback` als Zahl entgegen, das
  // Stylesheet braucht für die Größe eine Einheit. In `presets.ts` steht
  // deshalb die nackte Zahl, hier die Zahl mit `px`, und dieser Fall hält
  // beide gegeneinander. Ohne ihn wäre „12 in presets.ts, 14px in tokens.css"
  // ein Unterschied, den niemand sieht.
  const presets = read(PRESETS_PATH);
  const tokens = stripCssComments(read(TOKENS_PATH));

  const findings = [];

  // { name: "small", pixels: 12 } gegen [data-terminal-size="small"] { --terminal-size: 12px; }
  const sizes = new Map(
    [...presets.matchAll(/name:\s*"([^"]+)",\s*pixels:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])])
  );
  assert.equal(sizes.size, 3, `${sizes.size} Schriftgrößen in presets.ts gelesen, erwartet 3 — Format geändert?`);
  const sizeRules = [...tokens.matchAll(/\[data-terminal-size="([^"]+)"\]\s*\{\s*--terminal-size:\s*(\d+)px\s*;/g)];
  assert.equal(sizeRules.length, 3, `${sizeRules.length} Regeln für die Schriftgröße in tokens.css, erwartet 3`);
  for (const [, name, value] of sizeRules) {
    if (sizes.get(name) !== Number(value)) {
      findings.push(`Schriftgröße ${name}: tokens.css sagt ${value}px, presets.ts sagt ${sizes.get(name)}`);
    }
  }

  // { name: "short", lines: 1000 } gegen [data-terminal-scrollback="short"] { --terminal-scrollback: 1000; }
  const scrollback = new Map(
    [...presets.matchAll(/name:\s*"([^"]+)",\s*lines:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])])
  );
  assert.equal(scrollback.size, 3, `${scrollback.size} Verlaufsstufen in presets.ts gelesen, erwartet 3 — Format geändert?`);
  const scrollbackRules = [
    ...tokens.matchAll(/\[data-terminal-scrollback="([^"]+)"\]\s*\{\s*--terminal-scrollback:\s*(\d+)\s*;/g)
  ];
  assert.equal(scrollbackRules.length, 3, `${scrollbackRules.length} Regeln für den Verlauf in tokens.css, erwartet 3`);
  for (const [, name, value] of scrollbackRules) {
    if (scrollback.get(name) !== Number(value)) {
      findings.push(`Verlauf ${name}: tokens.css sagt ${value}, presets.ts sagt ${scrollback.get(name)}`);
    }
  }

  assert.deepEqual(findings, [], `Größe oder Verlauf des Terminals laufen auseinander:\n${findings.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Keine zwei Stufen derselben Stellschraube deklarieren denselben Satz Werte
// ---------------------------------------------------------------------------
//
// FÄNGT: eine Stellschraube, deren Stufen der Betreiber im Editor
// auseinanderhalten kann, die im Stylesheet aber dasselbe tun. Der Betreiber
// wählt eine Stufe, und auf dem Schirm passiert nichts.
//
// WARUM ES DIESEN WÄCHTER GIBT: bis D7a standen in `palette.css` die beiden
// Zeilen für `[data-ink="none"]` und `[data-ink="edge"]` ZEICHENGLEICH da —
// beide `--head-face: var(--secondary); --body-face: var(--card);`. Ein
// Kommentar erklärte das als Absicht: der Unterschied liege in der Kante, die
// das Bauteil aus `--accent-line` ziehe „oder eben nicht". Dieser Mechanismus
// war nie gebaut; alle vier Bauteile mit einer Host-Karte trugen die getönte
// Kante fest. Zwei der vier Stufen waren damit nicht zu unterscheiden.
//
// Keine Prüfkette hat das bemerkt, und keine konnte es: zwei gleiche
// Deklarationsblöcke sind syntaktisch tadellos, der Bau läuft, jeder
// bestehende Wächter bleibt grün. Der Fehler ist erst als VERGLEICH zwischen
// zwei Stufen sichtbar — und genau diesen Vergleich zieht dieser Test.
//
// ⚠️ GEPRÜFT WIRD DER DEKLARIERTE SATZ, NICHT DAS BILD. Zwei Stufen mit
// verschiedenen Werten können trotzdem gleich AUSSEHEN (zwei Farben, die sich
// um ein Tausendstel unterscheiden). Das ist die Grenze dieses Wächters und
// keine Lücke, die sich hier schließen ließe: eine Farbe zu rechnen hieße,
// die Ableitungsregel ein zweites Mal zu führen. Wogegen er schützt, ist der
// Fall, der hier eingetreten ist — zwei Stufen, die WÖRTLICH dasselbe sagen.
//
// ⚠️ Er prüft AUCH NICHT, ob eine Stufe überhaupt eine Wirkung hat: eine
// einzelne Stufe, deren Werte denen von `:root` entsprechen, ist erlaubt und
// kommt vor (`[data-radius="soft"]` und `[data-chroma="normal"]` tragen genau
// den Vorgabewert). Das ist die Bauart dieser Schicht — jede Stufe steht als
// eigene Regel da, auch die vorgegebene.

// Zerlegt ein Stylesheet in seine flachen Regeln. `[^{}]` auf beiden Seiten:
// die Selektorliste beginnt hinter der vorigen schließenden Klammer, der
// Rumpf endet vor der eigenen. Verschachtelte At-Regeln (`@layer base { … }`)
// treffen das Muster nicht selbst — gefunden werden die Regeln DARIN, und
// genau die tragen die Deklarationen.
const FLAT_RULE = /([^{}]+)\{([^{}]*)\}/g;
const ATTRIBUTE_STEP = /\[data-([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\]'"]+))\]/g;

// Eine Deklaration auf ihre Bedeutung bringen: Leerraum zusammenziehen UND
// den Abstand um den ersten Doppelpunkt vereinheitlichen. Ohne den zweiten
// Schritt wären `--u:1` und `--u: 1` zwei verschiedene Zeichenketten und damit
// zwei „verschiedene" Stufen — der Wächter bliebe grün, obwohl beide dasselbe
// erklären. Gemessen an der Selbstprobe unten, die genau daran zuerst rot war.
// Getrennt wird nur am ERSTEN Doppelpunkt: der Rest gehört zum Wert.
function normalizeDeclaration(part) {
  const trimmed = part.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const colon = trimmed.indexOf(":");
  if (colon < 0) return trimmed;
  return `${trimmed.slice(0, colon).trim()}: ${trimmed.slice(colon + 1).trim()}`;
}

// attribut -> stufe -> Menge der Deklarationen, über beide Dateien vereinigt.
// Vereinigt und nicht je Regel getrennt, weil eine Stufe in mehr als einer
// Regel stehen darf (`[data-scheme="light"]` steht in `tokens.css` zweimal:
// einmal für den Wertesatz, einmal für `color-scheme`).
export function knobSteps(stylesheets) {
  const knobs = new Map();
  for (const css of stylesheets) {
    for (const rule of css.matchAll(FLAT_RULE)) {
      const declarations = rule[2]
        .split(";")
        .map((part) => normalizeDeclaration(part))
        .filter(Boolean);
      for (const step of rule[1].matchAll(ATTRIBUTE_STEP)) {
        const attribute = `data-${step[1]}`;
        const value = step[2] ?? step[3] ?? step[4];
        if (!knobs.has(attribute)) knobs.set(attribute, new Map());
        const steps = knobs.get(attribute);
        if (!steps.has(value)) steps.set(value, new Set());
        for (const declaration of declarations) steps.get(value).add(declaration);
      }
    }
  }
  return knobs;
}

test("der Erkenner selbst: gleiche und ungleiche Stufen", () => {
  const same = knobSteps(['[data-x="a"] { --u: 1; }\n[data-x="b"] { --u: 1; }']);
  assert.deepEqual([...same.get("data-x").keys()], ["a", "b"]);
  assert.deepEqual([...same.get("data-x").get("b")], ["--u: 1"]);

  // Reihenfolge und Leerraum sind kein Unterschied — sonst entkäme ihm
  // dieselbe Erklärung in anderer Schreibweise.
  const shuffled = knobSteps(['[data-x="a"] { --u: 1;  --v: 2; }\n[data-x="b"] {--v:2;--u:1;}']);
  const [first, second] = [...shuffled.get("data-x").values()].map((set) => [...set].sort().join(";"));
  assert.equal(first, second);

  // Eine Stufe, die in zwei Regeln steht, trägt beider Deklarationen.
  const split = knobSteps(['[data-x="a"] { --u: 1; }', '[data-x="a"] { --v: 2; }']);
  assert.deepEqual([...split.get("data-x").get("a")].sort(), ["--u: 1", "--v: 2"]);

  // Ein nackter `[data-x]`-Selektor ist keine Stufe, sondern die Ebene selbst.
  assert.equal(knobSteps(["[data-x] { --u: 1; }"]).size, 0);
});

test("keine zwei Stufen derselben Stellschraube deklarieren denselben Satz Werte", () => {
  const knobs = knobSteps([stripCssComments(read(TOKENS_PATH)), stripCssComments(read(PALETTE_PATH))]);

  const findings = [];
  let comparable = 0;
  for (const [attribute, steps] of knobs) {
    if (steps.size < 2) continue;
    comparable += 1;
    const entries = [...steps].map(([value, set]) => [value, [...set].sort().join("; ")]);
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (entries[i][1] !== entries[j][1]) continue;
        findings.push(
          `[${attribute}="${entries[i][0]}"] und [${attribute}="${entries[j][0]}"] deklarieren beide ` +
            `„${entries[i][1] || "(nichts)"}" — der Betreiber kann die beiden Stufen wählen, ` +
            "auf dem Schirm passiert nichts"
        );
      }
    }
  }

  // Der Wächter darf nicht dadurch grün werden, dass er nichts findet.
  // Nachgezählt auf diesem Stand (B6/E4, #5): vierzehn Stellschrauben mit zwei
  // oder mehr Stufen — data-area 2, data-charts 2, data-chroma 3, data-density
  // 2, data-focus 2, data-font 2, data-hue 7, data-indent 2, data-ink 4,
  // data-mark-style 2, data-radius 3, data-terminal-scrollback 3,
  // data-terminal-size 3, data-terminal-surface 3.
  //
  // `data-indent` kam mit D7b dazu: bis D7a trug es nur die Regel für „flat",
  // weil `:root` „nested" führte; D7b hat den Umschalter für „nested"
  // angelegt, weil der Editor das Attribut ausdrücklich setzt.
  //
  // ⚠️ ZWEI bleiben unvergleichbar, beide aus demselben Grund: `data-scheme`
  // (`:root` trägt den dunklen Satz, es gibt nur die Regel für „light") und
  // `data-terminal-scheme` (das Terminal folgt dem Hub, es gibt nur die Regel
  // für „dark"). Eine Stellschraube mit genau einer Regel ist nicht
  // vergleichbar — es gibt nichts, wogegen.
  assert.ok(
    comparable >= 14,
    `nur ${comparable} Stellschrauben mit mindestens zwei Stufen in tokens.css/palette.css — ` +
      "erwartet werden mindestens 14. Umbenannt, verschoben oder Muster geändert?"
  );

  assert.deepEqual(
    findings,
    [],
    `Zwei Stufen derselben Stellschraube sind nicht zu unterscheiden:\n${findings.join("\n")}`
  );
});
