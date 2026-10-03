import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeEmptyProjectDir } from "./compose-store.js";
import { CANDIDATE_FILE_NAME } from "./compose-raw.js";

// Joined with "/" like the other file tests: normalizePath is pure posix.
function tempProject(name = "notes"): { base: string; project: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "project-cleanup-"));
  const project = `${base}/${name}`;
  fs.mkdirSync(project);
  return { base, project };
}

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
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "project-cleanup-target-"));
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
