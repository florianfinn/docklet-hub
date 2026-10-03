import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as HUB_REASONS from "../../contract/src/stream/hub-stream-reasons.ts";
import { de, en } from "../src/app/i18n/messages.js";
import {
  SHELL_ERROR_REASONS,
  SHELL_FAILURE_REASONS,
  shellErrorMessageKey,
  shellFailureMessageKey
} from "../src/features/shell/shell-errors.js";
import { TERMINAL_COLOR_TOKENS } from "../src/features/shell/terminal-theme.js";
import { stripComments } from "./strip-comments.mjs";

// Die Wächter über den Reiter „Shell" (Paket B6, Etappe E6, #5), die sonst
// niemand hält.
//
// ── WOGEGEN SIE STEHEN ──────────────────────────────────────────────────────
//
// Der Reiter spricht mit vier Routen des Hubs, und die Zuordnung „Kennung →
// Satz" steht in `features/shell/shell-errors.ts`. Diese Zuordnung
// ist eine ABSCHRIFT: der Server erfindet die Kennungen, die Fläche schreibt
// sie ab. Zwei Abschriften derselben Liste laufen auseinander, und zwar
// lautlos — eine Kennung, die die Fläche nicht führt, fällt auf den
// Rückfallsatz mit dem rohen Wort darin. Das ist besser als ein leerer Kopf
// und trotzdem nicht das, was zugesagt ist.
//
// ⚠️ DIESER WÄCHTER LIEST DEN SERVER UND NICHT SEINE EIGENE VORSTELLUNG DAVON.
// Eine hier abgetippte Liste wäre die dritte Abschrift und die erste, die
// niemand nachzieht — dieselbe Fehlerklasse, die `api-mirror.test.mjs` für die
// Antwortformen hält.
//
// ⚠️ UND ER LIEST DIE TABELLE DER FLÄCHE ÜBER IHREN EXPORT statt über den
// Quelltext. Sie ist TypeScript, dieser Lauf fährt unter `tsx`, und ein
// Textleser über ein Objektliteral wäre die Sorte Wächter, die beim ersten
// mehrzeiligen Eintrag falsch liest statt stumm zu werden.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// The server side of the shell is a feature since #260: the route writes the
// answer, the service decides the refusals of the hub, and `rejections.ts`
// holds the table of the agent's refusals. The guard reads all three as one.
const SHELL_SERVER_FILES = ["routes.ts", "service.ts", "rejections.ts"].map(
  (name) => `${REPO_ROOT}server/src/features/shell/${name}`
);
const REQUIRE_ADMIN = `${REPO_ROOT}server/src/platform/auth/require-admin.ts`;
// The refusals the chain to the container can give are decided in
// `domain/hosts/container-access.ts`; `api/file-access.ts`, which wrote them as
// answers for the compose routes, left with the feature `compose` (#264).
const CONTAINER_ACCESS = `${REPO_ROOT}server/src/domain/hosts/container-access.ts`;
// ⚠️ DIE HERKUNFTSPRÜFUNG STEHT VOR JEDER ROUTE UNTER `/api` (#188) — auch vor
// den vier der Shell. Ihre `403 forbidden-origin` kann also jede davon
// treffen, obwohl sie in keiner der Dateien darüber steht.
const ORIGIN_GUARD = `${REPO_ROOT}server/src/platform/http/request-origin-guard.ts`;
const TOKENS_CSS = `${REPO_ROOT}web/src/platform/theme/tokens.css`;
const SHELL_VIEW = `${REPO_ROOT}web/src/features/shell/ShellView.tsx`;
// The session of the tab, the former mount effect of the view (#271).
const SHELL_SESSION = `${REPO_ROOT}web/src/features/shell/shell-session.ts`;

function readOrFail(path) {
  assert.ok(existsSync(path), `Datei fehlt: ${path}`);
  return stripComments(readFileSync(path, "utf8"));
}

/** The text of the shell's server files, comments stripped, as one source. */
function readShellServer() {
  return SHELL_SERVER_FILES.map((path) => readOrFail(path)).join("\n");
}

/**
 * Jede Kennung, mit der eine Datei antwortet: über `failWith` oder, seit #260,
 * über `problem(status, "kennung", …)`, den Wert, den ein Dienst ohne
 * `Response` zurückgibt.
 */
function failWithKeys(source) {
  return [
    ...source.matchAll(/failWith\(\s*response\s*,\s*\d+\s*,\s*"([a-z-]+)"|\bproblem\(\s*\d+\s*,\s*"([a-z-]+)"/g)
  ].map((found) => found[1] ?? found[2]);
}

/** Jede Kennung, die eine Datei in einem Objektliteral `error: "…"` führt. */
function errorFieldKeys(source) {
  return [...source.matchAll(/\berror:\s*"([a-z-]+)"/g)].map((found) => found[1]);
}

/**
 * Die Kennungen aus `openContainer`, namentlich und mit Grund.
 *
 * ⚠️ WARUM DIESE DREI NICHT MECHANISCH GELESEN WERDEN. Die Kette steht für
 * mehrere Flächen (Shell, Dateien, Freigaben, Compose), und nicht jede ihrer
 * Kennungen erreicht die Shell. Gelesen wird deshalb die Liste hier — und der
 * Fall darunter hält sie gegen die Dateien, damit sie nicht auf einen Namen
 * zeigt, den es nicht mehr gibt. (`share-unset` stand bis #262 in
 * `file-access.ts`; es gehört seitdem dem Feature `files`.)
 */
const FROM_OPEN_CONTAINER = new Map([
  ["host-unknown", "der Arm steht nicht mehr im Bestand des Hubs"],
  ["host-unreachable", "der Arm ist offline oder hat sich nie gemeldet"],
  ["agent-outdated", "der Agent ist zu alt für einen schreibenden Zugriff, und eine Shell ist der schreibendste"]
]);

/**
 * Die Kennungen aus der Kette (`container-access.ts`), die die Shell NICHT erreichen können —
 * namentlich, mit Grund, und vollständig.
 *
 * ⚠️ DIE VOLLSTÄNDIGKEIT IST DER PUNKT. Der Fall darunter rechnet
 * `container-access.ts` minus `FROM_OPEN_CONTAINER` minus dieser Liste und
 * verlangt, dass nichts übrig bleibt. Eine neue Kennung dort ist damit ROT,
 * bis jemand entschieden hat, ob die Shell sie sehen kann.
 */
const NOT_ON_THE_SHELL_PATH = new Map([
  [
    "container-unknown",
    "steht auch in `features/shell/rejections.ts` und wird dort schon mechanisch gelesen — hier wäre er nur doppelt"
  ],
  ["agent-forbidden", "dasselbe: `translateAgentError` und `features/shell/rejections.ts` führen ihn beide"],
  ["agent-unreachable", "dasselbe"],
  [
    "too-large",
    "`translateAgentError` bildet einen 413 des Arms darauf ab. Auf dem Weg der Shell steht als " +
      "einziger Agentenaufruf die Container-LISTE, und die kann keinen 413 ergeben — der Rückfall mit " +
      "der rohen Kennung trägt ihn, falls doch"
  ],
  ["agent-conflict", "dasselbe mit einem 409 der Container-Liste"]
]);

// ── 1. Jede Kennung des Hubs hat einen Text ─────────────────────────────────

test("jede Kennung, mit der der Hub eine Shell ablehnt, hat einen Satz", () => {
  const exec = readShellServer();
  const admin = readOrFail(REQUIRE_ADMIN);
  const origin = readOrFail(ORIGIN_GUARD);

  const fromServer = new Set([
    ...failWithKeys(exec),
    // Die Übersetzungstabelle der zwölf Ablehnungen des Agenten steht in
    // `features/shell/rejections.ts` als Objektliteral mit `error: "…"`.
    ...errorFieldKeys(exec),
    ...errorFieldKeys(admin),
    ...errorFieldKeys(origin),
    ...FROM_OPEN_CONTAINER.keys()
  ]);

  // ⚠️ SPERRKLINKE: findet der Leser nichts mehr, wäre der Rest still grün.
  // Gemessen am 2026-09-08 auf diesem Stand: 16.
  assert.ok(
    fromServer.size >= 16,
    `Der Leser findet nur ${fromServer.size} Kennungen im Serverquelltext (erwartet mindestens 16, ` +
      "gemessen 16 am 2026-09-08). Entweder ist eine entfallen — dann gehört die Zahl hier " +
      "heruntergesetzt und der Grund daneben — oder der Leser versteht die Schreibweise nicht mehr."
  );

  const missing = [...fromServer].filter((reason) => shellErrorMessageKey(reason) === null).sort();
  assert.deepEqual(
    missing,
    [],
    "Diese Kennungen kann der Hub schicken, und die Fläche hat keinen Satz dafür. Sie fallen auf den " +
      "Rückfall mit dem rohen Wort — lesbar, aber nicht das, was zugesagt ist:\n" + missing.join("\n")
  );
});

test("die Tabelle der Fläche führt keine Kennung, die es beim Hub nicht gibt", () => {
  // ⚠️ DIE ANDERE RICHTUNG, und sie ist die unauffälligere. Ein Eintrag für
  // eine Kennung, die kein Server mehr schickt, ist ein toter Satz: er steht
  // in beiden Sprachdateien, er wird von `languages.test.mjs` als „benutzt"
  // gezählt (die Tabelle nennt ihn ja), und niemand sieht ihn je.
  const known = new Set([
    ...failWithKeys(readShellServer()),
    ...errorFieldKeys(readShellServer()),
    ...errorFieldKeys(readOrFail(REQUIRE_ADMIN)),
    ...errorFieldKeys(readOrFail(ORIGIN_GUARD)),
    ...FROM_OPEN_CONTAINER.keys()
  ]);

  const orphans = SHELL_ERROR_REASONS.filter((reason) => !known.has(reason)).sort();
  assert.deepEqual(
    orphans,
    [],
    "Diese Sätze gehören zu Kennungen, die im Serverquelltext nicht mehr vorkommen:\n" + orphans.join("\n")
  );
});

test("die namentliche Liste aus openContainer zeigt auf Kennungen, die es dort gibt", () => {
  // ⚠️ OHNE DIESEN FALL WÄRE DIE LISTE OBEN EINE BEHAUPTUNG. Sie ist von Hand
  // geführt; ein umbenannter Schlüssel im Server machte sie stumm, und die
  // drei Sätze der Fläche zeigten auf nichts.
  const access = new Set(failWithKeys(readOrFail(CONTAINER_ACCESS)));
  const gone = [...FROM_OPEN_CONTAINER.keys()].filter((reason) => !access.has(reason));
  assert.deepEqual(
    gone,
    [],
    `Diese Kennungen führt ${CONTAINER_ACCESS} nicht mehr:\n${gone.join("\n")}`
  );

  // ⚠️ UND DIE GEGENRICHTUNG: was in `container-access.ts` steht und weder als
  // erreichbar noch als unerreichbar benannt ist, ist eine Entscheidung, die
  // niemand getroffen hat.
  const unclaimed = [...access]
    .filter((reason) => !FROM_OPEN_CONTAINER.has(reason) && !NOT_ON_THE_SHELL_PATH.has(reason))
    .sort();
  assert.deepEqual(
    unclaimed,
    [],
    "Diese Kennungen aus `container-access.ts` sind weder als erreichbar noch als unerreichbar benannt. " +
      "Solange das offen ist, weiß niemand, ob die Fläche dafür einen Satz braucht:\n" +
      unclaimed.join("\n")
  );
});

// ── 2. Die Gründe IM Strom ──────────────────────────────────────────────────

test("jeder Grund, den der Hub in einer fehler-Zeile schickt, hat einen Satz", () => {
  const exec = readShellServer();
  // ⚠️ TWO WAYS A REASON GETS INTO THE ROUTE, AND THE READER KNOWS BOTH.
  // Until #173 the reasons stood as literals in the line (`reason: "…"`);
  // since then they come as constants from
  // `contract/src/stream/hub-stream-reasons.ts`, and some run through
  // `closingReason()`, so not next to `kind: "error"` at all. That is why
  // EVERY `HUB_…` identifier of the route is read and resolved through the
  // module's exports; a literal that slips back in is still caught by the
  // first line.
  const literals = [...exec.matchAll(/kind:\s*"error",\s*reason:\s*"([a-z-]+)"/g)].map((found) => found[1]);
  const constants = [...new Set([...exec.matchAll(/\b(HUB_[A-Z_]+)\b/g)].map((found) => found[1]))];
  const unresolved = constants.filter((name) => typeof HUB_REASONS[name] !== "string").sort();
  assert.deepEqual(
    unresolved,
    [],
    `Diese Bezeichner in features/shell/ sind kein Grund aus hub-stream-reasons.ts:\n${unresolved.join("\n")}`
  );
  const reasons = [...literals, ...constants.map((name) => HUB_REASONS[name])];

  assert.ok(
    reasons.length >= 3,
    `Der Leser findet nur ${reasons.length} Gründe in features/shell/ (erwartet mindestens 3, ` +
      "gemessen 3 am 2026-09-29: `permission-revoked`, `session-closed`, `agent-stream-broken`)."
  );

  // Die Liste des Moduls für den Shell-Strom ist die, gegen die der
  // Sprachwächter hält (`hub-stream-reasons.test.mjs`). Sie muss also genau das
  // sein, was die Route tatsächlich schreibt.
  assert.deepEqual(
    [...new Set(reasons)].sort(),
    [...HUB_REASONS.HUB_SHELL_STREAM_REASONS].sort(),
    "`HUB_SHELL_STREAM_REASONS` und die Gründe in features/shell/ sind auseinandergelaufen."
  );

  const missing = [...new Set(reasons)].filter((reason) => shellFailureMessageKey(reason) === null).sort();
  assert.deepEqual(
    missing,
    [],
    "Diese Gründe schickt der Hub im Strom, und die Fläche hat keinen Satz dafür:\n" + missing.join("\n")
  );

  const orphans = SHELL_FAILURE_REASONS.filter((reason) => !reasons.includes(reason)).sort();
  assert.deepEqual(orphans, [], `Diese Sätze gehören zu Gründen, die der Hub nicht schickt:\n${orphans.join("\n")}`);
});

// ── 3. Jeder Satz steht in BEIDEN Sprachen und ist keiner der anderen ───────

test("jeder Satz der Shell steht in beiden Sprachen und keine zwei Kennungen teilen sich einen", () => {
  const keys = [
    ...SHELL_ERROR_REASONS.map((reason) => shellErrorMessageKey(reason)),
    ...SHELL_FAILURE_REASONS.map((reason) => shellFailureMessageKey(reason))
  ];

  const missing = keys.filter((key) => key === null || de[key] === undefined || en[key] === undefined);
  assert.deepEqual(missing, [], `Diese Sprachschlüssel gibt es nicht in beiden Sprachen:\n${missing.join("\n")}`);

  // ⚠️ ZWEI KENNUNGEN MIT DEMSELBEN SATZ SIND KEIN FORMFEHLER UND TROTZDEM
  // EIN BEFUND. `too-many-sessions` und `own-session-limit` sind beide `429`
  // und brauchen VERSCHIEDENE Texte: bei der einen wartet man, bis ein anderer
  // Mensch eine Shell schließt, bei der anderen schließt man seine eigene. Ein
  // gemeinsamer Satz gäbe der Hälfte der Leser den falschen Rat, und keine
  // Prüfkette sähe es.
  const seen = new Map();
  const shared = [];
  for (const key of keys) {
    const text = de[key];
    const first = seen.get(text);
    if (first !== undefined) shared.push(`„${first}" und „${key}" tragen denselben deutschen Satz`);
    else seen.set(text, key);
  }
  assert.deepEqual(shared, [], `Zwei Kennungen teilen sich einen Satz:\n${shared.join("\n")}`);
});

// ── 4. Die Farben des Terminals gibt es in tokens.css wirklich ──────────────

test("jedes Token, das die Fläche abliest, steht in tokens.css", () => {
  // ⚠️ EIN TIPPFEHLER IN EINEM TOKENNAMEN IST STILL. `var(--terminal-ansi-rot)`
  // löst zu nichts auf, `getComputedStyle` gibt dann den geerbten Wert oder
  // die leere Zeichenkette — und das Terminal zeichnet in `@xterm`s eigenem
  // Ton. Auf dem Bild sieht das aus wie ein Theme und nicht wie ein Fehler.
  const css = readFileSync(TOKENS_CSS, "utf8");
  const missing = TERMINAL_COLOR_TOKENS.filter((token) => !new RegExp(`\\${token}\\s*:`).test(css)).sort();
  assert.deepEqual(
    missing,
    [],
    `Diese Token liest die Shell ab, und tokens.css deklariert sie nicht:\n${missing.join("\n")}`
  );

  assert.ok(
    TERMINAL_COLOR_TOKENS.length >= 21,
    `Die Fläche liest nur ${TERMINAL_COLOR_TOKENS.length} Farben ab (erwartet mindestens 21: Fläche, ` +
      "Vordergrund, Cursor, Cursor-Gegenfarbe, Auswahl und sechzehn ANSI-Töne)."
  );
});

// ── 5. Kein Auto-Reconnect, im Quelltext ────────────────────────────────────

test("der Reiter trägt keinen Zeitgeber und keine Wiederholung", () => {
  // ⚠️ DER VERHALTENSFALL DANEBEN IST DER WICHTIGERE (`shell-view.test.tsx`
  // zählt die Aufrufe nach einem `end`). Dieser hier fängt die andere Hälfte:
  // eine Wiederholung, die jemand später „nur für den Netzfehler" einbaut und
  // die der Verhaltensfall nicht auslöst. Beides zusammen ist die Zusage.
  //
  // Entscheidung des Betreibers: der Reiter verbindet sich NIE von selbst neu.
  // Eine Schleife belegte die vier Sitzungsplätze des Arms, schriebe
  // Audit-Einträge unter dem Namen eines Menschen, der nicht am Rechner sitzt,
  // und öffnete eine Shell erneut, deren Recht gerade entzogen wurde.
  //
  // Since #271 the session runs in `shell-session.ts`, started by the view's
  // effect; both files are read, or the guard would go blind by the move.
  const source = [SHELL_VIEW, SHELL_SESSION].map((path) => readOrFail(path)).join("\n");
  const findings = [];
  for (const pattern of [/\bsetTimeout\s*\(/g, /\bsetInterval\s*\(/g, /\brequestAnimationFrame\s*\(/g]) {
    for (const found of source.matchAll(pattern)) {
      findings.push(found[0].trim());
    }
  }
  assert.deepEqual(
    findings,
    [],
    "Im Reiter „Shell“ steht ein Zeitgeber. Er ist der Anfang jeder Wiederverbindungsschleife, und die " +
      `ist hier ausgeschlossen:\n${findings.join("\n")}`
  );
});
