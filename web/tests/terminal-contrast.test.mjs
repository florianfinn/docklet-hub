import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripCssComments } from "./strip-comments.mjs";
import {
  contrastRatio,
  hexToLinearSrgb,
  inGamut,
  oklchToLinearSrgb,
  parseOklch
} from "./ansi-contrast.mjs";

// Wächter über die sechzehn ANSI-Töne des Terminals — Paket B6, Etappe E4 (#5).
//
// WOGEGEN ER STEHT
//
// Die sechzehn Töne sind ein Vertrag mit den Programmen im Container: `git
// diff` schreibt Entferntes in Rot, `ls` färbt Verzeichnisse blau, ein Fehler
// kommt in Rot. Wer einen dieser Werte ändert — beim Aufräumen, beim
// Angleichen an einen neuen Markenton —, kann eine Fehlerzeile im Container
// unlesbar machen, ohne dass irgendetwas rot wird: im Stylesheet sieht eine
// zu dunkle Farbe aus wie jede andere. Genau diese Klasse gehört unter eine
// Maschine.
//
// ⚠️ DIE FARBEN STEHEN NICHT IN DIESER DATEI. Sie werden aus
// `web/src/platform/theme/tokens.css` gelesen. Ein Kontrasttest mit einer eigenen Kopie
// der Werte prüft sich selbst und nicht das Stylesheet — dieselbe Regel, die
// `theme-contrast.test.mjs` in seinem Kopf ausführlich begründet. Die einzigen
// Zahlen hier sind die Schwelle 4,5 aus WCAG 2.2 (1.4.3) und die Namen der
// vier Ausnahmen.
//
// Die Rechnung steht in `web/tests/ansi-contrast.mjs`; ihr Kopf sagt, woher
// sie kommt (das Messskript des Leitstands, mit dem die Werte entschieden
// wurden).
//
// WAS GEPRÜFT WIRD
//
//   1. Der Wächter liest überhaupt etwas: sechzehn Töne und drei Flächen je
//      Fall, sonst wäre grün nichts wert.
//   2. Die Töne stehen als Hex — `@xterm` parst `oklch(…)` nicht.
//   3. Jeder Ton hält 4,5 gegen ALLE DREI Flächentiefen seines Schemas, außer
//      den vier namentlich ausgenommenen.
//   4. Keine Farbe liegt außerhalb des sRGB-Raums.
//   5. „Zurück auf Dunkel" ist vollständig: der dunkle Satz in einem hellen
//      Hub ist derselbe wie in einem dunklen.
//   6. Die Rechnung selbst, an Werten, die anderswo nachzuschlagen sind.
//
// NICHT geprüft und bewusst so: ob `@xterm` die Werte am Ende wirklich
// zugewiesen bekommt. Das Terminal baut eine spätere Etappe; dieser Wächter
// hält die Werte, aus denen sie schöpft.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOKENS_PATH = "web/src/platform/theme/tokens.css";

// WCAG 2.2, 1.4.3 Kontrast (Minimum) für Text. Terminalausgabe ist Text in
// kleiner Schrift — die Schwelle für große Schrift (3,0) gilt hier nicht.
const AA_TEXT = 4.5;

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white"
];

const SURFACE_TOKENS = ["--terminal-card", "--terminal-sunken", "--terminal-ink"];

/**
 * Die vier Ausnahmen, namentlich und mit Grund.
 *
 * ⚠️ Sie sind eine Entscheidung des Leitstands
 * (`.remember/orchestration-b6/terminal-farben.md`, Abschnitt „Die zwei
 * Ausnahmen") und keine Bequemlichkeit dieses Wächters: ANSI-Schwarz ist die
 * Farbe, mit der ein Programm einen Hintergrund oder eine gedämpfte Nebenzeile
 * setzt. Auf 4,5 gehoben wäre es kein Schwarz mehr, und eine gedimmte Zeile
 * sähe aus wie eine normale.
 *
 * ⚠️ GEMESSEN, damit die Ausnahme nicht mehr behauptet als sie ist: im dunklen
 * Satz erreichen `black` (1,65) und `bright-black` (3,26) die 4,5 wirklich
 * nicht. Im hellen Satz liegen `white` (schlechtester Wert 6,26) und
 * `bright-white` (4,82) heute DARÜBER — sie stehen hier trotzdem, weil die
 * Entscheidung sie bewusst am Boden hält und ein Programm, das seine Ausgabe
 * in Weiß schreibt, auf hellem Grund sonst unsichtbar wäre. Der Preis ist
 * benannt: fiele einer der beiden später unter 4,5, sagte dieser Wächter
 * nichts. Wer die zwei Zeilen streicht, macht ihn an dieser Stelle schärfer.
 *
 * ⚠️ DIESE VIER ZAHLEN GELTEN FÜR DEN HEX AUS `tokens.css` und nicht für den
 * ungerundeten oklch-Ton, aus dem er entstanden ist. Bis zum 2026-09-08
 * standen hier 3,25 / 6,22 / 4,81 — die Ausgabe des Messskripts, das auf der
 * ungerundeten oklch-Farbe rechnet und daneben nur den gerundeten Hex druckt.
 * Der Kopf von `ansi-contrast.mjs` sagt, die RECHNUNG sei übernommen, „damit
 * der Wächter dieselbe Rechnung benutzt wie die Messung" — sie ist es; die
 * EINGABE war es nicht, und die zitierten Zahlen waren damit aus dieser Datei
 * nicht reproduzierbar. Neu gerechnet am 2026-09-08 mit genau den Funktionen
 * daneben (`hexToLinearSrgb` → `contrastRatio`) über dieselbe Kaskade, die
 * dieser Wächter unten nachbaut, jeweils gegen die schlechteste der drei
 * Flächen: `black` 1,646 · `bright-black` 3,261 (beide gegen
 * `--terminal-card`) · `white` 6,261 · `bright-white` 4,819 (beide gegen
 * `--terminal-ink`).
 */
const EXEMPT = {
  dark: new Map([
    ["black", "ANSI-Schwarz IST die dunkle Fläche — auf 4,5 gehoben wäre es kein Schwarz mehr"],
    ["bright-black", "die gedämpfte Nebenzeile; auf 4,5 gehoben sähe sie aus wie eine normale Zeile"]
  ]),
  light: new Map([
    ["white", "ANSI-Weiß IST die helle Fläche — die Entscheidung hält es am Boden statt es zu heben"],
    ["bright-white", "dasselbe eine Stufe heller; aus dem Hex gemessen 4,82 und damit bewusst am Rand"]
  ])
};

/**
 * Die drei Lagen, die es zu prüfen gibt.
 *
 * Sie sind nicht drei Schemata, sondern drei Zustände der Kaskade: welche
 * Regeln greifen, wenn `<html>` diese Attribute trägt. Die Reihenfolge der
 * Selektoren ist die Reihenfolge, in der sie gewinnen.
 */
const CASES = [
  { name: "dunkler Hub", selectors: [":root"], set: "dark" },
  { name: "heller Hub", selectors: [":root", '[data-scheme="light"]'], set: "light" },
  {
    name: "dunkles Terminal im hellen Hub",
    selectors: [":root", '[data-scheme="light"]', '[data-scheme="light"][data-terminal-scheme="dark"]'],
    set: "dark"
  }
];

// Dieselbe flache Zerlegung wie in `theme-presets.test.mjs`: `[^{}]` auf beiden
// Seiten, damit `@layer base { … }` nicht als Regel zählt, sondern die Regeln
// darin.
const FLAT_RULE = /([^{}]+)\{([^{}]*)\}/g;

const CSS = stripCssComments(readFileSync(path.join(ROOT, TOKENS_PATH), "utf8"));

/**
 * Die Deklarationen, die für eine Lage gelten — in Quelltextreihenfolge
 * übereinandergelegt.
 *
 * ⚠️ Das ist die Kaskade, die dieser Wächter nachbaut, und ihre Grenze steht
 * hier: gleiche Spezifität, die spätere Deklaration gewinnt. Das trifft für
 * `:root` und `[data-scheme="light"]` zu (beide (0,1,0)) und für den
 * verketteten Selektor (0,2,0), der ohnehin zuletzt steht. Ein Stylesheet, das
 * die Regeln umsortiert, misst dieser Wächter also genauso falsch, wie der
 * Browser sie darstellt — und das ist die Absicht.
 */
function cascade(selectors) {
  const values = new Map();
  for (const rule of CSS.matchAll(FLAT_RULE)) {
    if (!selectors.includes(rule[1].trim())) continue;
    for (const part of rule[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      const name = part.slice(0, colon).trim();
      if (!name.startsWith("--")) continue;
      values.set(name, part.slice(colon + 1).trim());
    }
  }
  return values;
}

/** Löst `var(--x)`-Ketten auf. Mehr kann diese Schicht nicht, und mehr braucht sie nicht. */
function resolve(values, name) {
  let value = values.get(name);
  for (let step = 0; step < 10; step += 1) {
    if (typeof value !== "string") return null;
    const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
    if (reference === null) return value.trim();
    value = values.get(reference[1]);
  }
  return null;
}

/** Die drei Flächen und die sechzehn Töne einer Lage, fertig in linearem sRGB. */
function readCase(testCase) {
  const values = cascade(testCase.selectors);
  const surfaces = new Map();
  for (const token of SURFACE_TOKENS) {
    const raw = resolve(values, token);
    const parsed = raw === null ? null : parseOklch(raw);
    surfaces.set(token, parsed === null ? null : { raw, linear: oklchToLinearSrgb(...parsed) });
  }
  const tones = new Map();
  for (const name of ANSI_NAMES) {
    const raw = resolve(values, `--terminal-ansi-${name}`);
    tones.set(name, raw === null ? null : { raw, linear: hexToLinearSrgb(raw) });
  }
  return { surfaces, tones, values };
}

const READ = CASES.map((testCase) => ({ ...testCase, ...readCase(testCase) }));

test("der Wächter liest überhaupt etwas — sechzehn Töne und drei Flächen je Lage", () => {
  // Ein Kontrasttest, der grün wird, weil er keine Farbe gefunden hat, ist die
  // schlimmste Form von grün: er sieht aus wie ein Beweis.
  assert.ok(CSS.length > 0, `${TOKENS_PATH} ist leer oder nicht lesbar.`);

  const findings = [];
  for (const testCase of READ) {
    for (const [token, surface] of testCase.surfaces) {
      if (surface === null) findings.push(`${testCase.name}: ${token} ist nicht lesbar (erwartet: oklch(L C H))`);
    }
    for (const [name, tone] of testCase.tones) {
      if (tone === null) findings.push(`${testCase.name}: --terminal-ansi-${name} ist nicht deklariert`);
      else if (tone.linear === null) findings.push(`${testCase.name}: --terminal-ansi-${name} ist „${tone.raw}" und kein #rrggbb`);
    }
  }
  assert.deepEqual(findings, [], `Der Wächter findet Werte nicht:\n${findings.join("\n")}`);

  // Und die vier Ausnahmen sind wirklich Töne dieses Satzes — sonst bliebe
  // eine Ausnahme stehen, deren Ton längst anders heißt, und der neue Ton
  // erbte sie.
  for (const [scheme, exemptions] of Object.entries(EXEMPT)) {
    for (const name of exemptions.keys()) {
      assert.ok(ANSI_NAMES.includes(name), `Ausnahme „${name}" (${scheme}) ist kein Name aus den sechzehn.`);
    }
  }
});

test("die sechzehn Töne stehen als Hex und nicht in oklch", () => {
  // ⚠️ Der Grund ist keine Vorliebe: `@xterm` bekommt die Farben als
  // Zeichenkette aus `getComputedStyle` und parst `oklch(…)` nicht. Ein
  // oklch-Wert wäre hier eine Farbe, die im Terminal nicht ankommt — im
  // Stylesheet sähe alles richtig aus, und kein anderer Test spräche darüber.
  const findings = [];
  for (const testCase of READ) {
    for (const [name, tone] of testCase.tones) {
      if (tone !== null && !/^#[0-9a-fA-F]{6}$/.test(tone.raw)) {
        findings.push(`${testCase.name}: --terminal-ansi-${name} = „${tone.raw}"`);
      }
    }
  }
  assert.deepEqual(findings, [], `Ein Ton, den @xterm nicht lesen kann:\n${findings.join("\n")}`);
});

test("jeder Ton hält 4,5 gegen alle drei Flächentiefen seines Schemas", () => {
  const findings = [];
  let comparisons = 0;

  for (const testCase of READ) {
    const exemptions = EXEMPT[testCase.set];
    for (const [name, tone] of testCase.tones) {
      if (tone === null || tone.linear === null) continue; // Der Fall oben meldet das.
      for (const [token, surface] of testCase.surfaces) {
        if (surface === null) continue;
        comparisons += 1;
        const ratio = contrastRatio(tone.linear, surface.linear);
        if (ratio >= AA_TEXT) continue;
        if (exemptions.has(name)) continue;
        findings.push(
          `${testCase.name}: ${name} (${tone.raw}) auf ${token} (${surface.raw}) — ` +
            `${ratio.toFixed(2)} statt ${AA_TEXT}`
        );
      }
    }
  }

  // 3 Lagen × 16 Töne × 3 Flächen. Ohne diese Zahl wäre ein Wächter, dem die
  // Werte abhandenkommen, still grün.
  assert.equal(comparisons, 144, `${comparisons} Vergleiche gerechnet, erwartet 144 (3 Lagen × 16 Töne × 3 Flächen).`);

  assert.deepEqual(
    findings,
    [],
    "Ein ANSI-Ton ist auf einer der drei Flächentiefen nicht mehr lesbar. Das trifft im Container " +
      "eine Ausgabe, die ihre Farbe nicht wählen kann: ein Diff schreibt Entferntes rot, weil rot " +
      "rot ist, und nicht weil es gerade passt:\n" +
      findings.join("\n")
  );
});

test("keine Farbe liegt außerhalb des sRGB-Raums", () => {
  // Ein oklch außerhalb des Raums wird beim Anzeigen abgeschnitten — und der
  // abgeschnittene Wert ist ein ANDERER Ton als der gemessene. Die Töne selbst
  // stehen als Hex und liegen damit von vornherein darin; geprüft werden
  // deshalb vor allem die drei Flächen.
  const findings = [];
  let checked = 0;
  for (const testCase of READ) {
    for (const [token, surface] of testCase.surfaces) {
      if (surface === null) continue;
      checked += 1;
      if (!inGamut(surface.linear)) findings.push(`${testCase.name}: ${token} = ${surface.raw}`);
    }
    for (const [name, tone] of testCase.tones) {
      if (tone === null || tone.linear === null) continue;
      checked += 1;
      if (!inGamut(tone.linear)) findings.push(`${testCase.name}: --terminal-ansi-${name} = ${tone.raw}`);
    }
  }
  assert.equal(checked, 57, `${checked} Farben geprüft, erwartet 57 (3 Lagen × (3 Flächen + 16 Töne)).`);
  assert.deepEqual(findings, [], `Außerhalb des sRGB-Raums:\n${findings.join("\n")}`);
});

test("zurück auf Dunkel ist vollständig — dunkles Terminal im hellen Hub", () => {
  // ⚠️ Der Fall, den die Verkettung `[data-scheme="light"][data-terminal-scheme="dark"]`
  // trägt, und die Falle darin: ein vergessener Wert ließe eine HELLE Fläche
  // unter dunklen Tönen stehen. Verglichen wird deshalb nicht „sieht dunkel
  // aus", sondern Wert für Wert gegen die Lage „dunkler Hub".
  const dark = READ[0];
  const darkInLight = READ[2];

  const findings = [];
  for (const token of SURFACE_TOKENS) {
    const expected = dark.surfaces.get(token)?.raw ?? null;
    const actual = darkInLight.surfaces.get(token)?.raw ?? null;
    if (expected !== actual) findings.push(`${token}: „${actual}" statt „${expected}"`);
  }
  for (const name of ANSI_NAMES) {
    const expected = dark.tones.get(name)?.raw ?? null;
    const actual = darkInLight.tones.get(name)?.raw ?? null;
    if (expected !== actual) findings.push(`--terminal-ansi-${name}: „${actual}" statt „${expected}"`);
  }
  // Vordergrund und Rahmen gehören dazu: sie sind Aliasse auf Token des Hubs
  // und zeigten sonst auf die hellen Werte.
  for (const token of ["--terminal-foreground", "--terminal-border"]) {
    const expected = resolve(dark.values, token);
    const actual = resolve(darkInLight.values, token);
    if (expected !== actual) findings.push(`${token}: „${actual}" statt „${expected}"`);
  }

  assert.deepEqual(
    findings,
    [],
    `Das dunkle Terminal im hellen Hub trägt Werte des hellen Satzes:\n${findings.join("\n")}`
  );
});

test("die Rechnung selbst: Umrechnung, Helligkeit und Kontrast", () => {
  // Eine falsche Umrechnung machte diesen Wächter wertlos und fiele niemandem
  // auf. Die Vergleichswerte sind anderswo nachzuschlagen und nicht aus
  // derselben Rechnung gewonnen.
  const findings = [];
  const close = (description, actual, expected, tolerance) => {
    if (Math.abs(actual - expected) > tolerance) {
      findings.push(`${description}: ${actual} statt ${expected} (±${tolerance})`);
    }
  };

  // Schwarz auf Weiß ist 21:1 — die Obergrenze der Skala (WCAG 2.1, WebAIM).
  close("Kontrast Weiß/Schwarz", contrastRatio(hexToLinearSrgb("#ffffff"), hexToLinearSrgb("#000000")), 21, 0.01);
  // #767676 auf Weiß ist der bekannte Grenzfall von 4,5 (WebAIM).
  close("Kontrast #767676 auf Weiß", contrastRatio(hexToLinearSrgb("#767676"), hexToLinearSrgb("#ffffff")), 4.54, 0.02);
  // Helligkeit von Weiß ist 1, von Schwarz 0.
  close("Hex-Umrechnung Weiß", hexToLinearSrgb("#ffffff")[0], 1, 0.0001);
  close("Hex-Umrechnung Schwarz", hexToLinearSrgb("#000000")[2], 0, 0.0001);
  // oklch(1 0 0) ist Weiß, oklch(0 0 0) Schwarz (CSS Color Module Level 4).
  close("oklch(1 0 0) ist Weiß", oklchToLinearSrgb(1, 0, 0)[1], 1, 0.001);
  close("oklch(0 0 0) ist Schwarz", oklchToLinearSrgb(0, 0, 0)[1], 0, 0.001);

  // Der Gamut-Test sagt nein, wenn er nein sagen muss: eine sehr bunte Farbe
  // bei hoher Helligkeit liegt außerhalb.
  if (inGamut(oklchToLinearSrgb(0.9, 0.4, 145))) findings.push("inGamut hält oklch(0.9 0.4 145) für darstellbar");
  if (!inGamut(oklchToLinearSrgb(0.5, 0.05, 145))) findings.push("inGamut hält oklch(0.5 0.05 145) für nicht darstellbar");

  // Und der Leser: `parseOklch` liest die Form, die in `tokens.css` steht.
  assert.deepEqual(parseOklch("oklch(0.165 0.008 265)"), [0.165, 0.008, 265]);
  assert.equal(parseOklch("var(--card)"), null);

  assert.deepEqual(findings, [], `Die Rechnung dieses Wächters stimmt nicht:\n${findings.join("\n")}`);
});
