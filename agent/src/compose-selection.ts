import fs from "node:fs";
import path from "node:path";
import { composeContextFindingOf, isInsideBase, isValidProjectName, type ComposeContextReason } from "./compose.js";
import { normalizePath } from "./hardening.js";

export const COMPOSE_CANDIDATE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"] as const;

export type ComposeCandidate = {
  filePath: string;
  projectDir: string;
  composeFileName: string;
  source: "label" | "base";
  anchorReason: ComposeContextReason | null;
};

function safeFile(filePath: string, basePath: string): boolean {
  try {
    if (fs.lstatSync(path.dirname(filePath)).isSymbolicLink() || fs.lstatSync(filePath).isSymbolicLink()) return false;
    const realBase = fs.realpathSync(basePath);
    const realFile = fs.realpathSync(filePath);
    const relative = path.relative(realBase, realFile);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".."
      && !path.isAbsolute(relative) && fs.statSync(realFile).isFile();
  } catch {
    return false;
  }
}

function projectDirectory(labels: Record<string, string> | undefined, basePath: string): string | null {
  const raw = labels?.["com.docker.compose.project.working_dir"];
  if (!raw || !(path.isAbsolute(raw) || path.posix.isAbsolute(raw)) || normalizePath(raw) !== raw) return null;
  const base = normalizePath(basePath);
  const projectName = path.posix.basename(raw);
  if (!isValidProjectName(projectName)) return null;
  if (isInsideBase(raw, base)) {
    return path.posix.dirname(raw) === base ? raw : null;
  }
  // Unraid zeigt dieselbe Projektdatei etwa unter /mnt/user/docker/X und
  // /mnt/cache/docker/X. Nur das direkte Projekt unter dem gleich benannten
  // Basisverzeichnis darf auf die lokale Sicht abgebildet werden.
  if (path.posix.basename(path.posix.dirname(raw)) !== path.posix.basename(base)) return null;
  return `${base}/${projectName}`;
}

export function composeCandidates(
  labels: Record<string, string> | undefined,
  basePath: string
): ComposeCandidate[] {
  const projectDir = projectDirectory(labels, basePath);
  if (!projectDir) return [];
  const finding = composeContextFindingOf(labels, basePath);
  const reason = finding.ok ? null : finding.reason;
  const candidates = new Map<string, ComposeCandidate>();
  const add = (fileName: string, source: ComposeCandidate["source"]): void => {
    if (!COMPOSE_CANDIDATE_NAMES.some((known) => known === fileName)) return;
    const filePath = `${projectDir}/${fileName}`;
    if (!safeFile(filePath, basePath)) return;
    if (!candidates.has(filePath)) {
      candidates.set(filePath, { filePath, projectDir, composeFileName: fileName, source, anchorReason: reason });
    }
  };

  const rawFiles = labels?.["com.docker.compose.project.config_files"] ?? "";
  for (const rawFile of rawFiles.split(",")) {
    const file = rawFile.trim();
    if (!file || !(path.isAbsolute(file) || path.posix.isAbsolute(file)) || normalizePath(file) !== file) continue;
    if (path.posix.dirname(file) !== labels?.["com.docker.compose.project.working_dir"]) continue;
    add(path.posix.basename(file), "label");
  }
  for (const name of COMPOSE_CANDIDATE_NAMES) add(name, "base");
  return [...candidates.values()];
}

export class ComposeSelectionStore {
  private selections = new Map<string, string>();

  constructor(private readonly filePath: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid selection file");
      for (const [name, file] of Object.entries(parsed)) {
        if (isValidProjectName(name) && typeof file === "string") this.selections.set(name, file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[compose-selection] state unreadable, continuing without selections:", error);
      }
    }
  }

  get(containerName: string, candidates: readonly ComposeCandidate[]): ComposeCandidate | null {
    const selected = this.selections.get(containerName);
    return candidates.find((candidate) => candidate.filePath === selected) ?? null;
  }

  set(containerName: string, filePath: string, candidates: readonly ComposeCandidate[]): boolean {
    if (!isValidProjectName(containerName) || !candidates.some((candidate) => candidate.filePath === filePath)) return false;
    const previous = this.selections.get(containerName);
    this.selections.set(containerName, filePath);
    try {
      this.persist();
    } catch (error) {
      if (previous === undefined) this.selections.delete(containerName);
      else this.selections.set(containerName, previous);
      throw error;
    }
    return true;
  }

  clear(containerName: string): boolean {
    const previous = this.selections.get(containerName);
    if (previous === undefined) return false;
    this.selections.delete(containerName);
    try {
      this.persist();
    } catch (error) {
      this.selections.set(containerName, previous);
      throw error;
    }
    return true;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(Object.fromEntries(this.selections), null, 2), "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.filePath);
  }
}
