// The marker that proves on the host that the hub created a project (#128).
// The agent writes it once after a successful create and only reads it
// afterwards; no file, compose or log route may touch it.

import fs from "node:fs";
import path from "node:path";
import { isInsideBase, PROJECT_MARKER_FILE_NAME } from "./compose.js";
import { normalizePath } from "./hardening.js";

export { PROJECT_MARKER_FILE_NAME } from "./compose.js";

const MARKER_KIND = "docklet-hub-project";
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 4096;

type ProjectMarker = {
  kind: typeof MARKER_KIND;
  version: typeof MARKER_VERSION;
  projectName: string;
  createdAt: string;
};

function markerPathOf(projectDir: string, basePath: string): string {
  if (!isInsideBase(projectDir, basePath)) {
    throw new Error(`project directory lies outside ${basePath}`);
  }
  return path.join(normalizePath(projectDir), PROJECT_MARKER_FILE_NAME);
}

// O_EXCL refuses an existing file and a planted symlink alike.
export function writeProjectMarker(projectDir: string, basePath: string, now = new Date()): void {
  const marker: ProjectMarker = {
    kind: MARKER_KIND,
    version: MARKER_VERSION,
    projectName: path.basename(normalizePath(projectDir)),
    createdAt: now.toISOString()
  };
  const descriptor = fs.openSync(
    markerPathOf(projectDir, basePath),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o644
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(marker)}\n`, { encoding: "utf8" });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function removeProjectMarker(projectDir: string, basePath: string): void {
  fs.rmSync(markerPathOf(projectDir, basePath), { force: true });
}

// Ownership can only be claimed by a regular file whose name binding matches
// the directory; anything unreadable counts as not hub-owned.
export function isHubOwnedProject(projectDir: string, basePath: string): boolean {
  let markerPath: string;
  try {
    markerPath = markerPathOf(projectDir, basePath);
  } catch {
    return false;
  }
  const noFollow = process.platform === "linux" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    if (fs.lstatSync(markerPath).isSymbolicLink()) return false;
    descriptor = fs.openSync(markerPath, fs.constants.O_RDONLY | noFollow);
  } catch {
    return false;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return false;
    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8")) as Partial<ProjectMarker>;
    return (
      parsed.kind === MARKER_KIND &&
      parsed.version === MARKER_VERSION &&
      parsed.projectName === path.basename(normalizePath(projectDir))
    );
  } catch {
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}
