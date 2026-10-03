import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isValidComposeFileName } from "./compose.js";
import { removeEmptyProjectDir } from "./compose-store.js";
import { CANDIDATE_FILE_NAME } from "./compose-raw.js";
import { checkLogPath } from "./log-file.js";
import {
  isHubOwnedProject,
  PROJECT_MARKER_FILE_NAME,
  removeProjectMarker,
  writeProjectMarker
} from "./project-marker.js";
import { checkEntryPath, checkName, isBlockedName } from "./webftp.js";

// Joined with "/" like the other file tests: normalizePath is pure posix.
function tempProject(name = "notes"): { base: string; project: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "project-marker-"));
  const project = `${base}/${name}`;
  fs.mkdirSync(project);
  return { base, project };
}

test("a written marker proves ownership of exactly its directory", () => {
  const { base, project } = tempProject();
  assert.equal(isHubOwnedProject(project, base), false);
  writeProjectMarker(project, base, new Date("2026-10-03T12:00:00.000Z"));
  assert.equal(isHubOwnedProject(project, base), true);

  const marker = JSON.parse(fs.readFileSync(`${project}/${PROJECT_MARKER_FILE_NAME}`, "utf8")) as Record<string, unknown>;
  assert.deepEqual(marker, {
    kind: "docklet-hub-project",
    version: 1,
    projectName: "notes",
    createdAt: "2026-10-03T12:00:00.000Z"
  });

  removeProjectMarker(project, base);
  assert.equal(isHubOwnedProject(project, base), false);
});

test("an existing marker is never overwritten", () => {
  const { base, project } = tempProject();
  writeProjectMarker(project, base);
  assert.throws(() => writeProjectMarker(project, base), /EEXIST/);
});

test("a marker copied from another project does not claim ownership", () => {
  const { base, project } = tempProject("notes");
  const other = `${base}/wiki`;
  fs.mkdirSync(other);
  writeProjectMarker(project, base);
  fs.copyFileSync(`${project}/${PROJECT_MARKER_FILE_NAME}`, `${other}/${PROJECT_MARKER_FILE_NAME}`);
  assert.equal(isHubOwnedProject(other, base), false);
});

test("unreadable, foreign or oversized markers count as not hub-owned", () => {
  const { base, project } = tempProject();
  const marker = `${project}/${PROJECT_MARKER_FILE_NAME}`;
  fs.writeFileSync(marker, "not json");
  assert.equal(isHubOwnedProject(project, base), false);
  fs.writeFileSync(marker, JSON.stringify({ kind: "other", version: 1, projectName: "notes" }));
  assert.equal(isHubOwnedProject(project, base), false);
  fs.writeFileSync(marker, JSON.stringify({ kind: "docklet-hub-project", version: 1, projectName: "notes", pad: "x".repeat(5000) }));
  assert.equal(isHubOwnedProject(project, base), false);
  fs.rmSync(marker);
  fs.mkdirSync(marker);
  assert.equal(isHubOwnedProject(project, base), false);
});

test("a marker outside the base path is neither read nor written", () => {
  const { base } = tempProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "project-marker-outside-"));
  assert.throws(() => writeProjectMarker(outside, base), /outside/);
  assert.equal(isHubOwnedProject(outside, base), false);
  assert.equal(fs.existsSync(path.join(outside, PROJECT_MARKER_FILE_NAME)), false);
});

test("a symlinked marker does not claim ownership", (t) => {
  const { base, project } = tempProject();
  const elsewhere = `${base}/elsewhere.json`;
  fs.writeFileSync(elsewhere, JSON.stringify({ kind: "docklet-hub-project", version: 1, projectName: "notes", createdAt: "x" }));
  try {
    fs.symlinkSync(elsewhere, `${project}/${PROJECT_MARKER_FILE_NAME}`);
  } catch {
    t.skip("symlinks are not available here");
    return;
  }
  assert.equal(isHubOwnedProject(project, base), false);
});

test("file, log and compose routes refuse the marker by name", () => {
  assert.equal(isBlockedName(PROJECT_MARKER_FILE_NAME), true);
  assert.deepEqual(checkName(PROJECT_MARKER_FILE_NAME), { ok: false, reason: "path-blocked" });
  assert.deepEqual(checkEntryPath(`data/${PROJECT_MARKER_FILE_NAME}`, "/home/docker/notes/share"), {
    ok: false,
    reason: "path-blocked"
  });
  assert.equal(checkLogPath(PROJECT_MARKER_FILE_NAME, "/home/docker/notes").ok, false);
  assert.equal(isValidComposeFileName(PROJECT_MARKER_FILE_NAME), false);
});

test("cleanup removes empty directories and the draft, but keeps data", () => {
  const { base, project } = tempProject();
  fs.mkdirSync(`${project}/data/cache`, { recursive: true });
  fs.mkdirSync(`${project}/config`);
  fs.writeFileSync(`${project}/${CANDIDATE_FILE_NAME}`, "services: {}");
  fs.writeFileSync(`${project}/config/app.ini`, "kept");

  assert.equal(removeEmptyProjectDir(project, base), false);
  assert.equal(fs.existsSync(`${project}/data`), false);
  assert.equal(fs.existsSync(`${project}/${CANDIDATE_FILE_NAME}`), false);
  assert.equal(fs.readFileSync(`${project}/config/app.ini`, "utf8"), "kept");

  fs.rmSync(`${project}/config`, { recursive: true });
  assert.equal(removeEmptyProjectDir(project, base), true);
  assert.equal(fs.existsSync(project), false);
  assert.equal(removeEmptyProjectDir(project, base), true);
});

test("cleanup never follows a symlinked directory", (t) => {
  const { base, project } = tempProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "project-marker-target-"));
  fs.mkdirSync(path.join(outside, "empty"));
  try {
    fs.symlinkSync(outside, `${project}/link`, "dir");
  } catch {
    t.skip("symlinks are not available here");
    return;
  }
  assert.equal(removeEmptyProjectDir(project, base), false);
  assert.equal(fs.existsSync(path.join(outside, "empty")), true);
});

test("cleanup refuses a directory outside the base path", () => {
  const { base } = tempProject();
  assert.throws(() => removeEmptyProjectDir("/elsewhere/notes", base), /outside/);
});
