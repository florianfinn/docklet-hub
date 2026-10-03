import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Wächter über die Filterleiste der Übersicht (D6, #62).
//
// Die Kennungen der Filter stehen an EINEM Ort
// (`CONTAINER_FILTERS` in web/src/screens/overview/container-filter.ts), ihre
// Beschriftungen an einem zweiten (die Sprachdateien) und die Zuordnung
// zwischen beiden an einem dritten (`FILTER_KEYS` in
// web/src/screens/OverviewScreen.tsx). Drei Orte, die zusammenpassen müssen.
//
// Was ohne diesen Wächter passiert, und zwar OHNE dass irgendetwas rot wird:
//
//   1. Ein vierter Filter kommt dazu, die Beschriftung fehlt. `keyof Messages`
//      fängt das — ABER nur, wenn jemand daran denkt, den Eintrag in
//      `FILTER_KEYS` zu ergänzen. Fehlt er dort, ist der Knopf beschriftungslos
//      und der Compiler zufrieden: `Record<ContainerFilter, …>` verlangt
//      Vollständigkeit, `CONTAINER_FILTERS` ist aber die Quelle des Typs, und
//      wer beide zusammen ändert, ändert die Prüfung mit.
//   2. Die Zuordnung verrutscht: `running: "overviewFilterAll"`. Der Typ ist
//      erfüllt, die Sprachdateien sind vollständig, jeder Schlüssel wird
//      benutzt — und der Chip „läuft“ heißt „alle“. Kein Werkzeug im Haus
//      bemerkt das, weil beide Seiten für sich richtig sind.
//   3. Ein Filter wird entfernt, seine Beschriftung bleibt stehen. Der
//      Sprachwächter (languages.test.mjs) meldet den unbenutzten Schlüssel —
//      aber erst, wenn ihn wirklich niemand mehr anfasst; ein zweiter,
//      falscher Verweis hielte ihn am Leben.
//
// GEPRÜFT WIRD:
//   1. `FILTER_KEYS` führt GENAU die Kennungen aus `CONTAINER_FILTERS`,
//   2. jede von ihnen zeigt auf `overviewFilter<Kennung>` — die Zuordnung ist
//      damit nicht nur vollständig, sondern richtig,
//   3. beide Sprachdateien kennen jeden dieser Schlüssel,
//   4. keine Sprachdatei trägt einen `overviewFilter…`-Schlüssel, zu dem es
//      keinen Filter gibt.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FILTER_PATH = "web/src/features/containers/container-filter.ts";
const SCREEN_PATH = "web/src/features/containers/filter-keys.ts";
const MESSAGE_PATHS = ["web/src/features/containers/messages/de.ts", "web/src/features/containers/messages/en.ts"];

const KEY_PREFIX = "overviewFilter";

function readOrFail(path) {
  const absolute = new URL(path, `file://${ROOT}`);
  assert.ok(existsSync(absolute), `${path} fehlt`);
  return readFileSync(absolute, "utf8");
}

// Zeilenkommentare weg, bevor gelesen wird: in einem Kommentar steht der Name
// eines Schlüssels als Erklärung, und ein Wächter, der ihn für eine
// Deklaration hält, meldet einen Schlüssel, den es nicht gibt.
export function withoutLineComments(source) {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
}

// Die Kennungen aus dem Listenliteral. Gelesen wird der Dateitext und nicht
// das Modul: `node --test` läuft hier ohne Bauschritt (AGENTS.md, Tests).
export function filterIdsInCode(source) {
  const match = /CONTAINER_FILTERS\s*=\s*\[([^\]]*)\]/.exec(source);
  if (match === null) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

// Die Zuordnung Kennung → Schlüssel aus `FILTER_KEYS`.
export function filterKeyMapInCode(source) {
  const match = /FILTER_KEYS[^=]*=\s*\{([^}]*)\}/.exec(source);
  if (match === null) return null;
  return new Map([...match[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*["']([^"']+)["']/g)].map((entry) => [entry[1], entry[2]]));
}

// Die Schlüssel eines Sprachobjekts — die Zeilen auf der ersten Ebene.
export function messageKeys(source) {
  return new Set([...withoutLineComments(source).matchAll(/^ {2}([A-Za-z0-9_]+)\s*:/gm)].map((entry) => entry[1]));
}

// „running“ wird zu „overviewFilterRunning“. Die Regel steht hier und nicht
// nur im Kopf: sie ist der Grund, warum dieser Wächter eine VERTAUSCHTE
// Zuordnung findet und nicht bloß eine unvollständige.
export function keyFor(id) {
  return `${KEY_PREFIX}${id[0].toUpperCase()}${id.slice(1)}`;
}

test("FILTER_KEYS führt genau die Filter aus CONTAINER_FILTERS, und jeder zeigt auf seinen eigenen Schlüssel", () => {
  const ids = filterIdsInCode(readOrFail(FILTER_PATH));
  assert.ok(ids !== null, `${FILTER_PATH}: das Listenliteral CONTAINER_FILTERS ist nicht zu finden`);
  assert.ok(ids.length > 0, `${FILTER_PATH}: CONTAINER_FILTERS ist leer — der Wächter liefe ins Leere`);

  const map = filterKeyMapInCode(readOrFail(SCREEN_PATH));
  assert.ok(map !== null, `${SCREEN_PATH}: die Zuordnung FILTER_KEYS ist nicht zu finden`);

  assert.deepEqual(
    [...map.keys()].sort(),
    [...ids].sort(),
    `${SCREEN_PATH}: FILTER_KEYS und CONTAINER_FILTERS führen nicht dieselben Filter — ` +
      `ein Knopf ohne Beschriftung oder eine Beschriftung ohne Knopf`
  );

  const wrong = ids.filter((id) => map.get(id) !== keyFor(id)).map((id) => `${id} → ${map.get(id)}`);
  assert.deepEqual(
    wrong,
    [],
    `Vertauschte Zuordnung in ${SCREEN_PATH}. Erwartet wird „<Kennung>" → „${keyFor("<Kennung>")}"; ` +
      `so steht der Chip mit dem Text eines anderen da, und nichts sonst bemerkt es:\n${wrong.join("\n")}`
  );
});

test("beide Sprachdateien tragen genau die Beschriftungen der vorhandenen Filter", () => {
  const ids = filterIdsInCode(readOrFail(FILTER_PATH));
  const expected = ids.map(keyFor).sort();

  for (const path of MESSAGE_PATHS) {
    const keys = messageKeys(readOrFail(path));
    assert.ok(keys.size > 0, `${path}: keine Schlüssel gefunden — Muster geändert?`);

    const present = [...keys].filter((key) => key.startsWith(KEY_PREFIX)).sort();
    assert.deepEqual(
      present,
      expected,
      `${path} und ${FILTER_PATH} weichen ab. Fehlt ein Schlüssel, bleibt ein Chip leer; ` +
        `steht einer zu viel, gehört er zu einem Filter, den es nicht mehr gibt`
    );
  }
});

test("die Leser selbst: was sie lesen müssen und was nicht", () => {
  // Ein Wächter ohne eigenen Test ist eine Behauptung.
  assert.deepEqual(filterIdsInCode('export const CONTAINER_FILTERS = ["all", "running"] as const;'), [
    "all",
    "running"
  ]);
  assert.deepEqual(filterIdsInCode("const CONTAINER_FILTERS = [\n  'a',\n  'b'\n];"), ["a", "b"]);
  assert.equal(filterIdsInCode('const OTHER_FILTERS = ["a"];'), null);

  const screen = 'const FILTER_KEYS: Record<ContainerFilter, keyof Messages> = {\n  all: "overviewFilterAll"\n};';
  assert.deepEqual([...filterKeyMapInCode(screen).entries()], [["all", "overviewFilterAll"]]);
  assert.equal(filterKeyMapInCode("const OTHER = { all: \"x\" };"), null);

  assert.equal(keyFor("stopped"), "overviewFilterStopped");

  // Die Gegenprobe zum Kommentar-Filter: ein Schlüsselname, der nur in einem
  // Kommentar steht, ist keine Deklaration.
  const messages = 'export const de = {\n  // overviewFilterGhost: "x",\n  overviewFilterAll: "alle",\n};';
  assert.deepEqual([...messageKeys(messages)], ["overviewFilterAll"]);

  // Und eine zweite Ebene wird nicht mitgelesen — dort stünden Schlüssel eines
  // Namensraums, die dieser Wächter nicht meint.
  assert.deepEqual([...messageKeys('export const de = {\n  a: {\n    overviewFilterAll: "x"\n  }\n};')], ["a"]);
});
