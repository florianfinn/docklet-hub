import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { composeCandidates, ComposeSelectionStore } from "./compose-selection.js";

function fixture(run: (base: string, project: string, state: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-compose-selection-"));
  try {
    const base = path.join(root, "docker").replaceAll("\\", "/");
    const project = `${base}/fileflows`;
    fs.mkdirSync(project, { recursive: true });
    run(base, project, path.join(root, "state", "compose-selections.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("mehrere Label-Dateien werden einzeln angeboten und eine Auswahl überlebt den Neustart", () => {
  fixture((base, project, state) => {
    fs.writeFileSync(`${project}/compose.yaml`, "services: {}\n");
    fs.writeFileSync(`${project}/docker-compose.yml`, "services: {}\n");
    const labels = {
      "com.docker.compose.project.working_dir": project,
      "com.docker.compose.project.config_files": `${project}/compose.yaml,${project}/docker-compose.yml`,
      "com.docker.compose.project": "fileflows",
      "com.docker.compose.service": "worker"
    };
    const candidates = composeCandidates(labels, base);
    assert.deepEqual(candidates.map((candidate) => candidate.composeFileName), ["compose.yaml", "docker-compose.yml"]);
    assert.ok(candidates.every((candidate) => candidate.anchorReason === "compose-anchor-file-ambiguous"));
    const store = new ComposeSelectionStore(state);
    assert.equal(store.set("fileflows", `${project}/docker-compose.yml`, candidates), true);
    assert.equal(new ComposeSelectionStore(state).get("fileflows", candidates)?.composeFileName, "docker-compose.yml");
    fs.unlinkSync(`${project}/docker-compose.yml`);
    assert.equal(new ComposeSelectionStore(state).get("fileflows", composeCandidates(labels, base)), null);
  });
});

test("ein externer Labelpfad wird nur auf das gleich benannte Basisprojekt abgebildet", () => {
  fixture((base, project) => {
    fs.writeFileSync(`${project}/docker-compose.yml`, "services: {}\n");
    const outside = `/mnt/user/docker/fileflows`;
    const labels = {
      "com.docker.compose.project.working_dir": outside,
      "com.docker.compose.project.config_files": `${outside}/docker-compose.yml`,
      "com.docker.compose.project": "fileflows",
      "com.docker.compose.service": "worker"
    };
    const candidates = composeCandidates(labels, base);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].filePath, `${project}/docker-compose.yml`);
    assert.equal(candidates[0].anchorReason, "compose-anchor-outside-base-path");
    assert.deepEqual(composeCandidates({ ...labels,
      "com.docker.compose.project.working_dir": "/mnt/user/other/fileflows" }, base), []);
  });
});

test("freie Pfade, Traversal und Symlinks außerhalb der Basis werden abgelehnt", () => {
  fixture((base, project, state) => {
    const outsider = path.join(path.dirname(base), "outsider.yaml");
    fs.writeFileSync(outsider, "services: {}\n");
    fs.writeFileSync(`${project}/compose.yaml`, "services: {}\n");
    const labels = {
      "com.docker.compose.project.working_dir": project,
      "com.docker.compose.project.config_files": `${project}/../outsider.yaml`,
      "com.docker.compose.project": "fileflows",
      "com.docker.compose.service": "worker"
    };
    const candidates = composeCandidates(labels, base);
    const store = new ComposeSelectionStore(state);
    assert.equal(store.set("fileflows", outsider, candidates), false);
    assert.equal(candidates.length, 1);
    try {
      fs.symlinkSync(outsider, `${project}/docker-compose.yml`);
      assert.deepEqual(composeCandidates(labels, base).map((candidate) => candidate.composeFileName), ["compose.yaml"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });
});
