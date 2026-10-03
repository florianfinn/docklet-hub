// File side of compose management (stage 5c).
//
// Two guarantees this module gives:
//
//  1. **Nothing is ever overwritten blindly.** Dashboard and SSH users edit
//     the same file (open point 4 from 6.2). Before every write, the hash of
//     the actual state is checked against the expected one. If it differs,
//     the write is rejected — the manual change is then visible instead of
//     silently gone. Exactly the class of error for which 5b rejected
//     compose-managed containers in the first place.
//
//  2. **Nothing is ever written outside the base path.** The path is not
//     accepted from outside but derived from the container name
//     (compose.ts/locationFor) and checked here once more.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  COMPOSE_FILE_NAME,
  isInsideBase,
  isValidComposeFileName,
  UPDATE_ROLLBACK_OVERRIDE_FILE_NAME
} from "./compose.js";
import { CANDIDATE_FILE_NAME } from "./compose-raw.js";

export { UPDATE_ROLLBACK_OVERRIDE_FILE_NAME } from "./compose.js";

export function hashOf(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export type ComposeFileState = {
  exists: boolean;
  content: string | null;
  hash: string | null;
};

// The file name is a parameter because adopted stacks choose it freely
// (compose.yaml, docker-compose.yml, docker-compose.yaml all occur among the
// existing stacks). The default applies to everything the dashboard wrote itself.
export function readComposeFile(
  projectDir: string,
  composeFileName: string = COMPOSE_FILE_NAME
): ComposeFileState {
  try {
    const content = fs.readFileSync(path.join(projectDir, composeFileName), "utf8");
    return { exists: true, content, hash: hashOf(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: null, hash: null };
    }
    throw error;
  }
}

// Occupancy check on creation (6.2): if the directory already exists, the
// request is rejected. This is the alternative to random ids in the path — it
// solves the same collision question without sacrificing the readable,
// backup-friendly path that the whole directional decision is about.
export function directoryOccupied(projectDir: string): boolean {
  try {
    return fs.readdirSync(projectDir).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Create bind directories with the agent UID before Docker creates root-owned
// sources. Non-root application processes must be able to write their data.
export function ensureProjectDir(projectDir: string, basePath: string): void {
  if (!isInsideBase(projectDir, basePath)) {
    throw new Error(`project directory lies outside ${basePath}`);
  }
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o775 });
}

// And the same for the bind sources (6.3.2, the actual core of the gap).
//
// If a bind source is not created, the Docker daemon creates it — as
// root:root. A container running as non-root then cannot write into its OWN
// data directory. Precreating sources avoids that ownership mismatch.
//
// Creation happens exclusively below the base path; spec validation has
// already rejected everything else anyway, but that is not relied upon.
// Existing directories stay untouched — in particular, NO chown is done on
// anything that already belongs to someone.
export function ensureBindSources(sources: string[], basePath: string): void {
  for (const source of sources) {
    if (!isInsideBase(source, basePath)) continue;
    if (fs.existsSync(source)) continue;
    fs.mkdirSync(source, { recursive: true, mode: 0o775 });
  }
}

// --- Discovery (stage 5d) ---------------------------------------------------

// The three file names that compose itself accepts as a project file. All
// three occur among the existing stacks.
const KNOWN_COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export function hasComposeFile(projectDir: string, composeFileName: string): boolean {
  try {
    return fs.statSync(path.join(projectDir, composeFileName)).isFile();
  } catch {
    return false;
  }
}

// All directories directly below the base path that contain a compose file.
// Only ONE level deep: the base path is the level on which a project lives, and
// a recursive walk would end up in the containers' data (which may also contain
// compose files without being any).
export function directoriesWithComposeFile(basePath: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(basePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const match: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.posix.join(basePath, entry.name);
    if (KNOWN_COMPOSE_FILES.some((name) => hasComposeFile(dir, name))) match.push(dir);
  }
  return match;
}

export type WriteResult =
  | { ok: true; hash: string; previousContent: string | null }
  | { ok: false; reason: "file-changed-externally" | "file-already-exists"; actualHash: string | null };

export type WriteOptions = {
  // The hash the caller saw last.
  //   null  = "there should be no file here yet" (create)
  //   hash  = "the file should look exactly as last read" (edit)
  //
  // There is deliberately NO value for "don't care". An overwrite without
  // reference to the read state is exactly what must not happen here.
  expectedHash: string | null;
  basePath: string;
};

// ⚠️ There is deliberately NO file name parameter (unlike for reading).
//
// Writes go exclusively to files the dashboard created itself, and those are
// always called COMPOSE_FILE_NAME. Adopted files belong to the operator and are
// never written (stage 5d) — the survey showed that none of the existing files
// would have survived a regeneration. They are edited in the raw editor
// (stage 7).
//
// The missing parameter is the enforcement of this guarantee: there is simply
// no way to name a foreign file to this function.
export function writeComposeFile(
  projectDir: string,
  content: string,
  options: WriteOptions
): WriteResult {
  if (!isInsideBase(projectDir, options.basePath)) {
    throw new Error(`project directory lies outside ${options.basePath}`);
  }

  const current = readComposeFile(projectDir);
  if (options.expectedHash === null) {
    if (current.exists) return { ok: false, reason: "file-already-exists", actualHash: current.hash };
  } else if (!current.exists || current.hash !== options.expectedHash) {
    return { ok: false, reason: "file-changed-externally", actualHash: current.hash };
  }

  writeAtomic(path.join(projectDir, COMPOSE_FILE_NAME), content);
  return { ok: true, hash: hashOf(content), previousContent: current.content };
}

// --- Raw editor (stage 7) ---------------------------------------------------

// ⚠️ This function has the file name parameter that writeComposeFile
// explicitly does NOT have. That is not a softening of the 5d guarantee but its
// refinement — and it is the reason why it stands here as a SEPARATE function
// instead of as a flag on the existing one.
//
// The 5d rule is: an adopted file is never REGENERATED from the spec. The
// survey showed why — of seven existing files none would have survived it:
// hostname, dns, healthcheck, long-form ports and all comments would have been
// lost, and for foundryvtt a password from the .env would have moved into the
// YAML in plain text. The loss came from the TRANSLATION, not from the writing.
//
// The raw editor translates nothing. It stores text that the operator wrote
// themselves and saw in a diff. There is nothing here that could drop out
// unnoticed.
//
// A separate function, so that the spec path structurally still cannot reach
// the foreign file: writeComposeFile stays without the parameter, and whoever
// wants to write an adopted file has to choose this one explicitly.
export function writeRawComposeFile(
  projectDir: string,
  composeFileName: string,
  content: string,
  options: WriteOptions
): WriteResult {
  if (!isInsideBase(projectDir, options.basePath)) {
    throw new Error(`project directory lies outside ${options.basePath}`);
  }
  // The file name is checked here too and not only at the route: a value
  // containing "/" or ".." would, when joined, yield a path outside the
  // project directory.
  if (!isValidComposeFileName(composeFileName)) {
    throw new Error(`compose file name invalid: ${composeFileName}`);
  }

  const current = readComposeFile(projectDir, composeFileName);
  if (options.expectedHash === null) {
    if (current.exists) return { ok: false, reason: "file-already-exists", actualHash: current.hash };
  } else if (!current.exists || current.hash !== options.expectedHash) {
    return { ok: false, reason: "file-changed-externally", actualHash: current.hash };
  }

  writeAtomic(path.join(projectDir, composeFileName), content);
  return { ok: true, hash: hashOf(content), previousContent: current.content };
}

export function restoreRawComposeFile(
  projectDir: string,
  composeFileName: string,
  previousContent: string | null
): void {
  if (!isValidComposeFileName(composeFileName)) {
    throw new Error(`compose file name invalid: ${composeFileName}`);
  }
  const filePath = path.join(projectDir, composeFileName);
  if (previousContent === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  writeAtomic(filePath, previousContent);
}

// A draft is put down for CHECKING before anything real is written:
// `docker compose config` is the only parser trusted here (compose.ts), and it
// reads from disk.
//
// The candidate deliberately carries none of the names that compose itself
// accepts as a project file — otherwise a leftover draft would be a stack of its
// own for the stack discovery from 5d, and a manual `docker compose up` could
// pick it up.
export function writeCandidateFile(projectDir: string, content: string, basePath: string): string {
  if (!isInsideBase(projectDir, basePath)) {
    throw new Error(`project directory lies outside ${basePath}`);
  }
  const filePath = path.join(projectDir, CANDIDATE_FILE_NAME);
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export function removeCandidateFile(projectDir: string): void {
  fs.rmSync(path.join(projectDir, CANDIDATE_FILE_NAME), { force: true });
}

// The content is JSON, because JSON is a valid subset of YAML. That way the
// agent needs no second YAML emitter, and even unusual service names stay
// pure data instead of structure thanks to JSON.stringify.
export function writeUpdateRollbackOverride(
  projectDir: string,
  serviceName: string,
  imageId: string,
  basePath: string
): string {
  if (!isInsideBase(projectDir, basePath)) {
    throw new Error(`project directory lies outside ${basePath}`);
  }
  if (!serviceName) throw new Error("compose service for rollback missing");
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
    throw new Error("previous image id for rollback is invalid");
  }

  const filePath = path.join(projectDir, UPDATE_ROLLBACK_OVERRIDE_FILE_NAME);
  const content = `${JSON.stringify({ services: { [serviceName]: { image: imageId } } }, null, 2)}\n`;
  writeAtomic(filePath, content, 0o600);
  return filePath;
}

export function removeUpdateRollbackOverride(projectDir: string, basePath: string): void {
  if (!isInsideBase(projectDir, basePath)) {
    throw new Error(`project directory lies outside ${basePath}`);
  }
  const filePath = path.join(projectDir, UPDATE_ROLLBACK_OVERRIDE_FILE_NAME);
  // A temporary file left behind by the atomic write is also part of the
  // cleanup guarantee. Both names are constants below the checked project
  // directory; no request can determine a delete path here.
  fs.rmSync(filePath, { force: true });
  fs.rmSync(`${filePath}.tmp`, { force: true });
}

// Restore after a failed `up`. Deliberately WITHOUT a hash check: the caller
// has just written itself and is rolling back its own step.
//
// That the previous version CAN be written back at all is the quiet gain of
// this stage: in 5a the old container had to be renamed and kept, because the
// definition only existed in memory. Now it is on disk — rolling back means
// writing the old file back and calling `up` once more.
export function restoreComposeFile(projectDir: string, previousContent: string | null): void {
  const filePath = path.join(projectDir, COMPOSE_FILE_NAME);
  if (previousContent === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  writeAtomic(filePath, previousContent);
}

function writeAtomic(filePath: string, content: string, mode = 0o664): void {
  // Temporary file in the SAME directory: a rename across file system
  // boundaries is no longer an atomic operation.
  const temporary = `${filePath}.tmp`;
  // The project content can be mounted into a container and be writable
  // there. A symlink placed beforehand at the known temporary file must
  // therefore never get the privileged agent to write outside the project.
  // O_CREAT|O_EXCL rejects both a regular existing file and a symlink,
  // failing closed.
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode
  );
  try {
    fs.writeFileSync(descriptor, content, { encoding: "utf8" });
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}
