// The `.env` file next to the compose file (S5b, CONTAINER_ETAPPENPLAN_LOCAL §16).
//
// Up to here it was the blind spot of the whole compose management:
// `readComposeFile()` reads the compose file, and right NEXT to it lie the
// secrets. The 5d survey names `foundryvtt` as evidence — a password in the
// `.env` that would have moved into the YAML in plain text on regeneration.
//
// Three guarantees of this module:
//
//  1. **Plain text leaves the agent only on explicit request.**
//     The same construction as `includeEnvPlaintext` in redact.ts: whoever
//     specifies nothing gets keys and `••••`.
//
//  2. **Writing is surgical, not regenerating.** On save, exactly the lines
//     whose value changed are replaced; everything else — comments, order,
//     blank lines, unusual spellings — stays byte for byte. That is the same
//     reason why `writeRawComposeFile` stands next to `writeComposeFile`: the
//     loss comes from the TRANSLATION, not from the writing (§13.1).
//
//  3. **Never overwritten blindly.** Hash of the actual state against the
//     expected one, just as for the compose file (compose-store.ts).

import fs from "node:fs";
import path from "node:path";
import { isInsideBase } from "./compose.js";
import { hashOf, type WriteOptions, type WriteResult } from "./compose-store.js";

// Compose reads the project `.env` under exactly this name from the project
// directory. There is deliberately NO file name parameter — the same reasoning
// as for writeComposeFile: there should be no way to name a different file to
// this module.
export const ENV_FILE_NAME = ".env";

export type EnvEntry = { key: string; value: string };

export type EnvFileState = {
  exists: boolean;
  content: string | null;
  hash: string | null;
  entries: EnvEntry[];
};

// A key as compose accepts it. Everything else is skipped when reading (the
// line still stays untouched when writing) and rejected when writing.
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function isValidEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

// --- Reading ----------------------------------------------------------------

// Split a line the way compose's own dotenv reader does:
//
//   * Blank lines and `#` lines are not an assignment.
//   * A leading `export ` is allowed.
//   * The split is at the FIRST `=`.
//   * `'…'` is literal, `"…"` knows escapes, unquoted the value ends at a
//     comment preceded by a space.
//
// null means "no assignment" — the line is ignored when reading and passed
// through unchanged when writing.
export function parseEnvLine(line: string): EnvEntry | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;

  const withoutExport = raw.startsWith("export ") ? raw.slice("export ".length).trim() : raw;
  const separator = withoutExport.indexOf("=");
  if (separator <= 0) return null;

  const key = withoutExport.slice(0, separator).trim();
  if (!isValidEnvKey(key)) return null;

  return { key, value: parseEnvValue(withoutExport.slice(separator + 1).trim()) };
}

function parseEnvValue(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\([nrt"\\])/g, (match, chars: string) =>
        chars === "n" ? "\n" : chars === "r" ? "\r" : chars === "t" ? "\t" : chars
      );
  }
  // Unquoted: a comment starts at ` #`. A `#` without a space before it
  // belongs to the value (passwords often contain it).
  const comment = raw.search(/\s#/);
  return (comment >= 0 ? raw.slice(0, comment) : raw).trim();
}

// With duplicate keys the LAST one wins — that is how dotenv behaves, and a
// list that claims otherwise would be worse than none.
export function parseEnvFile(content: string): EnvEntry[] {
  const found = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry) found.set(entry.key, entry.value);
  }
  return [...found].map(([key, value]) => ({ key, value }));
}

export function readEnvFile(projectDir: string): EnvFileState {
  try {
    const content = fs.readFileSync(path.join(projectDir, ENV_FILE_NAME), "utf8");
    return { exists: true, content, hash: hashOf(content), entries: parseEnvFile(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: null, hash: null, entries: [] };
    }
    throw error;
  }
}

// --- Writing ----------------------------------------------------------------

// Only what yields the same value again when read back may go without quotes.
// Everything else is double-quoted — better one quote too many than a value
// that silently changes on save.
const UNQUOTED_OK = /^[A-Za-z0-9_@%+=:,./-]*$/;

export function serializeEnvValue(value: string): string {
  if (UNQUOTED_OK.test(value)) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

export type EnvChange = {
  // Keys that are to be set or created.
  set: Record<string, string>;
  // Keys whose line disappears without replacement.
  remove: string[];
};

// The surgical part. Every line that is not an assignment to an affected key
// passes through unchanged — including comments, blank lines and `export`
// prefixes.
//
// Duplicate occurrences of the same key are ALL set to the new value. That is
// deliberate: dotenv takes the last one, so it does not change the meaning —
// but it also does not remove a line the operator may have put there on
// purpose.
export function applyEnvChanges(content: string, change: EnvChange): string {
  const remove = new Set(change.remove);
  const open = new Set(Object.keys(change.set));

  const lines = content.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const entry = parseEnvLine(line);
    if (!entry) {
      result.push(line);
      continue;
    }
    if (remove.has(entry.key)) continue;
    if (Object.prototype.hasOwnProperty.call(change.set, entry.key)) {
      const prefix = line.trimStart().startsWith("export ") ? "export " : "";
      result.push(`${prefix}${entry.key}=${serializeEnvValue(change.set[entry.key])}`);
      open.delete(entry.key);
      continue;
    }
    result.push(line);
  }

  // New keys appended at the end, in the order in which they came in.
  const updated = Object.keys(change.set).filter((key) => open.has(key));
  if (updated.length > 0) {
    // A file that does not end with a line break gets one — otherwise the
    // first new key gets appended to the last existing line.
    while (result.length > 0 && result[result.length - 1].trim() === "") result.pop();
    if (result.length > 0) result.push("");
    for (const key of updated) result.push(`${key}=${serializeEnvValue(change.set[key])}`);
  }

  const text = result.join("\n");
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

// Writes the `.env` with the same hash mechanics as the compose file.
//
// `expectedHash: null` means "there should be no file here yet" (create).
// There is deliberately no value for "don't care" — the same reasoning as in
// compose-store.ts.
export function writeEnvFile(
  projectDir: string,
  change: EnvChange,
  options: WriteOptions
): WriteResult {
  if (!isInsideBase(projectDir, options.basePath)) {
    throw new Error(`project directory lies outside ${options.basePath}`);
  }
  for (const key of [...Object.keys(change.set), ...change.remove]) {
    if (!isValidEnvKey(key)) throw new Error(`env key invalid: ${key}`);
  }

  const current = readEnvFile(projectDir);
  if (options.expectedHash === null) {
    if (current.exists) return { ok: false, reason: "file-already-exists", actualHash: current.hash };
  } else if (!current.exists || current.hash !== options.expectedHash) {
    return { ok: false, reason: "file-changed-externally", actualHash: current.hash };
  }

  const updated = applyEnvChanges(current.content ?? "", change);
  const filePath = path.join(projectDir, ENV_FILE_NAME);
  // 0o600 instead of the compose file's 0o664: this is where the secrets live.
  // Temporary file in the SAME directory — a rename across file system
  // boundaries would no longer be atomic.
  const temporary = `${filePath}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  try {
    fs.writeFileSync(descriptor, updated, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);

  return { ok: true, hash: hashOf(updated), previousContent: current.content };
}

// --- Origin per line (§16.2) ------------------------------------------------

// Where a value comes from. The distinction is the actual gain of the tab:
// `DB_PASSWORD` from the `.env` can be changed here, `PATH` from the image
// cannot, and what is hard-wired in the compose file belongs in the raw
// editor.
export type EnvOrigin = "env-file" | "compose" | "image";

export type EnvLineView = {
  key: string;
  origin: EnvOrigin;
  // Is the key in the `.env`? Only then can it be changed here.
  inFile: boolean;
  // Is it set in the running container? A `.env` entry that only serves
  // interpolation (`${VAR}`) is not — and that is a statement, not a
  // gap.
  inContainer: boolean;
  // Otherwise an empty value cannot be told apart from a masked one.
  empty: boolean;
  // ⚠️ Only set if plain text was explicitly requested (§16.4.5) AND the
  // line comes from the `.env`. The tab only edits those; what is fixed in
  // the compose file or comes from the image is never output here in plain
  // text, not even on request.
  value?: string;
};

// ⚠️ The `.env` next to a compose file is NOT automatically the environment
// of the container. Compose uses it for interpolating `${VAR}` in the YAML
// and — where `env_file` says so — additionally as a source of the container
// env. That is why two sets are merged here instead of outputting one: what
// is in the file, and what the container actually sees.
export function envView(input: {
  file: EnvEntry[];
  containerEnv: Array<{ key: string; value: string }>;
  imageEnv: Array<{ key: string; value: string }>;
  plaintext: boolean;
}): EnvLineView[] {
  const file = new Map(input.file.map((entry) => [entry.key, entry.value]));
  const container = new Map(input.containerEnv.map((entry) => [entry.key, entry.value]));
  const image = new Map(input.imageEnv.map((entry) => [entry.key, entry.value]));

  const keys = [...new Set([...file.keys(), ...container.keys()])].sort();

  return keys.map((key) => {
    const inFile = file.has(key);
    const inContainer = container.has(key);
    // The value the UI edits is always the one from the file — it is the
    // only place this tab writes. For a line that only exists in the
    // container it only serves the `empty` flag; it is not handed out (see
    // below).
    const value = inFile ? file.get(key)! : container.get(key)!;

    let origin: EnvOrigin;
    if (inFile && (!inContainer || container.get(key) === file.get(key))) {
      origin = "env-file";
    } else if (inContainer && image.get(key) === container.get(key)) {
      // Identical value to the image default: the container did not get it
      // set, it was already there.
      origin = "image";
    } else {
      // Set in the container, but neither image default nor identical to the
      // `.env` — then it is in the compose file (or was passed along with
      // `docker run`).
      origin = "compose";
    }

    return {
      key,
      origin,
      inFile: inFile,
      inContainer,
      empty: value.length === 0,
      // ⚠️ `inFile` deliberately stands here next to `plaintext`. Without it
      // the tab would hand out the FULL environment of the running container
      // in plain text — including values that are fixed in the compose file
      // or in an `env_file` elsewhere. That is not what the tab promises,
      // and none of it is editable here.
      ...(input.plaintext && inFile ? { value: value } : {})
    };
  });
}

// --- Redaction (§16.4, point 1) ---------------------------------------------

// ⚠️ The most important point from §16.4 and the reason why this module is
// built BEFORE the log stream (S6/§12.4).
//
// `redactKnownSecrets()` so far only knows the container env as a source. As
// soon as the agent reads the `.env`, its values have to be fed into the same
// redaction — otherwise a live log is the most convenient secret leak channel
// there is. That is exactly why `logs.view` is classified as `grant-required`.
//
// Deliberately WITHOUT a heuristic on the key names: whether `DB_PASSWORD` or
// `MEIN_WERT` — whatever is in the `.env` is removed from texts that leave the
// agent. An identifier redacted unnecessarily is a cosmetic flaw, a password
// that slipped through is not. The length threshold sits in
// redactKnownSecrets (values under 8 characters only produce random hits).
export class EnvRedactionUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("redaction-unavailable", options);
    this.name = "EnvRedactionUnavailableError";
  }
}

export function secretsFromEnvFile(
  projectDir: string,
  reader: (directory: string) => EnvFileState = readEnvFile
): string[] {
  let state: EnvFileState;
  try {
    // readEnvFile maps exclusively ENOENT to an empty state.
    // EACCES/EIO or any parser/read error must stop the log path: without a
    // reliable set of secrets, "carry on without redaction" would be fail-open.
    state = reader(projectDir);
  } catch (error) {
    throw new EnvRedactionUnavailableError({ cause: error });
  }
  return state.entries.map((entry) => entry.value).filter((value) => value.length > 0);
}
