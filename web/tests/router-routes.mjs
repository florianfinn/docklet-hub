// Der Routenleser der Repo-Wächter — eine Fassung für alle.
//
// Warum es diese Datei gibt: `api-read-only.test.mjs` trug den Abgrenzer
// `routeBody` und den Routenleser `routes()` als einzige Fassung, und
// `api-mirror.test.mjs` (#85) braucht beide für dieselbe Datei. Zwei
// Abschriften derselben Rechnung sind zwei Wahrheiten — wer die eine
// berichtigt, berichtigt die andere nicht, und jede bleibt für sich grün.
// Denselben Befund gab es am 2026-09-05 bei `stripComments` (siehe
// `strip-comments.mjs`, dort siebenmal byteidentisch); die Lehre wird hier
// angewandt, bevor die zweite Kopie entsteht.
//
// Seit der Aufteilung des Routers (Etappe B4a-A1, #5) steht eine Route nicht
// mehr zwingend in EINER Datei. `routerFiles()` trägt deshalb auch die
// Quellenliste: sie kennt den Ort von `router.ts` und der Features und liest
// sie ein — damit bauen die Wächter diesen Pfad nicht selbst und jeder nur
// ein bisschen anders.
//
// Since #271 the router lives in `server/src/app/router.ts`; `server/src/api/`
// and its `routes/` folder are gone, and every route group is the
// `routes.ts` of a feature.
//
// ⚠️ DER DATEINAME TRÄGT KEIN `.test.` — der Lauf ist
// `node --import tsx --test "tests/**/*.test.{mjs,tsx}"`, und eine Hilfsdatei,
// die dieses Muster träfe, würde als Testdatei eingesammelt und meldete „keine
// Tests".

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Where the router and the features live — from this file (`web/tests/`) two
// levels up to the root of the repo, then into the server code.
const ROUTER_FILE = fileURLToPath(new URL("../../server/src/app/router.ts", import.meta.url));
// The features of the server (#254 on): each one registers its routes in
// `features/<name>/routes.ts` (docs/design/feature-architecture.md, section 2).
const FEATURES_DIR = fileURLToPath(new URL("../../server/src/features/", import.meta.url));

/**
 * Every file a route can be registered in: `router.ts` itself and the
 * `routes.ts` of every feature. Each entry is the repo-relative path (for the
 * messages of the guards) and the unread content.
 */
export function routerFiles() {
  const files = [{ file: "server/src/app/router.ts", content: readFileSync(ROUTER_FILE, "utf8") }];
  // The routes file of every feature. Only `routes.ts`: inside a feature the
  // route is the one layer that registers; a route anywhere else under
  // `server/src` is caught by "jede Datei, die eine Route anmeldet, liest
  // dieser Wächter mit" (`api-read-only.test.mjs`).
  if (existsSync(FEATURES_DIR)) {
    const features = readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(FEATURES_DIR, entry.name, "routes.ts")))
      .map((entry) => entry.name)
      .sort();
    for (const feature of features) {
      files.push({
        file: `server/src/features/${feature}/routes.ts`,
        content: readFileSync(join(FEATURES_DIR, feature, "routes.ts"), "utf8")
      });
    }
  }
  return files;
}

// `router.<methode>( "<pfad>" ,` — der Pfad darf in der nächsten Zeile stehen.
export const ROUTE = /\brouter\.(get|post|put|patch|delete|all)\(\s*("(?:[^"\\]|\\.)*")\s*,\s*/g;

// Dasselbe ohne den Anspruch, den Pfad zu lesen: womit sich zählen lässt, wie
// viele Routen ANGEMELDET sind — auch die, die dieser Leser nicht versteht.
export const ROUTE_LOOSE = /\brouter\.(get|post|put|patch|delete|all)\s*\(/g;

// ── Wo ein Klammerausdruck ENDET ────────────────────────────────────────────
//
// Gezählt wird zeichenweise und dabei quoten- und kommentarbewusst: eine
// Klammer in einer Zeichenkette („(§4)") oder in einem deutschen Kommentar ist
// keine.
//
// ⚠️ DIE GRENZE DIESES VERFAHRENS, ausdrücklich und nicht als Überraschung
// später: ein Klammerzähler ist kein Parser. Eine unpaarige Klammer in einem
// regulären Ausdruck (`/\(/`) oder ein `)` innerhalb eines `${…}` in einem
// Template-Literal verschöbe das Ende — der Ausschnitt reichte dann zu weit
// oder hörte zu früh auf. Lieber eine benannte Grenze als ein Verfahren, das
// so tut, als hätte es keine. Geht die Klammer gar nicht auf, liefert der
// Abgrenzer `null`, und der Aufrufer wird davon ROT statt still grün.
export function spanFrom(text, openIndex, open = "(", close = ")") {
  let depth = 0;
  let index = openIndex;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (quote !== null) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (character === open) {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
      index += 1;
      continue;
    }
    index += 1;
  }
  return null;
}

/** Der Klammerfall: von der öffnenden runden Klammer bis zu ihrer schließenden. */
export function routeBody(text, openIndex) {
  return spanFrom(text, openIndex, "(", ")");
}

/**
 * Jede Route, die dieser Leser im Quelltext des Routers versteht.
 *
 * Je Route: die Methode, der Pfad, `firstArgument` (alles AB dem Pfad bis zum
 * Dateiende — das reicht für die Frage, was UNMITTELBAR hinter dem Pfad steht)
 * und `body`, der Ausschnitt genau DIESER Route. Der Unterschied zählt: ein
 * Schnitt bis zum Dateiende trüge jede folgende Route mit herein, und ein
 * Fund drei Routen weiter unten machte diese hier grün.
 */
export function readRoutes(source) {
  const found = [];
  for (const match of source.matchAll(ROUTE)) {
    found.push({
      method: match[1],
      path: JSON.parse(match[2]),
      firstArgument: source.slice(match.index + match[0].length),
      // Die öffnende Klammer steht in `ROUTE` direkt hinter der Methode, ihr
      // Ort ist deshalb ausrechenbar und muss nicht gesucht werden.
      body: routeBody(source, match.index + "router.".length + match[1].length)
    });
  }
  return found;
}

/**
 * Wie `readRoutes`, aber über MEHRERE Dateien hinweg — `files` ist die Liste
 * aus `routerFiles()` oder eine gleich geformte eigene (etwa mit
 * kommentarbereinigtem Inhalt, wie `api-mirror.test.mjs` es braucht). Jede
 * gefundene Route trägt zusätzlich `file`, den repo-relativen Pfad ihrer
 * Datei.
 *
 * Der Grund, warum das hier steht und nicht nur `routerFiles` + eine
 * `for`-Schleife beim Aufrufer: eine Fehlermeldung, die eine Route nennt,
 * muss auch die Datei nennen können, in der sie steht — sonst schickt der
 * Wächter den nächsten Leser auf die Suche.
 */
export function readAllRoutes(files) {
  const found = [];
  for (const { file, content } of files) {
    for (const route of readRoutes(content)) found.push({ ...route, file });
  }
  return found;
}
