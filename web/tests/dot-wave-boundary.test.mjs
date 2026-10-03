import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments, stripCssComments } from "./strip-comments.mjs";

// Wächter über die LAGE und die MODULGRENZE von `web/src/platform/ui/dot-wave/`.
// Vertrag: `scratchpad/d4-spec.md`, Abschnitt 5.6.
//
// Die Geschwisterdatei `dot-wave.test.mjs` prüft die RECHNUNG und die FARBE
// desselben Moduls. Getrennt sind die beiden, weil eine Datei über 1.000
// Zeilen im Repo nicht zulässig ist (Wächter `source-file-size`) — nicht,
// weil die Zusagen auseinandergehörten. Wer eine der beiden Dateien liest,
// liest die halbe Zusage; der Kopf der anderen nennt sie.
//
// GEPRÜFT WIRD, drei Zusicherungen:
//   1. `.dot-wave` streckt sich über seinen Kasten (`width`/`height: 100%`) —
//      die Regression, die als `de5bc8d` schon einmal behoben wurde,
//   2. `wave-field.ts` greift auch nicht über `globalThis` auf den Browser,
//   3. der Selektor `.dot-wave` steht nur im Modulordner.
//
// Alle drei sind NACHTRÄGLICH entstanden, und zwar so: ein Prüfer hat das
// fertige Paket angegriffen, für jede Lücke eine Probe gestellt und gemessen,
// dass die ganze Kette dabei grün blieb. Was hier steht, ist die Antwort auf
// je eine solche Probe — die Messung steht bei der Prüfung.
//
// ⚠️ GELESEN WIRD ÜBER `readdirSync`, NICHT ÜBER `git ls-files` — wie in der
// Geschwisterdatei. Eine Datei, die noch nicht mit `git add` erfasst ist, ist
// für `git ls-files` UNSICHTBAR (gemessen in D2); ein Wächter, der so liest,
// zeigt vor dem Commit ein zu freundliches Bild.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MODULE_DIRECTORY = "web/src/platform/ui/dot-wave";
const SOURCE_ROOT = "web/src";

const WAVE_FIELD_PATH = `${MODULE_DIRECTORY}/wave-field.ts`;
const STYLE_PATH = `${MODULE_DIRECTORY}/dot-wave.css`;

function readOrFail(relativePath, hint) {
  const absolute = new URL(relativePath, `file://${ROOT}`);
  assert.ok(existsSync(absolute), `Datei fehlt: ${relativePath} — ${hint}`);
  return readFileSync(absolute, "utf8");
}

// Zeilennummer zu einer Fundstelle.
function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

function collectFiles(relativeDirectory, extensions) {
  const absolute = new URL(`${relativeDirectory}/`, `file://${ROOT}`);
  if (!existsSync(absolute)) return [];
  const found = [];
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory() || statSync(new URL(relative, `file://${ROOT}`)).isDirectory()) {
      found.push(...collectFiles(relative, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(relative);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. Die Leinwand streckt sich über ihren Kasten
// ---------------------------------------------------------------------------
//
// ZWECK: `.dot-wave` trägt `width: 100%` und `height: 100%`. Diese zwei Zeilen
// sind der Unterschied zwischen einem Grund über der ganzen Fläche und einem
// 300×150 großen Fleck in der linken oberen Ecke.
//
// ⚠️ WARUM `inset: 0` DAFÜR NICHT REICHT — das ist der ganze Grund, warum es
// diese Prüfung gibt: `canvas` ist ein ERSETZTES Element. Bei `width: auto`
// gilt seine EIGENE Größe, und die ist ohne Attribute 300×150. Die überzählige
// Angabe wird dann aufgelöst, indem `right` und `bottom` fallen — der Kasten
// bleibt 300×150 und klebt oben links. Bei einem NICHT ersetzten Element (etwa
// einem `div`) würde dieselbe Regel strecken; genau dieser Unterschied stellt
// die Falle, weil `inset: 0` bei allem anderen im Repo funktioniert.
//
// FÄNGT: das Aufräumen. Die beiden Zeilen sehen neben `inset: 0` wie eine
// Dopplung aus, und wer CSS aufräumt, streicht Dopplungen.
//
// OHNE DIESE PRÜFUNG: nichts meldet es. Gemessen am 2026-09-05, die beiden
// Zeilen entfernt: `pnpm run lint` code=0, die ganze Wächterkette
// `# tests 91 / # pass 91 / # fail 0`, `pnpm --filter web run build` code=0 —
// und im gebauten Bildschirm meldete `getBoundingClientRect()` der Leinwand
// 300×150 statt 1280×900. Das war der teuerste Fund dieses Pakets und ist als
// `de5bc8d` einmal schon behoben worden; ohne Wächter kommt er wieder.
test(".dot-wave streckt sich über seinen Kasten", () => {
  const content = stripCssComments(
    readOrFail(STYLE_PATH, "Lage und Maske des Grundes (Vertrag, Abschnitt 5.6)")
  );

  // Der Block zum Selektor `.dot-wave` — und NICHT der zu `.dot-wave-ink`, das
  // `display: none` trägt und sich zu Recht nicht streckt. Die Wortgrenze nach
  // dem Namen trennt die beiden.
  const block = content.match(/\.dot-wave(?![\w-])\s*\{([^}]*)\}/);

  const findings = [];
  if (block === null) {
    findings.push(
      `${STYLE_PATH}: kein Block zum Selektor .dot-wave gefunden — umbenannt oder verschoben`
    );
  } else {
    for (const property of ["width", "height"]) {
      if (!new RegExp(`(^|[;{\\s])${property}\\s*:\\s*100%`).test(block[1])) {
        findings.push(
          `${STYLE_PATH}: .dot-wave trägt kein „${property}: 100%" — eine canvas ist ein ERSETZTES Element, ` +
            `inset: 0 streckt sie NICHT, und der Grund fällt auf seine Eigengröße 300×150 in der linken oberen Ecke zurück`
        );
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Die Leinwand füllt ihren Kasten, statt 300×150 zu bleiben (behoben in de5bc8d):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 2. Die Rechnung kommt auch nicht HINTENHERUM an den Browser
// ---------------------------------------------------------------------------
//
// ZWECK: Regel 1 und 2 aus Abschnitt 5.6 — `wave-field.ts` kennt weder React
// noch das DOM, und nur `DotWave.tsx` fasst den Browser an.
//
// FÄNGT: den Weg um Prüfung 1 herum. Die verbietet die Zeile `import` — und
// genau das ist ihre Grenze: `globalThis as unknown as { document: … }` ist
// KEIN Import und holt trotzdem `document.documentElement` und
// `devicePixelRatio` in die Rechnung. Gemessen am 2026-09-05: mit diesem Griff
// blieb die ganze Kette grün.
//
// OHNE DIESE PRÜFUNG: die Datei sähe importfrei aus und wäre es nicht mehr.
// Mit dem ersten Zugriff auf den Browser fallen die Prüfungen 4 und 5 mit, die
// als einzige RECHNEN statt zu lesen — sie können die Rechnung dann nicht mehr
// ohne Browser laden. Der Schnitt, den die Datei begründet, wäre nur noch eine
// Behauptung in ihrem Kopfkommentar.
test("wave-field.ts greift auch nicht über globalThis auf den Browser", () => {
  const content = stripComments(
    readOrFail(WAVE_FIELD_PATH, "die Rechnung des Moduls (Vertrag, Abschnitt 5.6, Regel 1 und 2)")
  );

  // `Math` ist erlaubt und steht bewusst nicht in dieser Liste.
  const FORBIDDEN = ["globalThis", "document", "window", "navigator", "self"];

  const findings = [];
  for (const name of FORBIDDEN) {
    const pattern = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
    for (const match of content.matchAll(pattern)) {
      findings.push(
        `${WAVE_FIELD_PATH}:${lineOf(content, match.index)}: nennt „${name}" — die Rechnung kennt den Browser nicht, ` +
          `auch nicht über einen Umweg ohne import (Vertrag, Abschnitt 5.6, Regel 1 und 2)`
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Ohne Import heißt ohne Browser — nicht „ohne die Zeile import" (Vertrag, Abschnitt 5.6, Regel 1 und 2):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 3. Der Selektor `.dot-wave` steht nur im Modulordner
// ---------------------------------------------------------------------------
//
// ZWECK: Regel 6 aus Abschnitt 5.6 — „der Rückbau ist zwei Handgriffe": Ordner
// löschen, die Zeile in `App.tsx` streichen (seit #269 reicht `App.tsx` den
// Grund an `SetupView` und `SignInView` herein, damit die Tür des Features
// `account` kein Stylesheet nachzieht). Ein dritter Ort, an dem der
// Grund verankert ist, macht daraus drei.
//
// FÄNGT: die Zeile in einer Sammeldatei. Gemessen am 2026-09-05:
// `.dot-wave { opacity: .35 }` in `web/src/platform/theme/tokens.css` untergebracht —
// die ganze Kette blieb grün. `web/src/styles.css` ist über den Wächter
// `design-tokens` geschützt, `web/src/platform/theme/tokens.css` war es nicht.
//
// OHNE DIESE PRÜFUNG: wer den Ordner löscht, löscht den Grund nicht — er
// lässt eine Regel für einen Selektor zurück, den es nicht mehr gibt. Das
// stört niemanden und bleibt für immer stehen. Schlimmer ist der umgekehrte
// Fall: die Deckung des Grundes stünde an einem Ort, an dem sie niemand
// sucht, und der Kopfkommentar von `dot-wave.css` („mehr steht hier nicht")
// wäre schlicht falsch.
test("der Selektor .dot-wave steht nur im Modulordner", () => {
  const files = collectFiles(SOURCE_ROOT, [".css"]).filter(
    (path) => !path.startsWith(`${MODULE_DIRECTORY}/`)
  );
  assert.ok(
    files.length > 0,
    `keine .css-Datei außerhalb von ${MODULE_DIRECTORY}/ gefunden — der Wächter liefe ins Leere`
  );

  // Der Selektor, nicht das Wort: gesucht wird der Punkt davor. Ein
  // `dot-wave` in einem Importpfad (`./dot-wave.css`) trägt keinen und fällt
  // deshalb nicht in dieses Muster.
  const SELECTOR = /\.dot-wave(?![\w-])/g;

  const findings = [];
  for (const path of files) {
    const content = stripCssComments(readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    for (const match of content.matchAll(SELECTOR)) {
      findings.push(
        `${path}:${lineOf(content, match.index)}: verankert „.dot-wave" außerhalb des Moduls — ` +
          `der Rückbau ist damit drei Handgriffe statt zwei (Vertrag, Abschnitt 5.6, Regel 6)`
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Der Grund ist an genau einem Ort verankert (Vertrag, Abschnitt 5.6, Regel 6):\n${findings.join("\n")}`
  );
});
