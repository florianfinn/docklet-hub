import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripComments } from "./strip-comments.mjs";
import * as sharedContract from "../../contract/src/index.ts";

// The two cases of the former contract guard that never compared against the
// separate agent repo (#274). Both read `contract/src/agent/`, the one home of
// the protocol values since #272, and nothing outside this repository:
//
//   1. the display table in `features/logs/log-errors.ts` covers exactly the
//      contract's log stream failure reasons,
//   2. every protocol value is declared exactly once, in the contract.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function tracked(...patterns) {
  const files = execFileSync("git", ["ls-files", ...patterns], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.ok(files.length > 0, `git ls-files ${patterns.join(" ")} lieferte nichts — der Wächter liefe ins Leere`);
  return files;
}

function read(path) {
  return readFileSync(new URL(path, `file://${ROOT}`), "utf8");
}

function body(path) {
  return stripComments(read(path));
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

// Reads a string or template literal at `index` and returns its content, or
// `null` when none starts there. Known limit: a backtick INSIDE a `${…}` ends
// the literal too early.
function readLiteral(content, index) {
  const quote = content[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let value = "";
  let position = index + 1;
  while (position < content.length) {
    const character = content[position];
    if (character === "\\") {
      value += content.slice(position, position + 2);
      position += 2;
      continue;
    }
    if (character === quote) return value;
    value += character;
    position += 1;
  }
  return null;
}

// The ranges of a source that hold a literal, as pairs of start and end. A
// quote is not a declaration: `"const MAX_TAIL = 2_000"` in a string must not
// count as a second `MAX_TAIL`.
function stringSpans(content) {
  const spans = [];
  let position = 0;
  while (position < content.length) {
    const quote = content[position];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      position += 1;
      continue;
    }
    const start = position;
    position += 1;
    while (position < content.length) {
      if (content[position] === "\\") {
        position += 2;
        continue;
      }
      if (content[position] === quote) {
        position += 1;
        break;
      }
      position += 1;
    }
    spans.push([start, position]);
  }
  return spans;
}

function insideLiteral(spans, index) {
  return spans.some(([start, stop]) => index > start && index < stop);
}

// ---------------------------------------------------------------------------
// 1. The display covers exactly the contract's reasons
// ---------------------------------------------------------------------------

// The seam between contract and surface. A new reason in the contract turns
// this case red and points at the display; otherwise the operator would get
// the fallback text with the raw value in it. It demands EQUALITY, not a
// subset: a reason too many in the display waits for a value that no longer
// exists. Entries are split at top-level commas, not at line breaks, so a
// second entry on the same line still counts.

const LOG_VIEW = "web/src/features/logs/log-errors.ts";
const FAILURE_TABLE = "FAILURE_KEY_BY_REASON";

// The head of ONE entry: the key, quoted or bare, then the colon.
const TABLE_KEY = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/;

function tableEntries(block) {
  const entries = [];
  let depth = 0;
  let start = 0;
  let position = 0;
  while (position < block.length) {
    const character = block[position];
    if (character === '"' || character === "'" || character === "`") {
      const literal = readLiteral(block, position);
      position += (literal === null ? 0 : literal.length) + 2;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") depth += 1;
    if (character === "}" || character === "]" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      entries.push({ text: block.slice(start, position), index: start });
      start = position + 1;
    }
    position += 1;
  }
  entries.push({ text: block.slice(start), index: start });
  return entries.filter((entry) => entry.text.trim() !== "");
}

function tableKeys(content, name) {
  const start = content.indexOf(`const ${name}`);
  if (start === -1) return null;
  const open = content.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  let position = open;
  while (position < content.length) {
    const character = content[position];
    if (character === '"' || character === "'" || character === "`") {
      const literal = readLiteral(content, position);
      position += (literal === null ? 0 : literal.length) + 2;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    position += 1;
  }
  const block = content.slice(open + 1, position);

  const keys = [];
  const unreadable = [];
  for (const entry of tableEntries(block)) {
    const match = TABLE_KEY.exec(entry.text);
    if (match === null) {
      unreadable.push({ line: lineOf(content, open + 1 + entry.index), text: entry.text.trim() });
      continue;
    }
    keys.push(match[1] ?? match[2] ?? match[3]);
  }
  return { keys, unreadable };
}

test("FAILURE_KEY_BY_REASON deckt genau LOG_STREAM_FAILURE_REASONS ab", () => {
  const content = body(LOG_VIEW);
  const table = tableKeys(content, FAILURE_TABLE);

  assert.notEqual(table, null, `${LOG_VIEW}: „${FAILURE_TABLE}“ steht dort nicht mehr — die Naht ist umgebaut`);

  // Readability first: an entry without a readable head is a key this case
  // did NOT count, and an uncounted key would turn it falsely green or red. It
  // is reported with its line, not swallowed.
  assert.deepEqual(
    table.unreadable.map((entry) => `${LOG_VIEW}:${entry.line}: „${entry.text}“`),
    [],
    `${LOG_VIEW}: ein Eintrag von ${FAILURE_TABLE} trägt keinen lesbaren Schlüssel — ` +
      "der Fall zählt ihn nicht mit und misst damit eine andere Tabelle als die, die dasteht."
  );

  assert.deepEqual(
    [...table.keys].sort(),
    [...sharedContract.LOGS_STREAM_FAILURE_REASONS].sort(),
    `${LOG_VIEW}: die Gründe von ${FAILURE_TABLE} und LOG_STREAM_FAILURE_REASONS ` +
      "gehen auseinander. Ein Grund, den die Anzeige nicht kennt, kommt beim Betreiber als " +
      "roher Wert an; einer, den der Vertrag nicht kennt, wartet auf etwas, das nie eintrifft."
  );
});

// `HUB_FAILURE_KEY_BY_REASON` in the same file carries the reasons the HUB
// writes itself; `web/tests/hub-stream-reasons.test.mjs` holds it.

// ---------------------------------------------------------------------------
// 2. No protocol value is declared twice
// ---------------------------------------------------------------------------

// The relapse this case prevents is no big decision: someone needs `MAX_TAIL`
// in a file, the import is one step further away than the number, and then
// two truths stand there, neither of which looks wrong. Listed are the values
// that once stood in several places or would be a literal at the call site.

const SINGLE_DECLARATION = [
  "SECRET_HEADER",
  "ACTOR_HEADER",
  "TIER_HEADER",
  "HUB_TIER",
  "MAX_UPLOAD_BYTES",
  "MAX_TEXT_BYTES",
  "MAX_ENTRIES",
  "MAX_COMPOSE_BYTES",
  "FILE_ACTIONS",
  "MIN_TAIL",
  "MAX_TAIL",
  "DEFAULT_TAIL",
  "MAX_OPEN_STREAMS",
  "HUB_REGISTRY_ORIGIN",
  "EXEC_MAX_SESSIONS",
  "EXEC_MAX_DURATION_MS",
  "EXEC_IDLE_MS",
  "EXEC_DEFAULT_COLS",
  "EXEC_DEFAULT_ROWS",
  "EXEC_MIN_COLS",
  "EXEC_MAX_COLS",
  "EXEC_MIN_ROWS",
  "EXEC_MAX_ROWS",
  "EXEC_MAX_INPUT_BASE64_CHARS",
  "EXEC_SHELL_CANDIDATES",
  "EXEC_SESSION_REJECTION_KEY"
];

const CONTRACT_FILES = [
  "contract/src/agent/headers.ts",
  "contract/src/agent/limits.ts",
  "contract/src/agent/reasons.ts",
  "contract/src/agent/requests.ts"
];

// Only the sources that build hub and agent are read. A value declared a
// second time under `scripts/` or in a test file does not show up here; nobody
// builds the hub or the agent there.
const DECLARATION_SOURCES = [
  "server/src/*.ts",
  "server/src/*.tsx",
  "web/src/*.ts",
  "web/src/*.tsx",
  "contract/src/*.ts",
  "agent/src/*.ts"
];

test("ein Zitat zählt nicht als Deklaration, eine echte daneben aber schon", () => {
  // The counter-check for `stringSpans`: without it the recognizer could one
  // day skip EVERYTHING, and case 2 would stay green for no visible reason.
  const sample = [
    'const anchor = { expect: "const MAX_TAIL = 2_000" };',
    "const MAX_TAIL = 2_000;",
    "const template = `const MAX_TAIL = 2_000`;"
  ].join("\n");
  const spans = stringSpans(sample);
  const found = [];
  for (const match of sample.matchAll(/\b(?:export\s+)?const\s+MAX_TAIL\b/g)) {
    if (insideLiteral(spans, match.index)) continue;
    found.push(lineOf(sample, match.index));
  }

  assert.deepEqual(found, [2], "nur die echte Deklaration in Zeile 2 zählt — das Zitat und das Template nicht");
});

test("jeder Vertragswert ist genau einmal deklariert, und zwar in der Vertragsdatei", () => {
  const findings = [];
  const sources = tracked(...DECLARATION_SOURCES)
    .filter((path) => !path.includes(".test."))
    .map((path) => {
      const content = body(path);
      return { path, content, spans: stringSpans(content) };
    });

  for (const name of SINGLE_DECLARATION) {
    // Without this line the list could one day guard a name the contract no
    // longer has, and stay green.
    assert.ok(
      name in sharedContract,
      `keine der Vertragsdateien (${CONTRACT_FILES.join(", ")}) exportiert „${name}“ noch — die Liste unten ist veraltet`
    );

    // ⚠️ `export` is OPTIONAL, and that is measured: with `\bexport\s+const`
    // a second `const MAX_TAIL` without `export` stayed green. That is how the
    // second truth arises: whoever writes the number next to the call site
    // does not export it.
    const declaration = new RegExp(`\\b(?:export\\s+)?const\\s+${name}\\b`, "g");
    const places = [];
    for (const source of sources) {
      for (const match of source.content.matchAll(declaration)) {
        // A quote is not a declaration, see `stringSpans`.
        if (insideLiteral(source.spans, match.index)) continue;
        places.push(`${source.path}:${lineOf(source.content, match.index)}`);
      }
    }
    if (places.length === 1 && CONTRACT_FILES.some((file) => places[0].startsWith(`${file}:`))) continue;
    findings.push(
      places.length === 0
        ? `${name}: nirgends als „const“ deklariert`
        : `${name}: ${places.length}-mal deklariert — ${places.join(", ")}`
    );
  }

  assert.deepEqual(
    findings,
    [],
    `Ein Vertragswert steht nicht mehr genau einmal in contract/src/agent/:\n${findings.join("\n")}`
  );
});
