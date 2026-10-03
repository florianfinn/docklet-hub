import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripCssComments } from "./strip-comments.mjs";

// Wächter über den Kontrast jedes Presets aus D7a (#62) gegen WCAG 2.2 AA.
//
// Gerechnet wird jede Kombination aus Schema × Sättigung × Farbton auf den
// drei Flächen `--background`, `--card` und `--muted`. Ein Preset, das
// durchfällt, kommt nicht in die Liste — das ist der Sinn der Übung.
//
// ═══════════════════════════════════════════════════════════════════════════
// WOHER DIE ZAHLEN KOMMEN — die eigentliche Frage dieses Wächters
// ═══════════════════════════════════════════════════════════════════════════
//
// Ein Kontrasttest mit einer EIGENEN Kopie der Helligkeits- und
// Buntheitswerte prüft sich selbst und nicht das Stylesheet: jemand ändert
// `palette.css`, der Test bleibt grün, und die Fläche ist unlesbar. Deshalb
// trägt diese Datei KEINE Farbzahl. Sie liest `tokens.css` und `palette.css`,
// baut daraus die Kaskade für ein gedachtes <html> und ein gedachtes Kind mit
// eigener Palette nach und rechnet die fertigen `oklch()`-Werte aus.
//
// Die einzigen Zahlen hier sind die beiden Schwellen aus WCAG 2.2 (4.5 für
// Text nach 1.4.3, 3.0 für Nichttext nach 1.4.11) und die Zuordnung, welcher
// Token welche Rolle spielt. Beides ist Norm und Entwurfsentscheidung, keine
// Kopie des Stylesheets.
//
// Der zweite Weg — beide lesen dieselben Daten, ein Wächter hält Stylesheet
// und Daten gegeneinander — ist damit nicht ersetzt, sondern ergänzt: die
// STUFENLISTEN (welche Töne, welche Sättigungsstufen es gibt) stehen in
// `contract/src/presets.ts`, und `web/tests/theme-presets.test.mjs` hält
// sie gegen dieselben Stylesheets. Die Aufteilung folgt daraus, wer die
// Wahrheit besitzt: WELCHE Presets es gibt, entscheidet die Preset-Datei —
// WIE ein Preset aussieht, entscheidet allein das Stylesheet. Ein Test, der
// das Aussehen aus der Preset-Datei läse, prüfte wieder nur sich selbst.
//
// ═══════════════════════════════════════════════════════════════════════════
// DIE UMRECHNUNG
// ═══════════════════════════════════════════════════════════════════════════
//
// oklch → OKLab → linear sRGB → sRGB und die Kontrastformel sind hier selbst
// geschrieben (AGENTS.md: „Was in zwanzig Zeilen selbst geschrieben ist, wird
// selbst geschrieben"). Eine falsche Umrechnung machte den ganzen Test
// wertlos und fiele niemandem auf, deshalb steht ihr eigener Test ganz unten
// und belegt sie an fünf Farben und drei Kontrastwerten gegen unabhängige
// Quellen (CSS Color Module Level 4 / Ottossons Oklab-Matrizen, WebAIM).
//
// ⚠️ NICHT geprüft, und bewusst so:
//   - `--accent`, `--accent-firm`, `--accent-strong`, `--ring`, `--border`,
//     `--input`: alle mit Alpha. Ihr sichtbarer Wert entsteht erst aus der
//     Überlagerung mit dem, was darunter liegt, und das ist eine Frage des
//     Bauteils, nicht des Tokens. Was auf ihnen steht, ist über
//     `--accent-foreground` gegen die drei Grundflächen mit abgedeckt.
//   - `--popover` und `--secondary` als Flächen: der Auftrag nennt drei
//     Flächen, und diese beiden tragen dieselben Textwerte wie `--card`, nur
//     mit größerem Abstand zum Grund.
//   - ob eine Farbe im sRGB-Gamut liegt. Ein oklch außerhalb wird hier
//     abgeschnitten; ein Browser bildet stattdessen ab. Für den Kontrast ist
//     der Unterschied klein, für die Erscheinung nicht — das sieht das Auge
//     am Schirm, nicht dieser Test.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOKENS_PATH = "web/src/platform/theme/tokens.css";
const PALETTE_PATH = "web/src/platform/theme/palette.css";

// WCAG 2.2. 1.4.3 Kontrast (Minimum) für Text, 1.4.11 Nichttext-Kontrast für
// grafische Objekte und Bedienelemente.
const AA_TEXT = 4.5;
const AA_GRAPHIC = 3.0;

// ---------------------------------------------------------------------------
// Farbrechnung
// ---------------------------------------------------------------------------

// oklch → sRGB, jeder Kanal in 0…1, gamma-kodiert.
// OKLab-Matrizen nach Björn Ottosson, wie sie CSS Color Module Level 4 für
// `oklch()` vorschreibt. Außerhalb des Gamuts wird linear abgeschnitten.
export function oklchToRgb(lightness, chroma, hue) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const long = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const medium = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const short = lightness - 0.0894841775 * a - 1.2914855480 * b;
  const l = long ** 3;
  const m = medium ** 3;
  const s = short ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ]
    .map((value) => Math.min(1, Math.max(0, value)))
    .map((value) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
}

// Relative Leuchtdichte nach WCAG 2.2, Definition „relative luminance".
export function relativeLuminance([red, green, blue]) {
  const [r, g, b] = [red, green, blue].map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Kontrastverhältnis nach WCAG 2.2, Definition „contrast ratio".
export function contrastRatio(front, back) {
  const a = relativeLuminance(front);
  const b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------------------------------------------------------------------------
// Ein sehr kleines Stück CSS-Maschine: genug, um diese zwei Dateien zu lesen
// ---------------------------------------------------------------------------

// Entfernt `@theme inline { … }` und `@layer … { … }` mitsamt Inhalt. Beide
// tragen keine Farbe, die hier zählt — `@theme inline` nur Zuordnungen auf
// Namen von oben, `@layer base` nur `color-scheme`, `body` und den Fokusstil.
// Klammern werden gezählt, nicht gesucht: ein `}` in einer Zeichenkette gibt
// es in diesen Dateien nicht, verschachtelte Blöcke sehr wohl.
export function removeAtBlocks(css) {
  let result = "";
  let index = 0;
  while (index < css.length) {
    const next = css.indexOf("@", index);
    if (next === -1) {
      result += css.slice(index);
      break;
    }
    const isBlock = /^@(theme|layer|media|supports)\b/.test(css.slice(next));
    if (!isBlock) {
      result += css.slice(index, next + 1);
      index = next + 1;
      continue;
    }
    result += css.slice(index, next);
    let depth = 0;
    let cursor = css.indexOf("{", next);
    if (cursor === -1) break;
    for (; cursor < css.length; cursor += 1) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
  return result;
}

// Zerlegt das Stylesheet in Regeln. Reihenfolge bleibt erhalten — auf ihr
// steht in dieser Schicht alles, siehe die Kommentare in beiden Dateien.
export function parseRules(css) {
  const rules = [];
  for (const match of removeAtBlocks(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .split(",")
      .map((piece) => piece.trim())
      .filter(Boolean);
    const declarations = new Map();
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim();
      if (!name.startsWith("--")) continue;
      declarations.set(name, declaration.slice(colon + 1).trim());
    }
    if (declarations.size > 0) rules.push({ selectors, declarations });
  }
  return rules;
}

// Passt ein Selektor auf ein Element mit diesen Attributen? `isRoot` sagt, ob
// es sich um <html> handelt — nur dort greift `:root`.
export function selectorMatches(selector, attributes, isRoot) {
  if (selector === ":root") return isRoot;
  const match = /^\[([\w-]+)(?:="?([^\]"]*)"?)?\]$/.exec(selector);
  if (!match) return false;
  const [, name, value] = match;
  if (!(name in attributes)) return false;
  return value === undefined || attributes[name] === value;
}

// Baut die Umgebung eines Elements: erst <html> (mit `:root`), dann — falls es
// ein Kind mit eigener Palette gibt — dessen eigene Deklarationen darüber.
// Bei gleicher Spezifität gewinnt die spätere Regel, deshalb wird schlicht in
// Dateireihenfolge überschrieben; alle Selektoren dieser beiden Dateien sind
// (0,1,0), `:root` eingeschlossen.
export function buildEnvironment(rules, htmlAttributes, elementAttributes) {
  const environment = new Map();
  for (const rule of rules) {
    if (rule.selectors.some((selector) => selectorMatches(selector, htmlAttributes, true))) {
      for (const [name, value] of rule.declarations) environment.set(name, value);
    }
  }
  if (!elementAttributes) return environment;
  for (const rule of rules) {
    if (rule.selectors.some((selector) => selectorMatches(selector, elementAttributes, false))) {
      for (const [name, value] of rule.declarations) environment.set(name, value);
    }
  }
  return environment;
}

// Ersetzt jedes `var(--x)` durch seinen Wert, so oft, bis keines mehr da ist.
export function expandVariables(environment, text) {
  let result = text;
  for (let round = 0; round < 20; round += 1) {
    if (!result.includes("var(")) return result;
    result = result.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_whole, name) => {
      assert.ok(environment.has(name), `var(${name}) ist nirgends deklariert (in „${text}")`);
      return environment.get(name);
    });
  }
  throw new Error(`var() löst sich nicht auf — Kreis in „${text}"?`);
}

// Rechnet einen Zahlenausdruck aus: Zahl, Prozent, `calc()`, `min()`, `max()`,
// Klammern, + - * /. Mehr steht in diesen beiden Dateien nicht.
export function evaluateNumber(text) {
  let index = 0;
  const skip = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  const expect = (character) => {
    skip();
    assert.equal(text[index], character, `„${character}" erwartet in „${text}" bei Position ${index}`);
    index += 1;
  };
  function parseExpression() {
    let value = parseTerm();
    for (;;) {
      skip();
      if (text[index] === "+") {
        index += 1;
        value += parseTerm();
      } else if (text[index] === "-") {
        index += 1;
        value -= parseTerm();
      } else {
        return value;
      }
    }
  }
  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      skip();
      if (text[index] === "*") {
        index += 1;
        value *= parseFactor();
      } else if (text[index] === "/") {
        index += 1;
        value /= parseFactor();
      } else {
        return value;
      }
    }
  }
  function parseFactor() {
    skip();
    for (const name of ["calc", "min", "max"]) {
      if (text.startsWith(`${name}(`, index)) {
        index += name.length + 1;
        const values = [parseExpression()];
        for (;;) {
          skip();
          if (text[index] !== ",") break;
          index += 1;
          values.push(parseExpression());
        }
        expect(")");
        if (name === "min") return Math.min(...values);
        if (name === "max") return Math.max(...values);
        return values[0];
      }
    }
    if (text[index] === "(") {
      index += 1;
      const value = parseExpression();
      expect(")");
      return value;
    }
    if (text[index] === "-") {
      index += 1;
      return -parseFactor();
    }
    const number = /^[0-9]*\.?[0-9]+%?/.exec(text.slice(index));
    assert.ok(number, `keine Zahl in „${text}" bei Position ${index}`);
    index += number[0].length;
    return number[0].endsWith("%") ? Number(number[0].slice(0, -1)) / 100 : Number(number[0]);
  }
  const value = parseExpression();
  skip();
  assert.equal(index, text.length, `Rest „${text.slice(index)}" in „${text}" nicht gelesen`);
  return value;
}

// Trennt an Leerzeichen der obersten Ebene — `calc(a - b)` bleibt ein Stück.
function splitComponents(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && /\s/.test(character)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

// Löst einen Tokennamen zu sRGB auf. Alpha wird abgeschnitten und gemeldet:
// eine Farbe mit Alpha hat keinen eigenen Kontrast, sie hat einen Untergrund.
export function resolveColor(environment, tokenName) {
  assert.ok(environment.has(tokenName), `${tokenName} ist in dieser Kombination nicht deklariert`);
  const expanded = expandVariables(environment, environment.get(tokenName)).trim();
  const inside = /^oklch\(([\s\S]*)\)$/.exec(expanded);
  assert.ok(inside, `${tokenName} ist kein oklch(): „${expanded}"`);
  const [color, alpha] = inside[1].split("/");
  const components = splitComponents(color.trim());
  assert.equal(components.length, 3, `${tokenName} hat ${components.length} Anteile: „${expanded}"`);
  return {
    rgb: oklchToRgb(...components.map(evaluateNumber)),
    alpha: alpha === undefined ? 1 : evaluateNumber(alpha.trim())
  };
}

// ---------------------------------------------------------------------------
// Der Lauf über alle Presets
// ---------------------------------------------------------------------------

const RULES = parseRules(
  stripCssComments(readFileSync(path.join(ROOT, TOKENS_PATH), "utf8")) +
    "\n" +
    stripCssComments(readFileSync(path.join(ROOT, PALETTE_PATH), "utf8"))
);

// Welche Stufen es gibt, wird NICHT hier behauptet, sondern aus den
// Umschaltern im Stylesheet gelesen. Kommt eine Sättigungsstufe oder ein Ton
// hinzu, läuft dieser Test ohne Zutun mit darüber.
function attributeValues(attribute) {
  const values = new Set();
  for (const rule of RULES) {
    for (const selector of rule.selectors) {
      const match = new RegExp(`^\\[${attribute}="?([^\\]"]+)"?\\]$`).exec(selector);
      if (match) values.add(match[1]);
    }
  }
  return [...values];
}

// „dark" hat keine eigene Regel: `:root` trägt den dunklen Satz.
const SCHEMES = ["dark", ...attributeValues("data-scheme")];
const CHROMA_STEPS = attributeValues("data-chroma");
const HUES = attributeValues("data-hue");
const AREAS = attributeValues("data-area");

// Die vier Ebenen aus D0 §2. Der Ton steht am selben Element wie die Ebene —
// ein Host mit eigenem Ton trägt beide Attribute, und `[data-hue="neutral"]`
// überschreibt dabei die Sättigung der Ebene, weil es später im Stylesheet
// steht.
const LEVELS = [
  { name: "host", attributes: (hue) => ({ "data-host": "", "data-hue": hue }) },
  { name: "mark", attributes: (hue) => ({ "data-mark": "", "data-hue": hue }) },
  { name: "base", attributes: null }
];

const SURFACES = ["--background", "--card", "--muted"];

// Welche Rolle ein Token spielt, und damit, welche Schwelle für es gilt.
const ON_SURFACE = [
  { token: "--primary", threshold: AA_TEXT },
  { token: "--accent-foreground", threshold: AA_TEXT },
  { token: "--chart-1", threshold: AA_GRAPHIC },
  { token: "--chart-2", threshold: AA_GRAPHIC },
  { token: "--chart-3", threshold: AA_GRAPHIC },
  { token: "--chart-4", threshold: AA_GRAPHIC },
  { token: "--chart-5", threshold: AA_GRAPHIC }
];

function label(scheme, chromaStep, level, hue, surface, token) {
  return `${scheme}/${chromaStep}/${level}/${hue} — ${token} auf ${surface}`;
}

test("die Stufen kommen aus dem Stylesheet und nicht aus diesem Test", () => {
  assert.ok(SCHEMES.length >= 2, `nur ${SCHEMES.length} Schema-Stufe(n) gefunden — Muster geändert?`);
  assert.ok(CHROMA_STEPS.length >= 3, `nur ${CHROMA_STEPS.length} Sättigungsstufen gefunden`);
  assert.ok(HUES.length >= 7, `nur ${HUES.length} Töne gefunden`);
  assert.ok(AREAS.length >= 2, `nur ${AREAS.length} Bereichstöne gefunden`);
});

test("jede Kombination aus Schema, Sättigung und Farbton hält WCAG AA auf den drei Flächen", () => {
  const findings = [];
  let checked = 0;
  for (const scheme of SCHEMES) {
    const html = { "data-scheme": scheme };
    for (const chromaStep of CHROMA_STEPS) {
      const htmlAttributes = { ...html, "data-chroma": chromaStep };
      for (const level of LEVELS) {
        const tones = level.attributes ? HUES : [null];
        for (const hue of tones) {
          const element = level.attributes ? level.attributes(hue) : null;
          const environment = buildEnvironment(RULES, htmlAttributes, element);
          for (const surface of SURFACES) {
            const back = resolveColor(environment, surface);
            for (const { token, threshold } of ON_SURFACE) {
              const front = resolveColor(environment, token);
              const ratio = contrastRatio(front.rgb, back.rgb);
              checked += 1;
              if (ratio < threshold) {
                findings.push(
                  `${label(scheme, chromaStep, level.name, hue ?? "—", surface, token)}: ` +
                    `${ratio.toFixed(2)}:1 < ${threshold}:1`
                );
              }
            }
          }
        }
      }
    }
  }
  assert.ok(checked > 0, "nichts gerechnet — die Stufen kamen leer aus dem Stylesheet");
  assert.deepEqual(
    findings,
    [],
    `Presets unter WCAG AA (${checked} Paare gerechnet):\n${findings.join("\n")}`
  );
});

test("die zwei Bereichstöne halten WCAG AA auf den drei Flächen", () => {
  const findings = [];
  for (const scheme of SCHEMES) {
    for (const chromaStep of CHROMA_STEPS) {
      for (const area of AREAS) {
        const environment = buildEnvironment(
          RULES,
          { "data-scheme": scheme, "data-chroma": chromaStep },
          { "data-area": area }
        );
        for (const surface of SURFACES) {
          const back = resolveColor(environment, surface);
          for (const { token, threshold } of ON_SURFACE) {
            const ratio = contrastRatio(resolveColor(environment, token).rgb, back.rgb);
            if (ratio < threshold) {
              findings.push(`${scheme}/${chromaStep}/${area} — ${token} auf ${surface}: ${ratio.toFixed(2)}:1 < ${threshold}:1`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(findings, [], `Bereichstöne unter WCAG AA:\n${findings.join("\n")}`);
});

test("die Schrift auf der Kennfarbe und auf der Ausfallfarbe hält WCAG AA", () => {
  // Diese beiden Paare stehen nicht auf einer der drei Flächen, sondern
  // aufeinander: `--primary-foreground` liegt auf `--primary`,
  // `--destructive-foreground` auf `--destructive`. Ein Preset, dessen
  // Kennfarbe zu hell für dunkle und zu dunkel für helle Schrift ist, fällt
  // genau hier auf und sonst nirgends — es ist die Falle, in die der helle
  // Satz bei der Helligkeit aus dem Artboard gelaufen wäre.
  const findings = [];
  for (const scheme of SCHEMES) {
    for (const chromaStep of CHROMA_STEPS) {
      for (const hue of HUES) {
        const environment = buildEnvironment(
          RULES,
          { "data-scheme": scheme, "data-chroma": chromaStep },
          { "data-host": "", "data-hue": hue }
        );
        const ratio = contrastRatio(
          resolveColor(environment, "--primary-foreground").rgb,
          resolveColor(environment, "--primary").rgb
        );
        if (ratio < AA_TEXT) {
          findings.push(`${scheme}/${chromaStep}/${hue} — --primary-foreground auf --primary: ${ratio.toFixed(2)}:1 < ${AA_TEXT}:1`);
        }
      }
      const environment = buildEnvironment(RULES, { "data-scheme": scheme, "data-chroma": chromaStep }, null);
      const ratio = contrastRatio(
        resolveColor(environment, "--destructive-foreground").rgb,
        resolveColor(environment, "--destructive").rgb
      );
      if (ratio < AA_TEXT) {
        findings.push(`${scheme}/${chromaStep} — --destructive-foreground auf --destructive: ${ratio.toFixed(2)}:1 < ${AA_TEXT}:1`);
      }
    }
  }
  assert.deepEqual(findings, [], `Schrift auf farbiger Fläche unter WCAG AA:\n${findings.join("\n")}`);
});

test("die schemaabhängigen Textwerte und Zustandsfarben halten WCAG AA", () => {
  const findings = [];
  for (const scheme of SCHEMES) {
    const environment = buildEnvironment(RULES, { "data-scheme": scheme }, null);
    for (const surface of SURFACES) {
      const back = resolveColor(environment, surface);
      for (const [token, threshold] of [
        ["--foreground", AA_TEXT],
        ["--muted-foreground", AA_TEXT],
        ["--state-ok", AA_GRAPHIC],
        ["--state-warn", AA_GRAPHIC],
        ["--state-down", AA_GRAPHIC]
      ]) {
        const ratio = contrastRatio(resolveColor(environment, token).rgb, back.rgb);
        if (ratio < threshold) findings.push(`${scheme} — ${token} auf ${surface}: ${ratio.toFixed(2)}:1 < ${threshold}:1`);
      }
    }
  }
  assert.deepEqual(findings, [], `Textwerte oder Zustandsfarben unter WCAG AA:\n${findings.join("\n")}`);
});

// ⚠️ EIN BEFUND, DER NICHT STILL BLEIBEN DARF, UND WARUM ER HIER EINE EIGENE
// SCHWELLE HAT
//
// `--subtle-foreground` ist die dritte Textstufe. Im DUNKLEN Satz stammt sie
// zeichengenau aus dem Artboard (`--fg3`, color-system.html Z. 25) und
// erreicht auf `--card` 4.27:1 und auf `--muted` 4.44:1 — beides unter den
// 4.5:1, die WCAG 1.4.3 für normalen Text verlangt. Das ist ein Befund an D1
// beziehungsweise am Artboard, nicht an D7a.
//
// Er wird hier weder stillgelegt noch heimlich repariert:
//   - Repariert nicht, weil der dunkle Satz aus D0/D1 stammt und ein
//     eigenmächtig geänderter Grundwert des ganzen Hauses in D7a nichts zu
//     suchen hat. Er steht als Befund in der Rückmeldung.
//   - Stillgelegt nicht, weil eine Sperrklinke auf dem GEMESSENEN Wert
//     verhindert, dass es je schlechter wird. Wer die Zahl senkt, muss sie
//     hier senken, und das sieht man im Diff.
// Der HELLE Satz, der in D7a entstanden ist, hält die 4.5:1 (4.54:1 auf der
// schlechtesten der drei Flächen) — er ist deshalb der einzige, der hier mit
// der vollen Schwelle geprüft wird.
const SUBTLE_RATCHET = 4.25;

test("--subtle-foreground: hell hält AA, dunkel bleibt auf dem gemessenen Stand", () => {
  const findings = [];
  for (const scheme of SCHEMES) {
    const environment = buildEnvironment(RULES, { "data-scheme": scheme }, null);
    const threshold = scheme === "dark" ? SUBTLE_RATCHET : AA_TEXT;
    for (const surface of SURFACES) {
      const ratio = contrastRatio(
        resolveColor(environment, "--subtle-foreground").rgb,
        resolveColor(environment, surface).rgb
      );
      if (ratio < threshold) {
        findings.push(`${scheme} — --subtle-foreground auf ${surface}: ${ratio.toFixed(2)}:1 < ${threshold}:1`);
      }
    }
  }
  assert.deepEqual(findings, [], `Dritte Textstufe unter ihrer Schwelle:\n${findings.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Die Umrechnung selbst — ein Wächter ohne eigenen Test ist eine Behauptung
// ---------------------------------------------------------------------------

test("oklch nach sRGB, belegt gegen unabhängige Quellen", () => {
  const toBytes = (rgb) => rgb.map((value) => Math.round(value * 255));

  // Die drei sRGB-Grundfarben in oklch, wie sie CSS Color Module Level 4 für
  // die Umrechnung angibt (dieselben Werte liefern colorjs.io und culori).
  // Sie sind der schärfste Beleg, den es gibt: jede der drei prüft eine andere
  // Zeile der Matrix, und jede muss auf das Byte genau zurückkommen.
  assert.deepEqual(toBytes(oklchToRgb(0.6279554, 0.2576833, 29.2338851)), [255, 0, 0]);
  assert.deepEqual(toBytes(oklchToRgb(0.8664396, 0.2948272, 142.4953480)), [0, 255, 0]);
  assert.deepEqual(toBytes(oklchToRgb(0.4520137, 0.3132145, 264.0520000)), [0, 0, 255]);
  // Die beiden Endpunkte der Helligkeitsachse.
  assert.deepEqual(toBytes(oklchToRgb(1, 0, 0)), [255, 255, 255]);
  assert.deepEqual(toBytes(oklchToRgb(0, 0, 0)), [0, 0, 0]);

  // Kontrast: Weiß auf Schwarz ist per Definition 21:1. Die beiden Grauwerte
  // sind die von WebAIM veröffentlichten Schwellenfälle — #767676 ist das
  // dunkelste Grau, das auf Weiß gerade noch AA erreicht, #595959 das für AAA.
  const gray = (byte) => [byte / 255, byte / 255, byte / 255];
  assert.equal(contrastRatio([1, 1, 1], [0, 0, 0]).toFixed(2), "21.00");
  assert.equal(contrastRatio(gray(0x76), [1, 1, 1]).toFixed(2), "4.54");
  assert.equal(contrastRatio(gray(0x59), [1, 1, 1]).toFixed(2), "7.00");
});

test("die kleine CSS-Maschine selbst: Ausdruck, Selektor, Kaskade", () => {
  assert.equal(evaluateNumber("0.78"), 0.78);
  assert.equal(evaluateNumber("calc(0.78 - 0.08)").toFixed(2), "0.70");
  assert.equal(evaluateNumber("calc(265 + 22 * 0)"), 265);
  assert.equal(evaluateNumber("calc(265 - 26 * 1)"), 239);
  assert.equal(evaluateNumber("min(calc(0.145 * 1.3), 0.215)").toFixed(4), "0.1885");
  assert.equal(evaluateNumber("min(calc(0.19 * 1.3), 0.215)"), 0.215);
  assert.equal(evaluateNumber("45%"), 0.45);

  assert.equal(selectorMatches(":root", {}, true), true);
  assert.equal(selectorMatches(":root", {}, false), false);
  assert.equal(selectorMatches('[data-hue="amber"]', { "data-hue": "amber" }, false), true);
  assert.equal(selectorMatches('[data-hue="amber"]', { "data-hue": "green" }, false), false);
  assert.equal(selectorMatches("[data-host]", { "data-host": "" }, false), true);
  assert.equal(selectorMatches("[data-host]", { "data-hue": "amber" }, false), false);

  // Die spätere Regel gewinnt bei gleicher Spezifität, und ein Kind erbt, was
  // es nicht selbst setzt.
  const rules = parseRules(":root { --a: 1; --b: 9; }\n[data-x=\"on\"] { --a: 2; }\n[data-y] { --b: 3; }");
  const environment = buildEnvironment(rules, { "data-x": "on" }, { "data-y": "" });
  assert.equal(environment.get("--a"), "2");
  assert.equal(environment.get("--b"), "3");
  assert.equal(expandVariables(new Map([["--c", "0.2"]]), "calc(var(--c) * 2)"), "calc(0.2 * 2)");

  // @theme und @layer werden mitsamt Inhalt entfernt, auch verschachtelt.
  assert.equal(parseRules("@layer base { :root { --a: 1; } }\n:root { --b: 2; }").length, 1);
});
