import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments, stripCssComments } from "./strip-comments.mjs";

// Wächter über das Modul `web/src/platform/ui/dot-wave/` aus D4 — den Grund hinter
// den beiden Formularbildschirmen.
// Vertrag: `scratchpad/d4-spec.md`, Abschnitte 5, 5.6 und 6, Prüfliste 8.
//
// ⚠️ DIESER WÄCHTER IST AUS DEM SCHNITT GESCHRIEBEN, NICHT AUS DEM CODE. Das
// Modul entsteht PARALLEL in einem anderen Bauabschnitt (Agent A) und wurde
// beim Schreiben dieses Wächters bewusst nicht gelesen — auch nicht, um die
// Namen seiner Exporte nachzuschlagen. Was hier geprüft wird, steht im
// Vertrag; wie das Modul seine Funktionen nennt, steht dort NICHT. Deshalb
// sucht dieser Wächter die geprüfte Rechnung über ihre FORM (eine Funktion,
// die aus Breite und Höhe eine Liste von Punkten mit `x` und `y` macht) und
// nicht über einen Namen, den er sich selbst ausgedacht hätte. Ein erfundener
// Name wäre keine Zusage des Vertrags, sondern eine Erfindung dieses Tests.
// Findet er nichts, das der Form entspricht, wird er rot und nennt die
// tatsächlichen Exporte — das ist ein Befund, kein Fehlalarm.
//
// ⚠️ EINE AUSNAHME, und sie ist nachträglich eingezogen: die UMLAUFZEITEN
// werden bei ihrem Namen gelesen (`WAVE_PARTS[].period`) und nicht gesucht.
// Suchen war richtig, solange das Modul noch nicht geschrieben war; seit es
// steht, ist es eine Lücke — die Begründung mit der Messung steht bei
// `readPeriods`.
//
// GEPRÜFT WIRD, sieben Zusicherungen, nicht mehr (Vertrag, Abschnitt 8):
//   1. `wave-field.ts` enthält keine Zeile `import`,
//   2. keine Datei außerhalb des Ordners nennt `wave-field` oder einen Pfad
//      in den Ordner hinein — von außen führt kein Weg an `index.ts` vorbei,
//   3. `DotWave.tsx` nimmt keine Eigenschaften,
//   4. GERECHNET, nicht gelesen: das Raster liegt vollständig unterhalb des
//      Horizonts, die vorderste Zeile trägt den größten Ausschlag und die
//      hinterste den kleinsten, und die Punktzahl wächst mit der Fläche,
//   5. GERECHNET: die drei Umlaufzeiten sind paarweise kein ganzzahliges
//      Vielfaches voneinander,
//   6. `DotWave.tsx` meldet die Schleife ab und fragt `prefers-reduced-motion`,
//   7. kein roher Farbwert im ganzen Ordner — und positiv: das Bauteil liest
//      die Farbe über `getComputedStyle` aus `--accent-foreground`,
//
// ⚠️ DREI WEITERE PRÜFUNGEN ZU DIESEM MODUL STEHEN IN
// `dot-wave-boundary.test.mjs`: die Streckung der Leinwand, der Umweg über
// `globalThis` und die Verankerung des Selektors. Sie sind dort und nicht
// hier, weil diese Datei sonst über die Grenze von 1.000 Zeilen liefe
// (Wächter `source-file-size`) — gemessen: 1.060 Zeilen. Der Schnitt ist
// nicht willkürlich: hier steht, was die RECHNUNG und die FARBE zusagen,
// dort, was die LAGE und die MODULGRENZE zusagen.
//
// ⚠️ PRÜFUNG 4 UND 5 IMPORTIEREN DIE RECHNUNG. Node liest TypeScript ohne
// Bau (Typen werden gestrippt). Gemessen in dieser Umgebung mit `node
// v22.22.2`: ein `.test.mjs`, das `../src/…/x.ts` importiert, läuft
// (`# pass 1 / # fail 0`). `web/tsconfig.json` hat `include: ["src"]` und
// sieht diese Datei damit gar nicht; der Import braucht die ausgeschriebene
// Endung `.ts`. Bricht der Import in einer ANDEREN Umgebung, wird dieser
// Wächter nicht gelöscht, sondern auf Quelltext-Lesen zurückgebaut — und das
// im Auftrag vermerkt. Genau darum ist `wave-field.ts` frei von Importen
// (Prüfung 1): eine Rechnung ohne React und ohne DOM lässt sich prüfen, ohne
// einen Browser zu starten.
//
// ⚠️ GELESEN WIRD ÜBER `readdirSync`, NICHT ÜBER `git ls-files`. Eine Datei,
// die noch nicht mit `git add` erfasst ist, ist für `git ls-files`
// UNSICHTBAR (gemessen in D2) — und genau das ist hier der Normalfall: das
// Modul entsteht gleichzeitig mit diesem Wächter, der Leitstand fügt es erst
// danach hinzu. Ein Lauf über `git ls-files` zeigte in diesem Fenster ein zu
// freundliches Bild: er fände weder eine frisch geschriebene `dot-wave.css`
// mit rohem Farbwert noch einen neuen Verweis am Modul vorbei.
//
// ⚠️ NICHT geprüft und bewusst so:
//   - dass nur `DotWave.tsx` den Browser anfasst (Regel 2 aus Abschnitt 5.6).
//     Das ist eine Aussage über React- und DOM-Zugriffe in `index.ts` und
//     `dot-wave.css`; Abschnitt 8 führt sie nicht als eigene Prüfung, und
//     dieser Wächter behauptet nichts, was dort nicht steht.
//   - dass das Bild AUSSIEHT wie das Artboard: 2 402 Punkte bei 1440×900,
//     die Deckungs- und Größenkurven, die Maske. Geprüft werden die drei
//     Eigenschaften aus Abschnitt 8.4, nicht die Zahlen aus 5.2.
//   - ob `getComputedStyle` das ZURÜCKGELESENE `fillStyle` wirklich
//     vergleicht (Abschnitt 6, letzter Absatz). Das ist Verhalten im
//     Browser; hier steht nur, dass keine Farbe fest im Ordner steht.
//   - ob ein Verbraucher den Grund überhaupt einbindet. Prüfung 2 verbietet
//     den Weg am Modul vorbei; sie verlangt nicht, dass es einen Weg gibt.
//   - `prefers-reduced-motion` als VERHALTEN. Prüfung 6 liest zwei
//     Zeichenketten im Quelltext, und mehr kann sie nicht: der Prüfer hat am
//     2026-09-05 daraus `if (motion.matches && window.innerWidth < 0)`
//     gemacht — beide Zeichenketten stehen weiter da, die Bedingung ist nie
//     wahr, die Schleife läuft trotz gesetzter Einstellung, und die ganze
//     Kette blieb grün. Ob die Einstellung WIRKT, kann nur ein Browser sagen;
//     diese Prüfkette hat keinen. Das ist die Lücke, die von den sieben
//     Zusagen hier am meisten wehtut, und sie ist mit den Mitteln eines
//     lesenden Wächters nicht zu schließen — ein Test, der die Bedingung
//     nachbaut, prüfte seine eigene Nachbildung.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MODULE_DIRECTORY = "web/src/platform/ui/dot-wave";
const SOURCE_ROOT = "web/src";

const WAVE_FIELD_PATH = `${MODULE_DIRECTORY}/wave-field.ts`;
const COMPONENT_PATH = `${MODULE_DIRECTORY}/DotWave.tsx`;

// Die Fläche, über der gerechnet wird. Zwei Größen, weil Prüfung 4 einen
// Vergleich braucht; beide bewusst weit auseinander, damit „wächst mit der
// Fläche" nicht an einer Rundung hängt.
const SMALL_WIDTH = 480;
const SMALL_HEIGHT = 320;
const LARGE_WIDTH = 1600;
const LARGE_HEIGHT = 1000;

// Der Horizont steht bei 33 % der Höhe (Vertrag, Abschnitt 5). Darüber
// entsteht kein Punkt.
const HORIZON_RATIO = 0.33;

// Toleranz für den Vergleich von Fließkommazahlen. Ein halber Bildpunkt ist
// weit unter allem, was der Vertrag zusichert, und weit über allem, was eine
// Rundung in der Perspektivformel anrichtet.
const EPSILON = 0.5;

function readOrFail(relativePath, hint) {
  const absolute = new URL(relativePath, `file://${ROOT}`);
  assert.ok(existsSync(absolute), `Datei fehlt: ${relativePath} — ${hint}`);
  return readFileSync(absolute, "utf8");
}

function stripFor(path, source) {
  return path.endsWith(".css") ? stripCssComments(source) : stripComments(source);
}

// Zeilennummer zu einer Fundstelle. Ohne sie melden mehrere Treffer in
// derselben Datei sechsmal denselben Satz, und niemand weiß, wo er nachsehen
// soll — gemessen am ersten Lauf dieses Wächters gegen `dot-wave.css`.
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
// Die Rechnung laden und ihre Bestandteile über die FORM finden
// ---------------------------------------------------------------------------
//
// Die Namen der Exporte stehen nicht im Vertrag, und die Datei darf für
// diesen Wächter nicht gelesen werden. Gesucht wird deshalb nach Form:
//
//   - der Rasterbauer ist die Funktion, die aus einer Breite und einer Höhe
//     eine nicht leere Liste von Objekten mit endlichen `x` und `y` macht,
//   - der Ausschlag ist das Zahlenfeld eines Punktes, dessen Name aus dem
//     Wortfeld „Ausschlag" kommt,
//   - die Umlaufzeiten NICHT: sie werden aus `WAVE_PARTS[].period` GELESEN
//     und nirgends gesucht. Warum, steht bei `readPeriods`.
//
// Findet eine dieser Suchen nichts, wird die Prüfung rot und nennt, was
// tatsächlich exportiert wird. Das ist der Befund „die Rechnung hat nicht die
// zugesagte Form" — nicht „der Test kennt den Namen nicht".

let cachedModule;

async function loadWaveField() {
  if (cachedModule !== undefined) return cachedModule;
  assert.ok(
    existsSync(new URL(WAVE_FIELD_PATH, `file://${ROOT}`)),
    `Datei fehlt: ${WAVE_FIELD_PATH} — die Rechnung des Moduls, entsteht parallel (Vertrag, Abschnitt 5.6)`
  );
  const specifier = new URL("../src/platform/ui/dot-wave/wave-field.ts", import.meta.url).href;
  try {
    cachedModule = await import(specifier);
  } catch (error) {
    assert.fail(
      `${WAVE_FIELD_PATH} lässt sich nicht importieren: ${error?.message ?? error}\n` +
        "Node liest TypeScript ohne Bau (gemessen: node v22.22.2). Schlägt das hier fehl, " +
        "liegt es an der Datei (fehlender Export, Syntax, ein Import in eine .tsx) — nicht am Verfahren."
    );
  }
  return cachedModule;
}

// Bringt zurück, was eine Funktion geliefert hat, sofern es eine nicht leere
// Punkteliste ist — direkt, als `dots`/`points` daneben, oder als Liste von
// Zeilen. Sonst `null`.
function asDots(value) {
  let array = null;
  if (Array.isArray(value)) array = value;
  else if (value && typeof value === "object") {
    for (const key of ["dots", "points", "grid", "rows"]) {
      if (Array.isArray(value[key])) {
        array = value[key];
        break;
      }
    }
  }
  if (!Array.isArray(array) || array.length === 0) return null;
  if (array.every((entry) => Array.isArray(entry))) array = array.flat();
  if (array.length === 0) return null;
  const usable = array.every(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      Number.isFinite(entry.x) &&
      Number.isFinite(entry.y)
  );
  return usable ? array : null;
}

// Ruft eine Kandidatenfunktion in den Aufrufformen, die für „Breite und Höhe
// hinein, Raster heraus" in Frage kommen.
function callBuilder(candidate, width, height) {
  const shapes = [
    () => candidate(width, height),
    () => candidate({ width, height }),
    () => candidate({ width, height, time: 0 }),
    () => candidate(width, height, 0)
  ];
  for (const shape of shapes) {
    let result;
    try {
      result = shape();
    } catch {
      continue;
    }
    const dots = asDots(result);
    if (dots !== null) return dots;
  }
  return null;
}

function findGridBuilder(namespace) {
  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== "function") continue;
    if (callBuilder(value, LARGE_WIDTH, LARGE_HEIGHT) === null) continue;
    return { name, build: (width, height) => callBuilder(value, width, height) };
  }
  return null;
}

// Das Wortfeld „Ausschlag" auf Englisch. Bewusst weit: welchen der Namen das
// Modul wählt, steht nicht im Vertrag.
const AMPLITUDE_HINT = /(amplitude|amp|sway|swing|throw|reach|travel|rise)/i;

function findAmplitudeKey(dots) {
  const keys = Object.keys(dots[0]).filter(
    (key) => AMPLITUDE_HINT.test(key) && dots.every((dot) => Number.isFinite(dot[key]))
  );
  if (keys.length === 0) return null;
  const exact = keys.find((key) => /^(amplitude|amp)$/i.test(key));
  return exact ?? keys[0];
}

// Die Umlaufzeiten kommen aus GENAU EINER Quelle: dem Feld `period` der
// Einträge von `WAVE_PARTS` — der Liste, mit der `waveHeight()` rechnet.
//
// ⚠️ HIER WIRD NICHT GESUCHT, UND DAS IST DER GANZE PUNKT. Die Vorfassung lief
// über den Namensraum und nahm das erste Feld, dessen Name nach „Umlaufzeit"
// klang. Der ESM-Namensraum ist aber ALPHABETISCH sortiert, nicht in
// Quelltextreihenfolge — gemessen am 2026-09-05:
//
//   Object.keys(await import("…/wave-field.ts"))
//     → CYCLE_SECONDS, DEPTH_EXPONENT, GRID_STEP, HORIZON_RATIO, MIN_SPACING,
//       ROW_COUNT, WAVE_PARTS, createWaveField, waveHeight
//
// Ein `export const CYCLE_SECONDS = [9, 13.5, 21]` neben ein `WAVE_PARTS` mit
// `period: 9/18/27` gestellt, und die Suche fand die TOTE KOPIE zuerst: die
// Rechnung lief auf der atmenden Tapete, dieser Wächter bestätigte die
// Wunschzahlen, die ganze Kette blieb grün (`# tests 91 / # pass 91 /
// # fail 0`). Ein Wächter, der raten darf, bestätigt irgendwann sich selbst
// statt des Codes.
//
// Deshalb: eine Quelle, benannt, und wenn sie fehlt, ist das ein Befund und
// kein Grund, weiterzusuchen. Der Name steht seit D4 fest; er zu erraten war
// nur nötig, solange dieser Wächter vor dem Modul geschrieben wurde.
const WAVE_PARTS_EXPORT = "WAVE_PARTS";
const PERIOD_FIELD = "period";

// Liefert `{ source, periods }` oder `{ problem }` — nie ein Ratespiel.
function readPeriods(namespace) {
  const parts = namespace[WAVE_PARTS_EXPORT];

  if (!Array.isArray(parts)) {
    return {
      problem:
        `${WAVE_FIELD_PATH} exportiert kein Feld „${WAVE_PARTS_EXPORT}" — die Umlaufzeiten werden aus ` +
        `${WAVE_PARTS_EXPORT}[].${PERIOD_FIELD} gelesen und NIRGENDWO sonst gesucht.\n` +
        `Exportiert wird: ${describeExports(namespace)}`
    };
  }

  if (parts.length !== 3) {
    return {
      problem:
        `${WAVE_PARTS_EXPORT} trägt ${parts.length} Schwingungen, zugesagt sind drei (Vertrag, Abschnitt 5.3).`
    };
  }

  const missing = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part === null || typeof part !== "object" || !(PERIOD_FIELD in part));
  if (missing.length > 0) {
    return {
      problem:
        `${missing.map(({ index }) => `${WAVE_PARTS_EXPORT}[${index}]`).join(", ")} trägt kein Feld ` +
        `„${PERIOD_FIELD}". Ein Eintrag trägt: ${parts
          .map((part, index) =>
            part !== null && typeof part === "object"
              ? `[${index}] ${Object.keys(part).join(", ")}`
              : `[${index}] ${typeof part}`
          )
          .join(" | ")}\n` +
        `Die Umlaufzeit ist das Feld, mit dem waveHeight() rechnet — eine Zahl daneben, die anders heißt, ` +
        `ist eine Kopie und keine Zusage.`
    };
  }

  return {
    source: `${WAVE_PARTS_EXPORT}[].${PERIOD_FIELD}`,
    periods: parts.map((part) => part[PERIOD_FIELD])
  };
}

function describeExports(namespace) {
  return Object.entries(namespace)
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? `Array(${value.length})` : typeof value}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// 1. `wave-field.ts` importiert nichts
// ---------------------------------------------------------------------------
//
// ZWECK: die Rechnung kennt weder React noch das DOM noch die Anwendung. Sie
// macht aus Breite und Höhe ein Raster und aus Ort und Zeit eine Höhe
// (Vertrag, Abschnitt 5.6, Regel 1).
//
// FÄNGT: den ersten Import, der sich einschleicht — eine Hilfsfunktion aus
// `ui/lib`, ein Typ aus React, eine Konstante aus dem Theme.
//
// OHNE DIESE PRÜFUNG: der erste Import kostet nichts und macht alles Weitere
// möglich. Mit ihm hört die Datei auf, ohne Browser prüfbar zu sein — und
// damit fallen die Prüfungen 4 und 5 dieses Wächters mit, die als einzige
// wirklich RECHNEN statt zu lesen. Der Ordner wäre außerdem nicht mehr in
// zwei Handgriffen zurückzubauen (Abschnitt 5.6, Regel 6).
test("wave-field.ts enthält keine Zeile import", () => {
  const content = stripComments(
    readOrFail(
      WAVE_FIELD_PATH,
      "die Rechnung des Moduls, entsteht parallel (Vertrag, Abschnitt 5.6)"
    )
  );

  const findings = [];
  const lines = content.split("\n");
  lines.forEach((line, number) => {
    if (/(?<![\w$.])import(?![\w$])/.test(line)) {
      findings.push(`${WAVE_FIELD_PATH}:${number + 1}: ${line.trim()}`);
    }
    if (/(?<![\w$.])require\s*\(/.test(line)) {
      findings.push(`${WAVE_FIELD_PATH}:${number + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(
    findings,
    [],
    `Die Rechnung kennt weder React noch das DOM noch die Anwendung — genau deshalb ist sie ohne Browser prüfbar (Vertrag, Abschnitt 5.6, Regel 1):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 2. Von außen führt kein Weg an `index.ts` vorbei
// ---------------------------------------------------------------------------
//
// ZWECK: der Grund ist Zierde und darf nirgends verankert sein, wo er nicht
// sein muss. Wer ihn morgen austauscht oder herauswirft, soll einen Ordner
// löschen und eine Zeile streichen (Vertrag, Abschnitt 5.6, Regel 3 und 6).
//
// FÄNGT: den Direktgriff. `import { DotWave } from "../platform/ui/dot-wave/DotWave"`
// ist einen Tastendruck kürzer als der Weg über die Tür und funktioniert
// genauso gut — bis jemand die Datei umbenennt.
//
// OHNE DIESE PRÜFUNG: nach dem dritten Direktgriff ist der Rückbau kein
// Ordner-Löschen mehr, sondern eine Suche durch die Anwendung. Der zugesagte
// Preis für den Hintergrund („zwei Handgriffe") wäre stillschweigend
// gestiegen, ohne dass eine einzige Zeile falsch aussieht.
test("keine Datei außerhalb des Ordners greift am Modul vorbei", () => {
  const files = collectFiles(SOURCE_ROOT, [".ts", ".tsx", ".css"]).filter(
    (path) => !path.startsWith(`${MODULE_DIRECTORY}/`)
  );
  assert.ok(
    files.length > 0,
    `keine Quelldatei unter ${SOURCE_ROOT}/ gefunden — der Wächter liefe ins Leere`
  );

  const findings = [];
  for (const path of files) {
    const content = stripFor(path, readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    for (const match of content.matchAll(/wave-field/g)) {
      findings.push(
        `${path}:${lineOf(content, match.index)}: nennt „wave-field" — die Rechnung ist modulintern`
      );
    }
    // Ein Pfad IN den Ordner hinein: alles hinter `dot-wave/`. Die erlaubte
    // Form `../platform/ui/dot-wave` trägt keinen Schrägstrich am Ende und fällt
    // deshalb nicht in dieses Muster.
    for (const match of content.matchAll(/dot-wave\/[\w.-]+/g)) {
      findings.push(
        `${path}:${lineOf(content, match.index)}: „${match[0]}" — von außen führt der Weg über ../platform/ui/dot-wave`
      );
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Das Modul hat genau eine Tür (Vertrag, Abschnitt 5.6, Regel 3):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 3. `DotWave` nimmt keine Eigenschaften
// ---------------------------------------------------------------------------
//
// ZWECK: der Aufruf ist `<DotWave />` — kein `width`, kein `color`, kein
// `speed`. Was das Bauteil wissen muss, misst es selbst; was es nicht selbst
// wissen kann, ist genau eine CSS-Variable (Vertrag, Abschnitt 5.6, Regel 4
// und 5).
//
// FÄNGT: die erste Eigenschaft. Sie kommt fast immer als Gefallen — „nur
// schnell die Farbe von außen setzen können".
//
// OHNE DIESE PRÜFUNG: ein Bauteil mit Eigenschaften hat eine Schnittstelle,
// und eine Schnittstelle kann veralten. Aus `color` würde der zweite,
// eingefrorene Farbton neben `--accent-foreground`, und der Rückbau wäre
// nicht mehr eine Zeile in `App.tsx`, sondern eine Zeile mit Argumenten,
// die anderswo herkommen.
test("DotWave ist als Funktion ohne Parameter deklariert", () => {
  const content = stripComments(
    readOrFail(COMPONENT_PATH, "die Hülle des Moduls, entsteht parallel (Vertrag, Abschnitt 5.6)")
  );

  const findings = [];

  const declaration =
    content.match(/(?:export\s+)?function\s+DotWave\s*\(([^)]*)\)/) ??
    content.match(/(?:export\s+)?const\s+DotWave\s*(?::[^=]*)?=\s*\(([^)]*)\)\s*=>/);

  if (declaration === null) {
    findings.push(
      `${COMPONENT_PATH}: keine Deklaration von DotWave gefunden — umbenannt, oder als Ausdruck geschrieben, den dieser Erkenner nicht kennt`
    );
  } else if (declaration[1].trim() !== "") {
    findings.push(
      `${COMPONENT_PATH}: DotWave nimmt „${declaration[1].trim()}" — zugesagt ist der Aufruf <DotWave /> ohne jede Eigenschaft`
    );
  }

  // Ein Eigenschaftstyp ohne Parameter ist derselbe Fehler eine Zeile früher:
  // er existiert nur, um gleich benutzt zu werden.
  if (/(?<![\w$])DotWaveProps(?![\w$])/.test(content)) {
    findings.push(
      `${COMPONENT_PATH}: deklariert DotWaveProps — ein Bauteil ohne Eigenschaften braucht keinen Eigenschaftstyp`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `Keine Eigenschaften (Vertrag, Abschnitt 5.6, Regel 4):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 4. Das Raster, gerechnet statt gelesen
// ---------------------------------------------------------------------------
//
// ZWECK: drei Zusagen aus Abschnitt 5.2 in einer Rechnung. Der Horizont liegt
// bei 33 % der Höhe und darüber entsteht kein Punkt; der Ausschlag ist vorn
// am größten und hinten am kleinsten (±70 px gegen ±14 px); das Raster wird
// aus der GEMESSENEN Fläche gerechnet und nicht aus 1440×900 skaliert, also
// wächst die Punktzahl mit der Fläche (Abschnitt 5.5).
//
// FÄNGT: die Perspektive, die auf dem Kopf steht. Ein Vorzeichen im
// Exponenten, ein vertauschtes `t`, ein `1 - t` zu viel — und die Fläche
// läuft nach vorn statt nach hinten, oder der Horizont wandert. Dazu die
// stille Variante: ein Raster, das bei jeder Größe gleich viele Punkte
// liefert, weil es doch skaliert wird.
//
// OHNE DIESE PRÜFUNG: ein lesender Wächter könnte nur bestätigen, dass die
// Formel aus Abschnitt 5.2 im Code steht — er könnte nicht sagen, dass sie
// das Zugesagte TUT. Genau dafür ist `wave-field.ts` importfrei gebaut. Und
// dieser Fehler sieht im Browser nicht falsch aus, sondern nur anders: der
// Grund bewegt sich, es fällt niemandem auf, dass er in die falsche Richtung
// in die Tiefe läuft.
test("das Raster liegt unter dem Horizont, trägt vorn den größten Ausschlag und wächst mit der Fläche", async () => {
  const namespace = await loadWaveField();

  const builder = findGridBuilder(namespace);
  assert.ok(
    builder !== null,
    `${WAVE_FIELD_PATH} exportiert keine Funktion, die aus Breite und Höhe eine Punkteliste mit x und y macht.\n` +
      `Exportiert wird: ${describeExports(namespace)}\n` +
      "Der Vertrag sagt in Abschnitt 5.6 zu, dass genau diese Rechnung hier liegt und ohne Browser prüfbar ist."
  );

  const dots = builder.build(LARGE_WIDTH, LARGE_HEIGHT);
  assert.ok(
    dots !== null && dots.length > 0,
    `${builder.name}(${LARGE_WIDTH}, ${LARGE_HEIGHT}) lieferte kein Raster`
  );

  const findings = [];

  // (a) Vollständig unterhalb des Horizonts. `y` wächst nach unten, „unter dem
  //     Horizont" heißt also `y >= 0.33 · Höhe`. NICHT geprüft wird eine obere
  //     Schranke: die vorderste Zeile liegt laut Formel bei `H + 28` und damit
  //     bewusst unterhalb des Randes.
  const horizon = HORIZON_RATIO * LARGE_HEIGHT;
  const above = dots.filter((dot) => dot.y < horizon - EPSILON);
  if (above.length > 0) {
    const highest = Math.min(...above.map((dot) => dot.y));
    findings.push(
      `${above.length} von ${dots.length} Punkten liegen über dem Horizont (y = ${highest.toFixed(1)} < ${horizon.toFixed(1)}) — das obere Drittel bleibt leer, und das ist der Entwurf (Vertrag, Abschnitt 5)`
    );
  }

  // (b) Vorn der größte, hinten der kleinste Ausschlag.
  const amplitudeKey = findAmplitudeKey(dots);
  if (amplitudeKey === null) {
    findings.push(
      `kein Zahlenfeld für den Ausschlag an einem Punkt gefunden. Ein Punkt trägt: ${Object.keys(dots[0]).join(", ")} — zugesagt ist ein Ausschlag von ±70 px vorn gegen ±14 px hinten (Vertrag, Abschnitt 5.2)`
    );
  } else {
    const front = dots.reduce((best, dot) => (dot.y > best.y ? dot : best), dots[0]);
    const back = dots.reduce((best, dot) => (dot.y < best.y ? dot : best), dots[0]);
    const amplitudes = dots.map((dot) => dot[amplitudeKey]);
    const largest = Math.max(...amplitudes);
    const smallest = Math.min(...amplitudes);

    if (front[amplitudeKey] < largest - EPSILON) {
      findings.push(
        `die vorderste Zeile (y = ${front.y.toFixed(1)}) trägt ${amplitudeKey} = ${front[amplitudeKey]}, der größte Ausschlag im Raster ist ${largest} — vorn ist der Ausschlag am größten (Vertrag, Abschnitt 5.2)`
      );
    }
    if (back[amplitudeKey] > smallest + EPSILON) {
      findings.push(
        `die hinterste Zeile (y = ${back.y.toFixed(1)}) trägt ${amplitudeKey} = ${back[amplitudeKey]}, der kleinste Ausschlag im Raster ist ${smallest} — hinten ist er am kleinsten (Vertrag, Abschnitt 5.2)`
      );
    }
    if (!(largest > smallest)) {
      findings.push(
        `der Ausschlag ist über das ganze Raster gleich (${largest}) — dann läuft die Fläche nicht in die Tiefe`
      );
    }
  }

  // (c) Die Punktzahl wächst mit der Fläche.
  const small = builder.build(SMALL_WIDTH, SMALL_HEIGHT);
  if (small === null) {
    findings.push(`${builder.name}(${SMALL_WIDTH}, ${SMALL_HEIGHT}) lieferte kein Raster`);
  } else if (!(dots.length > small.length)) {
    findings.push(
      `${SMALL_WIDTH}×${SMALL_HEIGHT} ergibt ${small.length} Punkte, ${LARGE_WIDTH}×${LARGE_HEIGHT} ergibt ${dots.length} — das Raster wird aus der gemessenen Fläche gerechnet, nicht skaliert (Vertrag, Abschnitt 5.5)`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `Das Raster (gerechnet über ${builder.name}):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 5. Die drei Umlaufzeiten haben kein gemeinsames Vielfaches
// ---------------------------------------------------------------------------
//
// ZWECK: 9, 13,5 und 21 Sekunden. Daher kommt der organische Eindruck — das
// Bild wiederholt sich praktisch nie, und hinten steht etwas anderes als vorn
// (Vertrag, Abschnitt 5.3).
//
// FÄNGT: die runden Zahlen. Wer die drei Zeiten auf ein Vielfaches zieht
// (etwa 9/18/27), bekommt eine sauber atmende Tapete zurück.
//
// OHNE DIESE PRÜFUNG: genau dieser Griff wäre der einzige im ganzen Paket,
// den KEIN Test bemerkt — der Vertrag sagt das in Abschnitt 5.3 wörtlich:
// „ohne dass ein Test rot wird". Diese Prüfung ist die Antwort darauf. Sie
// rechnet die Zusage nach, statt sie in einem Kommentar zu behaupten.
//
// ⚠️ Verglichen wird das Verhältnis je Paar gegen die nächste ganze Zahl mit
// einer Toleranz von 1 %. Streng genommen verlangt der Vertrag „kein
// ganzzahliges Vielfaches"; ein Verhältnis von 2,001 wäre danach zulässig und
// sähe trotzdem wie eine Tapete aus. Die Toleranz macht die Prüfung also
// etwas STRENGER als der Wortlaut — in die Richtung, in die die Zusage zeigt.
// Die drei Zahlen aus dem Vertrag halten sie mit Abstand: 1,5 · 1,556 · 2,333.
test("die drei Umlaufzeiten sind paarweise kein ganzzahliges Vielfaches", async () => {
  const namespace = await loadWaveField();

  const found = readPeriods(namespace);
  assert.ok(
    found.problem === undefined,
    `${found.problem}\n` +
      "Der Vertrag beschreibt in Abschnitt 5.3 drei Schwingungen mit den Perioden 9 s, 13,5 s und 21 s."
  );

  const periods = found.periods;
  const findings = [];

  if (periods.some((period) => !(period > 0))) {
    findings.push(`keine positive Umlaufzeit: ${periods.join(", ")}`);
  }

  const TOLERANCE = 0.01;
  for (let a = 0; a < periods.length; a += 1) {
    for (let b = a + 1; b < periods.length; b += 1) {
      const larger = Math.max(periods[a], periods[b]);
      const smaller = Math.min(periods[a], periods[b]);
      const ratio = larger / smaller;
      const distance = Math.abs(ratio - Math.round(ratio));
      if (distance <= TOLERANCE) {
        findings.push(
          `${periods[a]} s und ${periods[b]} s stehen im Verhältnis ${ratio.toFixed(4)} — das ist ein ganzzahliges Vielfaches, und die Welle wird zur atmenden Tapete (Vertrag, Abschnitt 5.3)`
        );
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Die drei Umlaufzeiten (gelesen aus ${found.source}: ${periods.join(", ")}):\n${findings.join("\n")}`
  );
});

// ---------------------------------------------------------------------------
// 6. Die Schleife wird abgemeldet, und Ruhe wird respektiert
// ---------------------------------------------------------------------------
//
// ZWECK: `requestAnimationFrame` läuft weiter, bis jemand es abbestellt.
// `prefers-reduced-motion: reduce` bedeutet: genau ein Bild zeichnen, die
// Schleife gar nicht erst anwerfen — nicht optional (Vertrag, Abschnitt 5.5).
//
// FÄNGT: das vergessene `cancelAnimationFrame` beim Abbau der Komponente und
// den ganz fehlenden Blick auf `prefers-reduced-motion`.
//
// OHNE DIESE PRÜFUNG: nach dem Anmelden zeichnet eine Leinwand weiter, die
// niemand mehr sieht — ein Bild alle 16 ms, für die ganze Sitzung. Und wer
// die Systemeinstellung „Bewegung reduzieren" gesetzt hat, bekommt trotzdem
// eine Animation; das ist die Einstellung, die Menschen mit
// Bewegungsempfindlichkeit setzen, und sie zu übergehen ist kein Schönheits-
// fehler. Beides sieht im normalen Betrieb völlig unauffällig aus.
test("DotWave.tsx meldet die Schleife ab und fragt prefers-reduced-motion", () => {
  const content = stripComments(
    readOrFail(COMPONENT_PATH, "die Hülle des Moduls, entsteht parallel (Vertrag, Abschnitt 5.5)")
  );

  const findings = [];

  if (!/(?<![\w$])cancelAnimationFrame(?![\w$])/.test(content)) {
    findings.push(
      `${COMPONENT_PATH}: kein cancelAnimationFrame — die Schleife läuft nach dem Anmelden weiter und zeichnet in eine Leinwand, die niemand mehr sieht`
    );
  }

  if (!/prefers-reduced-motion/.test(content)) {
    findings.push(
      `${COMPONENT_PATH}: fragt prefers-reduced-motion nicht ab — bei „Bewegung reduzieren" wird genau ein Bild gezeichnet und die Schleife gar nicht erst angeworfen (Vertrag, Abschnitt 5.5)`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `Schleife und Ruhe (Vertrag, Abschnitt 5.5):\n${findings.join("\n")}`
  );
});

// Die gebräuchlichen CSS-Farbwörter. Ein Name ist derselbe eingefrorene Ton
// wie `#6495ed` — der Browser übersetzt ihn nur freundlicher.
//
// ⚠️ `transparent` steht bewusst NICHT in der Liste: es ist keine Farbwahl,
// sondern der Fühler, mit dem `DotWave.tsx` prüft, ob der Browser den Wert
// überhaupt angenommen hat (`fillStyle = "transparent"`, dann zurücklesen).
// `black` steht drin, wird aber im Maskenwert nicht gesucht — siehe
// `blankMaskValues`.
//
// Die Liste ist bewusst nicht die vollständigen 148 benannten Farben: sie
// trägt die, die jemand tippt, der schnell einen Ton braucht. Vollständigkeit
// wäre hier eine Illusion von Sicherheit — die echte Schranke ist die positive
// Zusage unten im Test.
const COLOR_KEYWORDS = [
  "aliceblue", "aqua", "aquamarine", "azure", "beige", "bisque", "black",
  "blanchedalmond", "blue", "blueviolet", "brown", "burlywood", "cadetblue",
  "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk", "crimson",
  "cyan", "darkblue", "darkcyan", "darkgray", "darkgreen", "darkgrey",
  "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid",
  "darkred", "darksalmon", "darkseagreen", "darkslateblue", "darkslategray",
  "darkturquoise", "darkviolet", "deeppink", "deepskyblue", "dimgray",
  "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia",
  "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green",
  "greenyellow", "grey", "honeydew", "hotpink", "indianred", "indigo",
  "ivory", "khaki", "lavender", "lawngreen", "lemonchiffon", "lightblue",
  "lightcoral", "lightcyan", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightsteelblue",
  "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen",
  "mediumslateblue", "mediumspringgreen", "mediumturquoise", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", "snow",
  "springgreen", "steelblue", "teal", "thistle", "tomato", "turquoise",
  "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
  "currentcolor"
];

// Leert die WERTE der beiden Maskenangaben, behält aber jeden Zeilenumbruch.
//
// ⚠️ Warum es diese Ausnahme gibt und warum sie eng ist: die Maske in
// `dot-wave.css` ist ein ALPHAVERLAUF. Für eine Maske zählt allein der
// Alphakanal, der Ton darin ist ohne jede Wirkung — `black` ist dort kein
// Gestaltungswert, sondern der Träger der drei Deckungsstufen. Ein Verbot von
// `black` IM MASKENWERT würde also nichts schützen und nur erzwingen, dass
// jemand denselben Verlauf umständlicher schreibt.
//
// Die Ausnahme gilt deshalb NUR für den Wert von `mask-image` und
// `-webkit-mask-image`. Ein `color: black` am Ablese-Element bleibt ein Fund,
// und genau das ist der Fall, den diese Prüfung fangen soll.
function blankMaskValues(source) {
  return source.replace(/(-webkit-)?mask-image\s*:[^;]*;?/g, (declaration) =>
    declaration.replace(/[^\n]/g, " ")
  );
}

// ---------------------------------------------------------------------------
// 7. Kein roher Farbwert im ganzen Ordner
// ---------------------------------------------------------------------------
//
// ZWECK: die Farbe der Punkte kommt aus `--accent-foreground`. Der Weg dahin
// ist ein Element mit `color: var(--accent-foreground)`, dessen
// `getComputedStyle(...).color` als `fillStyle` gesetzt wird — nicht ein Ton,
// der im Skript steht (Vertrag, Abschnitt 6).
//
// FÄNGT: den eingefrorenen Ton. Eine Leinwand BRAUCHT eine konkrete Farbe,
// und `ctx.fillStyle = "oklch(0.86 0.07 255)"` ist der kürzeste Weg dorthin.
//
// OHNE DIESE PRÜFUNG: der Grund folgte nicht mehr der Einstellung, der die
// Schaltfläche folgt. Ab D7 dreht der Betreiber den Ton, die Schaltfläche
// wandert mit, die Punkte bleiben stehen — und die Erklärung dafür steht in
// einer Datei, in die niemand sieht, weil sie nur den Hintergrund zeichnet.
//
// ⚠️ ERWARTET ROT, UND ZWAR AUS DEM VERTRAG SELBST. Abschnitt 8, Prüfung 7
// verlangt „kein roher Farbwert (`oklch(`, `#`, `rgb(`) im GANZEN ORDNER".
// Abschnitt 5.5 schreibt für `dot-wave.css` aber eine Maske vor, die wörtlich
// `rgba(0,0,0,.22)`, `rgba(0,0,0,.62)` und `#000` enthält. Beide Sätze stehen
// im selben Schnitt und widersprechen sich. Dieser Wächter setzt Abschnitt 8
// um, weil das der Auftrag ist, und meldet den Widerspruch in der Meldung
// mit — statt ihn durch eine selbst erfundene Ausnahme für Maskenfarben
// stillzulegen. Wer die Ausnahme will, entscheidet das am Schnitt, nicht hier.
//
// ⚠️ Gesucht wird nach Hex-Werten in gültiger CSS-Länge (3, 4, 6 oder 8
// Ziffern), damit eine Ausgabennummer wie `#62` nicht als Farbe gilt — wie im
// Wächter `design-tokens`. Kommentare sind abgezogen, in `.css` nur die
// Blockform, weil CSS kein `//` kennt.
test("kein roher Farbwert im Ordner web/src/platform/ui/dot-wave/", () => {
  const files = collectFiles(MODULE_DIRECTORY, [".ts", ".tsx", ".css"]);
  assert.ok(
    files.length > 0,
    `keine Datei unter ${MODULE_DIRECTORY}/ gefunden — das Modul entsteht parallel (Vertrag, Abschnitt 5.6); der Wächter liefe sonst ins Leere`
  );

  const HEX_COLOR =
    /(?<![\w#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w])/g;
  const FUNCTIONAL_COLOR = /\b(oklch|oklab|rgb|rgba|hsl|hsla|lch|lab|color)\(/g;
  const KEYWORD_COLOR = new RegExp(`(?<![\\w$.-])(${COLOR_KEYWORDS.join("|")})(?![\\w-])`, "gi");

  const findings = [];
  for (const path of files) {
    const content = stripFor(path, readFileSync(new URL(path, `file://${ROOT}`), "utf8"));
    for (const match of content.matchAll(HEX_COLOR)) {
      findings.push(`${path}:${lineOf(content, match.index)}: Hex-Farbe ${match[0]}`);
    }
    for (const match of content.matchAll(FUNCTIONAL_COLOR)) {
      findings.push(`${path}:${lineOf(content, match.index)}: ${match[1]}(…)`);
    }
    for (const match of blankMaskValues(content).matchAll(KEYWORD_COLOR)) {
      findings.push(
        `${path}:${lineOf(content, match.index)}: Farbwort „${match[1]}" — ein Name ist derselbe eingefrorene Ton wie eine Zahl`
      );
    }
  }

  // ⚠️ UND JETZT DIE ANDERE RICHTUNG. Alles oben ist eine VERBOTSLISTE, und
  // eine Verbotsliste lässt sich immer unterlaufen: sie kannte bis zum
  // 2026-09-05 keine Farbwörter, und `const ink = "cornflowerblue"` samt
  // `color: midnightblue` ging glatt durch — mit vollständig entferntem
  // `getComputedStyle` blieb die ganze Kette grün (`# tests 94 / # pass 94 /
  // # fail 0`). Die Liste ist jetzt länger, aber sie wird nie vollständig
  // sein: `color(display-p3 …)`, ein `\u0023`-Fluchtzeichen, eine aus zwei
  // Hälften zusammengesetzte Zeichenkette.
  //
  // Die POSITIVE Zusage ist deshalb die stärkere Hälfte dieser Prüfung: der
  // Weg zur Farbe MUSS im Modul stehen. Wer die Ablesung entfernt, fällt hier
  // auf, egal welche Schreibweise er stattdessen wählt — und zwar auch dann,
  // wenn seine neue Farbe in keiner Liste steht.
  const componentSource = stripComments(
    readOrFail(COMPONENT_PATH, "die Hülle des Moduls (Vertrag, Abschnitt 6)")
  );
  if (!/(?<![\w$.])getComputedStyle\s*\(/.test(componentSource)) {
    findings.push(
      `${COMPONENT_PATH}: ruft kein getComputedStyle — dann kommt die Farbe der Punkte nicht mehr aus der Palette, ` +
        `sondern von irgendwoher (Vertrag, Abschnitt 6)`
    );
  }

  const moduleMentionsToken = files.some((path) =>
    stripFor(path, readFileSync(new URL(path, `file://${ROOT}`), "utf8")).includes(
      "--accent-foreground"
    )
  );
  if (!moduleMentionsToken) {
    findings.push(
      `${MODULE_DIRECTORY}/: nennt „--accent-foreground" nirgends — das ist die EINZIGE zugesagte Berührung ` +
        `mit dem Entwurfssystem (Vertrag, Abschnitt 5.6, Regel 5); ohne sie folgt der Grund keiner Einstellung mehr`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `Die Farbe kommt aus --accent-foreground über getComputedStyle, nicht aus dem Quelltext (Vertrag, Abschnitt 6 und 8.7).\n` +
      `⚠️ Widerspruch im Schnitt: Abschnitt 5.5 schreibt für dot-wave.css eine Maske mit rgba(0,0,0,.22)/.62 und #000 vor, Abschnitt 8.7 verbietet genau diese Formen im ganzen Ordner. Dieser Wächter setzt 8.7 um; die Ausnahme für Maskenfarben wäre eine Entscheidung am Schnitt.\n${findings.join("\n")}`
  );
});
