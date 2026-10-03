import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GERMAN_WORDS } from "../../eslint-rules/english-identifiers.mjs";
// The agent's reason sets come from the shared contract since #272.
import {
  COMPOSE_RAW_FAILURE_REASONS,
  LOG_FILE_FAILURE_REASONS,
  LOGS_STREAM_FAILURE_REASONS as LOG_STREAM_FAILURE_REASONS,
  PULL_STREAM_FAILURE_REASONS
} from "../../contract/src/index.ts";
import {
  HUB_COMPOSE_STREAM_REASONS,
  HUB_LOG_STREAM_REASONS,
  HUB_SHELL_STREAM_REASONS
} from "../../contract/src/stream/hub-stream-reasons.ts";
import { SHELL_FAILURE_REASONS } from "../src/features/shell/shell-errors.js";

// Die Gründe, die DER HUB SELBST in eine `error`-Zeile schreibt — und dass
// sie sich mit keinem des Agenten ein Wort teilen (#130, #173).
//
// The `error` event of a stream carries values from TWO sources, and that is
// not carelessness but the design:
//
//   the AGENT   sends one of the reasons in `LOG_STREAM_FAILURE_REASONS` in
//               the log stream: it ran into a problem and reports it
//   the HUB     writes a reason from `contract/src/stream/hub-stream-reasons.ts`
//               when the line to the arm breaks, it closes the shell itself
//               or a permission is revoked: nobody reported anything
//
// The shell stream has only the second source; the agent sends no `error`
// line there.
//
// ⚠️ DER BEFUND, DER ZU DIESEM WÄCHTER GEFÜHRT HAT: bis #130 (Log) und #173
// (Shell) schrieb der Hub an diesen Stellen `abgebrochen`. Das war beim Agenten
// bis v0.23.0 der Wert für „der Aufrufer hat abgebrochen" — ein Wortlaut, zwei
// Ereignisse. Der Browser konnte einen Ausfall des Arms nicht von seinem
// eigenen Abbruch unterscheiden. Die Shell trug dazu `recht-entzogen`, und über
// ihrer Tabelle stand, beide seien Werte der Gegenseite.
//
// Dieser Wächter hält deshalb FÜNF Dinge fest, und keines davon fängt ein
// anderer:
//
//   1. die Anzeige führt für jeden Strom genau die Gründe, die der Server hat
//   2. kein Grund des Hubs fällt mit einem des Agenten zusammen
//   3. kein Grund des Hubs sieht aus wie ein Abbruch
//   4. kein Grund des Hubs ist deutsch
//   5. fehlt ein Grund, setzt niemand einen ein — kein Wort und kein
//      Meldungstext (#176)
//
// Dass die Routen die Liste des Moduls auch tatsächlich schreiben, halten
// `shell-guards.test.mjs` (Shell), der erste Fall unten (Log) und der fünfte
// Punkt (Anwenden).
//
// Punkt 2 ist der, der ohne Wächter still bricht: eine spätere Agentenfassung
// kann einen Grund dazunehmen, der zufällig so heißt wie einer des Hubs. Dann
// entscheidet in `log-errors.ts` die Reihenfolge zweier Nachschlagevorgänge
// darüber, welcher Satz erscheint — und rot wird dabei nichts.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOG_ROUTE = "server/src/features/logs/routes.ts";
const LOG_VIEW = "web/src/features/logs/log-errors.ts";
const HUB_TABLE = "HUB_FAILURE_KEY_BY_REASON";

/** Alle Wertesätze des Agenten, die in einer `error`-Zeile stehen können. */
const AGENT_REASONS = [
  ...LOG_STREAM_FAILURE_REASONS,
  ...PULL_STREAM_FAILURE_REASONS,
  ...LOG_FILE_FAILURE_REASONS,
  ...COMPOSE_RAW_FAILURE_REASONS
];

const ALL_HUB_REASONS = [
  ...new Set([...HUB_LOG_STREAM_REASONS, ...HUB_SHELL_STREAM_REASONS, ...HUB_COMPOSE_STREAM_REASONS])
];

function body(relative) {
  return readFileSync(`${ROOT}${relative}`, "utf8");
}

/**
 * Die Schlüssel der Tabelle des Hubs in `log-errors.ts`.
 *
 * ⚠️ ÜBER DEN QUELLTEXT UND NICHT ÜBER EINEN EXPORT: die Tabelle ist eine
 * private Konstante einer Komponente, und ein Export nur für diesen Wächter
 * schnitte die Datei nach der Prüfung zu.
 */
function hubReasonsInLogView() {
  const content = body(LOG_VIEW);
  const start = content.indexOf(`const ${HUB_TABLE}`);
  if (start === -1) return null;
  const open = content.indexOf("{", start);
  const close = content.indexOf("};", open);
  if (open === -1 || close === -1) return null;
  return [...content.slice(open, close).matchAll(/"([^"]+)":/g)].map((match) => match[1]);
}

test("die Log-Anzeige führt genau die Gründe, die der Hub im Log-Strom schreibt", () => {
  // Die Route schreibt die Konstante und kein Literal — sonst liefe der
  // Wortlaut an diesem Modul vorbei.
  const route = body(LOG_ROUTE);
  assert.ok(
    /reason:\s*HUB_STREAM_BROKEN\b/.test(route),
    `${LOG_ROUTE}: der abgerissene Rumpf schreibt nicht mehr \`HUB_STREAM_BROKEN\` — die Naht ist umgebaut`
  );

  const inView = hubReasonsInLogView();
  assert.notEqual(inView, null, `${LOG_VIEW}: „${HUB_TABLE}“ steht dort nicht mehr — die Naht ist umgebaut`);
  assert.deepEqual(
    [...inView].sort(),
    [...HUB_LOG_STREAM_REASONS].sort(),
    `Der Hub schreibt ${JSON.stringify(HUB_LOG_STREAM_REASONS)} in den Log-Strom, ${LOG_VIEW} erwartet ` +
      `${JSON.stringify(inView)}. Gehen die beiden auseinander, fällt der Grund des Hubs in den rohen ` +
      "Rückfall — der Mensch liest dann eine Kennung statt eines Satzes, und niemand merkt es."
  );
});

test("die Shell-Anzeige führt genau die Gründe, die der Hub im Shell-Strom schreibt", () => {
  assert.deepEqual(
    [...SHELL_FAILURE_REASONS].sort(),
    [...HUB_SHELL_STREAM_REASONS].sort(),
    "`FAILURE_KEY_BY_REASON` in shell-errors.ts und `HUB_SHELL_STREAM_REASONS` sind auseinandergelaufen."
  );
});

test("kein Grund des Hubs fällt mit einem des Agenten zusammen", () => {
  const shared = ALL_HUB_REASONS.filter((reason) => AGENT_REASONS.includes(reason));

  assert.deepEqual(
    shared,
    [],
    `Derselbe Wortlaut steht beim Hub und beim Agenten: ${JSON.stringify(shared)}. Der Hub erfindet damit ` +
      "einen Wert der Gegenseite neu, und genau das war der Befund von #130 und #173 — zwei verschiedene " +
      "Ereignisse unter einem Wort, zwischen denen die Anzeige nicht mehr wählen kann."
  );
});

test("der Hub führt keinen Abbruch als Fehlergrund", () => {
  // ⚠️ EINE ABWESENHEIT ALS GEGENSTAND: ein Abbruch des Browsers bekommt gar
  // keine Zeile. Ein Wert, der ihn benennt, wäre der Rückweg dorthin, wo #130
  // angefangen hat — der Normalfall als Störung gemeldet, und zwar in eine
  // Verbindung, die es nicht mehr gibt.
  //
  // Dass die Routen tatsächlich schweigen, halten `container-routes.test.ts`
  // und `exec-session-routes.test.ts` an echten Verbindungen fest. Dieser Fall
  // hält den Wortschatz.
  const forbidden = ["abgebrochen", "aborted", "canceled", "cancelled", "client-gone"];
  const found = ALL_HUB_REASONS.filter((reason) => forbidden.includes(reason));

  assert.deepEqual(found, [], `Ein Abbruch gehört in keinen Fehlergrund: ${JSON.stringify(found)}.`);
});

test("kein Grund des Hubs ist deutsch", () => {
  // ⚠️ AGENTS.md, Abschnitt Sprache: ein Wert, den der Hub selbst erfindet,
  // steht englisch. Die ESLint-Regel sieht Zeichenketten nicht; hier stehen
  // die Werte als Liste, und dieselbe Wortliste lässt sich an sie anlegen.
  // Sie fängt, was in ihr steht — `abgebrochen` und `recht` zum Beispiel.
  const german = ALL_HUB_REASONS.filter((reason) =>
    reason.split("-").some((word) => GERMAN_WORDS.has(word) || /[äöüß]/.test(word))
  );

  assert.deepEqual(german, [], `Diese Gründe des Hubs tragen ein deutsches Wort: ${JSON.stringify(german)}.`);

  // Gegenprobe, damit der Fall nicht an einer leeren Wortliste grün wird.
  assert.ok(
    ["recht-entzogen", "abgebrochen"].every((old) => old.split("-").some((word) => GERMAN_WORDS.has(word))),
    "Die Wortliste erkennt die beiden Werte von vor #173 nicht mehr — der Fall prüft dann nichts."
  );
});

// ── Punkt 5: ein fehlender Grund bleibt fehlend (#176) ──────────────────────
//
// ⚠️ DER BEFUND: fehlte in einer `error`-Zeile das Feld `reason`, setzten
// Browser und Server an neun Stellen `unbekannt` ein — deutsch, in dem Feld, in
// dem sonst die Werte des Agenten stehen. Die Anwende-Route schrieb bei einer
// Ausnahme sogar `error.message` hinein, einen freien deutschen Satz, und der
// Schlüssel, den der Agent geschickt hatte, verschwand darin. Seitdem steht an
// diesen Stellen `null`, und die Anzeige hat dafür einen eigenen Satz.
//
// Der Wächter sucht die FORMEN, in denen ein Rückfall geschrieben wird, und
// nicht das eine Wort — ein `"unknown"` an derselben Stelle wäre derselbe
// Befund in englisch.
//
// ⚠️ EIN LEERER RÜCKFALL (`?? ""`) ZÄHLT NICHT. Er erfindet kein Wort, und die
// Vorschau des Anwendens (`preview.reason ?? ""`) nutzt ihn für einen
// Anzeigeparameter und nicht für ein Grundfeld. Die Muster verlangen deshalb
// ein Literal mit Inhalt. Gemessen am 2026-09-29: ohne diese Grenze meldete der
// Fall genau diese zwei Stellen und dazu `new ApiError(response.status, "…")`
// — deshalb liest die zweite Form nur Felder eines Leitungsdatensatzes
// (`record`).

/** Die Formen eines erfundenen Rückfalls, jede mit dem Fall, der sie belegt. */
const FALLBACK_SHAPES = [
  {
    name: "Ternär mit Literal hinter einer Typprüfung des Grundes",
    pattern: /typeof\s+[\w.]*\breason\s*===\s*"string"\s*\?\s*[\w.]+\s*:\s*"[^"]+"/,
    before: 'options.onFailure?.({ reason: typeof record.reason === "string" ? record.reason : "unbekannt" });'
  },
  {
    name: "Hilfsfunktion mit Literal als Rückfall für Grund oder Status",
    pattern: /\(\s*(?:object\(\s*)?record\b[\w.()]*\.(?:reason|status)\s*,\s*"[^"]+"\s*\)/,
    before: 'status: text(object(record.resync).status, "unbekannt"),'
  },
  {
    name: "`??` mit Literal an einem Grund",
    pattern: /[rR]eason\b[^;\n]*\?\?\s*"[^"]+"/,
    before: 'revise((current) => ({ ...current, sendErrorReason: execErrorKey(error) ?? "unbekannt" }));'
  },
  {
    name: "Meldungstext einer Ausnahme als Grund",
    pattern: /\breason:\s*(?:error\s+instanceof\s+Error\s*\?\s*)?error\.message\b/,
    before: 'reason: error instanceof Error ? error.message : "unbekannt"'
  },
  {
    // ⚠️ DIE EINZIGE FORM MIT WORTLISTE: `reason: "host-unknown"` ist ein
    // gewollter Wert des Hubs und steht so an vielen Stellen. Gemeldet wird
    // das Literal nur, wenn es ein deutsches Wort trägt.
    name: "deutsches Literal als Grund",
    pattern: /\breason:\s*"([^"]+)"/,
    german: true,
    before: 'return outcome ?? { kind: "failed", reason: "unbekannt" };'
  }
];

/** Trägt dieser Wert ein deutsches Wort? Dieselbe Prüfung wie oben. */
function isGerman(value) {
  return value.split(/[-\s]/).some((word) => GERMAN_WORDS.has(word.toLowerCase()) || /[äöüß]/.test(word));
}

/** Die Treffer einer Form in einem Text — bei der letzten nur die deutschen. */
function hitsOf(shape, content) {
  const hits = [...content.matchAll(new RegExp(shape.pattern.source, "g"))];
  return hits.filter((hit) => !shape.german || isGerman(hit[1])).map((hit) => hit[0]);
}

/** Die Quelldateien beider Workspaces, ohne Tests — über `git ls-files`. */
function trackedSources() {
  const files = execFileSync("git", ["ls-files", "web/src", "server/src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file) && !/-test-support\.ts$/.test(file));
  assert.ok(files.length > 50, `git ls-files lieferte nur ${files.length} Quelldateien — der Fall liefe ins Leere`);
  return files;
}

test("fehlt ein Grund, setzen weder Hub noch Browser einen ein (#176)", () => {
  const found = [];
  for (const file of trackedSources()) {
    const content = body(file);
    for (const shape of FALLBACK_SHAPES) {
      for (const hit of hitsOf(shape, content)) found.push(`${file}: ${shape.name}: ${hit.replace(/\s+/g, " ")}`);
    }
  }

  assert.deepEqual(
    found,
    [],
    "Hier setzt der Code einen Grund ein, wo keiner kam. Ein fehlender Grund bleibt `null`, und die Anzeige " +
      "hat dafür einen eigenen Satz — siehe den Schluss von `contract/src/stream/hub-stream-reasons.ts`."
  );
});

test("jede Form des Rückfalls erkennt die Zeile, die #176 entfernt hat", () => {
  // Gegenprobe, damit der Fall oben nicht an einem Muster grün wird, das
  // nichts mehr trifft.
  for (const shape of FALLBACK_SHAPES) {
    assert.ok(hitsOf(shape, shape.before).length === 1, `„${shape.name}" erkennt ihren eigenen Beleg nicht mehr.`);
  }
  // Und die letzte Form lässt einen englischen Wert des Hubs stehen.
  const literal = FALLBACK_SHAPES.find((shape) => shape.german);
  assert.ok(hitsOf(literal, 'reason: "host-unknown"').length === 0, "ein englischer Grund wird als deutsch gemeldet");
});

test("der Anwende-Dienst schreibt nach Beginn des Stroms den Grund des Agenten oder das Wort des Hubs", () => {
  const route = body("server/src/features/compose/service.ts");
  assert.ok(
    /reason:\s*agentFailure\.current === null \? HUB_STREAM_BROKEN : agentFailure\.current\.reason/.test(route),
    "server/src/features/compose/service.ts: die `error`-Zeile nach Beginn des Stroms ist umgebaut — " +
      "sie muss den Grund des Agenten wörtlich tragen oder `HUB_STREAM_BROKEN`, nie einen Meldungstext."
  );
  assert.deepEqual([...HUB_COMPOSE_STREAM_REASONS], ["agent-stream-broken"]);
});
