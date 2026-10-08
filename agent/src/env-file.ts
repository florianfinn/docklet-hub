import { MAX_COMPOSE_BYTES } from "contract";

import fs from "node:fs";
import path from "node:path";
import { isInsideBase } from "./compose.js";
import { hashOf, type WriteOptions, type WriteResult } from "./compose-store.js";

export const ENV_FILE_NAME = ".env";

export type EnvEntry = { key: string; value: string };

export type EnvFileState = {
  exists: boolean;
  content: string | null;
  hash: string | null;
  entries: EnvEntry[];
};

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function isValidEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}


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
  const comment = raw.search(/\s#/);
  return (comment >= 0 ? raw.slice(0, comment) : raw).trim();
}

export function parseEnvFile(content: string): EnvEntry[] {
  const found = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry) found.set(entry.key, entry.value);
  }
  return [...found].map(([key, value]) => ({ key, value }));
}

function pinnedDirectory(projectDir: string): { descriptor: number; root: string } {
  const descriptor = fs.openSync(projectDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const root = process.platform === "linux" ? `/proc/self/fd/${descriptor}` : projectDir;
    if (fs.realpathSync(root) !== path.resolve(projectDir)) throw new Error("path-outside");
    return { descriptor, root };
  } catch (error) { fs.closeSync(descriptor); throw error; }
}
export function readEnvFile(projectDir: string): EnvFileState {
  let directory;
  try { directory = pinnedDirectory(projectDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, content: null, hash: null, entries: [] };
    throw error;
  }
  try { return readEnvPath(path.join(directory.root, ENV_FILE_NAME)); }
  finally { fs.closeSync(directory.descriptor); }
}
function readEnvPath(filePath: string): EnvFileState {

  try {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("not-a-text-file");
      if (stat.size > MAX_COMPOSE_BYTES) throw new Error("too-large");
      bytes = Buffer.alloc(MAX_COMPOSE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      bytes = bytes.subarray(0, length);
    } finally { fs.closeSync(descriptor); }
    if (bytes.length > MAX_COMPOSE_BYTES) throw new Error("too-large");
    const content = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(content).equals(bytes)) throw new Error("not-a-text-file");
    return { exists: true, content, hash: hashOf(content), entries: parseEnvFile(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: null, hash: null, entries: [] };
    }
    throw error;
  }
}


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
  set: Record<string, string>;
  remove: string[];
};

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

  const updated = Object.keys(change.set).filter((key) => open.has(key));
  if (updated.length > 0) {
    while (result.length > 0 && result[result.length - 1].trim() === "") result.pop();
    if (result.length > 0) result.push("");
    for (const key of updated) result.push(`${key}=${serializeEnvValue(change.set[key])}`);
  }

  const text = result.join("\n");
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

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

  const directory = pinnedDirectory(projectDir);
  try {
  const filePath = path.join(directory.root, ENV_FILE_NAME);
  const current = readEnvPath(filePath);
  if (options.expectedHash === null) {
    if (current.exists) return { ok: false, reason: "file-already-exists", actualHash: current.hash };
  } else if (!current.exists || current.hash !== options.expectedHash) {
    return { ok: false, reason: "file-changed-externally", actualHash: current.hash };
  }

  const updated = applyEnvChanges(current.content ?? "", change);
  if (updated.includes("\0") || Buffer.from(updated).toString("utf8") !== updated) throw new Error("not-a-text-file");
  if (Buffer.byteLength(updated) > MAX_COMPOSE_BYTES) throw new Error("too-large");
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
  } finally { fs.closeSync(directory.descriptor); }
}


export type EnvOrigin = "env-file" | "compose" | "image";

export type EnvLineView = {
  key: string;
  origin: EnvOrigin;
  inFile: boolean;
  inContainer: boolean;
  empty: boolean;
  value?: string;
};

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
    const value = inFile ? file.get(key)! : container.get(key)!;

    let origin: EnvOrigin;
    if (inFile && (!inContainer || container.get(key) === file.get(key))) {
      origin = "env-file";
    } else if (inContainer && image.get(key) === container.get(key)) {
      origin = "image";
    } else {
      origin = "compose";
    }

    return {
      key,
      origin,
      inFile: inFile,
      inContainer,
      empty: value.length === 0,
      ...(input.plaintext && inFile ? { value: value } : {})
    };
  });
}


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
    state = reader(projectDir);
  } catch (error) {
    throw new EnvRedactionUnavailableError({ cause: error });
  }
  return state.entries.map((entry) => entry.value).filter((value) => value.length > 0);
}
