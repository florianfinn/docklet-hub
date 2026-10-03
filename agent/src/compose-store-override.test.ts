import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  removeUpdateRollbackOverride,
  UPDATE_ROLLBACK_OVERRIDE_FILE_NAME,
  writeUpdateRollbackOverride
} from "./compose-store.js";

const IMAGE = `sha256:${"a".repeat(64)}`;

function sandbox(): { base: string; project: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-s12-"));
  // Produktionspfade des Agents sind POSIX-Pfade. Der explizite Slash haelt
  // denselben Vertrag auch dann fest, wenn die Tests unter Windows laufen.
  const project = `${base}/stack`;
  fs.mkdirSync(project);
  return { base, project };
}

test("Rollback-Override ist JSON/YAML, pinnt nur den Zielservice und ist nicht Compose-Standard", () => {
  const { base, project } = sandbox();
  const file = writeUpdateRollbackOverride(project, "web:sonderbar", IMAGE, base);

  assert.equal(path.basename(file), UPDATE_ROLLBACK_OVERRIDE_FILE_NAME);
  assert.equal(["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].includes(path.basename(file)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    services: { "web:sonderbar": { image: IMAGE } }
  });
});

test("Override und atomare Temporaerdatei werden gemeinsam entfernt", () => {
  const { base, project } = sandbox();
  const file = writeUpdateRollbackOverride(project, "web", IMAGE, base);
  fs.writeFileSync(`${file}.tmp`, "rest");

  removeUpdateRollbackOverride(project, base);

  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("eine vorab angelegte Temporaerdatei wird nie ueberschrieben", () => {
  const { base, project } = sandbox();
  const file = path.join(project, UPDATE_ROLLBACK_OVERRIDE_FILE_NAME);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, "fremder-inhalt");

  assert.throws(() => writeUpdateRollbackOverride(project, "web", IMAGE, base));
  assert.equal(fs.readFileSync(temporary, "utf8"), "fremder-inhalt");
  assert.equal(fs.existsSync(file), false);

  removeUpdateRollbackOverride(project, base);
  assert.equal(fs.existsSync(temporary), false);
});

test("weder Schreiben noch Entfernen darf den Compose-Basispfad verlassen", () => {
  const { base } = sandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-s12-outside-"));

  assert.throws(() => writeUpdateRollbackOverride(outside, "web", IMAGE, base), /lies outside/);
  assert.throws(() => removeUpdateRollbackOverride(outside, base), /lies outside/);
});

test("nur eine echte lokale sha256-Image-Id kann gepinnt werden", () => {
  const { base, project } = sandbox();
  assert.throws(
    () => writeUpdateRollbackOverride(project, "web", "latest\nservices:\n  boese:", base),
    /invalid/
  );
});
