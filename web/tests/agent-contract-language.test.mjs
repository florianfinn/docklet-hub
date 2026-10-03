import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GERMAN_WORDS, splitWords } from "../../eslint-rules/english-identifiers.mjs";

// Every value hub and agent exchange is English (AGENTS.md, "Sprache"; #278).
//
// The values live in one place, the schemas under `contract/src/agent/`, and
// both sides import them. This guard walks every export of those modules at
// runtime and reports a German word in what travels on the wire: a literal,
// an enum entry, a field name, a constant or a list of keys. It checks the
// words against the list of the identifier rule
// (`eslint-rules/german-words.txt`), so that both guards mean the same by
// "German", and it reports any character outside ASCII, which catches an
// umlaut the list does not know.
//
// ⚠️ ONLY THE SCHEMAS, NOT EVERY STRING. `server/src` carries German test
// titles and error texts that are no protocol values (measured on 2026-10-01
// at `ab82d1d`: 886 test titles, about 10 `Error("…")` texts); checking every
// string there would make this guard a second umlaut guard with false alarms.
// A value that does not stand in a schema is not part of the contract either.
//
// ⚠️ It walks the schema objects, not the source text: a value reaches the
// wire through what zod holds, and a comment that quotes an old value is no
// finding. The message of a single check (`{ error: "…" }`) is a function
// inside zod and is not walked; the keys a check may name are the exported
// `REQUEST_REJECTION_REASONS`, which are.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACT_AGENT = join(ROOT, "contract/src/agent");

// The words of one value: split at everything that is no letter or digit,
// then like an identifier (camelCase, snake_case).
function germanWordsOf(value) {
  return value
    .split(/[^A-Za-z0-9]+/)
    .flatMap((piece) => splitWords(piece))
    .filter((word) => GERMAN_WORDS.has(word));
}

function isSchema(value) {
  return typeof value === "object" && value !== null && "_zod" in value;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Every finding in one exported value, as `path: value (word)`.
export function findingsInValue(name, root) {
  const findings = [];
  const seen = new Set();
  const check = (path, text) => {
    if (typeof text !== "string") return;
    for (const word of germanWordsOf(text)) findings.push(`${path}: "${text}" (${word})`);
    if (/[^\x20-\x7e]/.test(text)) findings.push(`${path}: "${text}" (non-ASCII)`);
  };
  const walk = (path, value) => {
    if (typeof value === "string") return check(path, value);
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach((item, index) => walk(`${path}[${index}]`, item));
    if (isSchema(value)) {
      const def = value._zod.def;
      if (def.type === "object") {
        for (const [field, schema] of Object.entries(def.shape)) {
          check(`${path}.${field}`, field);
          walk(`${path}.${field}`, schema);
        }
        return;
      }
      if (def.type === "literal") return def.values.forEach((literal, index) => check(`${path}<literal ${index}>`, literal));
      if (def.type === "enum") return Object.values(def.entries).forEach((entry) => check(`${path}<enum>`, entry));
      // Wrappers and compositions: optional, default, pipe, union, array,
      // record … carry their parts as schemas (or lists of them) in `def`.
      for (const [key, part] of Object.entries(def)) {
        if (isSchema(part) || (Array.isArray(part) && part.some(isSchema))) walk(`${path}.${key}`, part);
        else if (key === "defaultValue") walk(`${path}.default`, part);
      }
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        check(`${path}.${key}`, key);
        walk(`${path}.${key}`, item);
      }
    }
  };
  walk(name, root);
  return findings;
}

export async function findingsInModule(file) {
  const module = await import(pathToFileURL(file).href);
  return Object.entries(module).flatMap(([name, value]) => findingsInValue(name, value));
}

const MODULES = readdirSync(CONTRACT_AGENT)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .sort();

test("der Wächter sieht jede Datei unter contract/src/agent/", () => {
  // Nine on 2026-10-02, measured with `ls contract/src/agent`. A selection
  // that finds nothing would report success over an empty set.
  assert.ok(MODULES.length >= 9, `nur ${MODULES.length} Dateien unter contract/src/agent/ gefunden`);
});

test("jeder ausgetauschte Wert in contract/src/agent/ ist englisch", async () => {
  const findings = [];
  let values = 0;
  for (const file of MODULES) {
    const module = await import(pathToFileURL(join(CONTRACT_AGENT, file)).href);
    values += Object.keys(module).length;
    for (const finding of await findingsInModule(join(CONTRACT_AGENT, file))) findings.push(`${file} ${finding}`);
  }
  assert.ok(values > 50, `nur ${values} Exporte gelesen — das sieht nach einem Unfall aus`);
  assert.deepEqual(findings, [], `Deutsche Wörter in Werten des Agent-Protokolls:\n${findings.join("\n")}`);
});

test("der Wächter fällt an einer falschen Beispieldatei", async () => {
  // A throwaway module with one German value in each place the guard reads:
  // a literal, an enum entry, a field name, a key list and a constant. The
  // words come from the list itself, so this file carries none of its own.
  const zod = pathToFileURL(join(ROOT, "contract/node_modules/zod/v4/mini/index.js")).href;
  const dir = mkdtempSync(join(tmpdir(), "agent-contract-language-"));
  try {
    const file = join(dir, "sample.mjs");
    const [literal, entry, field, key, constant] = ["zeile", "datei", "pfad", "fehler", "verzeichnis"];
    writeFileSync(
      file,
      [
        `import * as z from ${JSON.stringify(zod)};`,
        `export const lineSchema = z.object({ kind: z.literal("${literal}"), text: z.string() });`,
        `export const kindSchema = z.optional(z.enum(["file", "${entry}"]));`,
        `export const querySchema = z.object({ ${field}: z._default(z.string(), "") });`,
        `export const REASONS = ["too-large", "${key}-missing"];`,
        `export const SESSION_KEY = "${constant}";`,
        `export const NAMES = { umlaut: "gr\\u00f6\\u00dfe" };`
      ].join("\n")
    );
    const findings = await findingsInModule(file);
    for (const word of [literal, entry, field, key, constant]) {
      assert.ok(
        findings.some((finding) => finding.endsWith(`(${word})`)),
        `kein Fund für ${word}:\n${findings.join("\n")}`
      );
    }
    assert.ok(findings.some((finding) => finding.endsWith("(non-ASCII)")), `kein Fund für den Umlaut:\n${findings.join("\n")}`);
    // English values next to them stay silent.
    assert.ok(!findings.some((finding) => finding.includes('"file"') || finding.includes('"too-large"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
