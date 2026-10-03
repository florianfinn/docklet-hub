import assert from "node:assert/strict";
import test from "node:test";
import { rawComposeLocation } from "./raw-compose-location.js";

const base = "/mnt/cache/docker";
const labels = {
  "com.docker.compose.project.working_dir": "/mnt/user/docker/fileflows",
  "com.docker.compose.project.config_files": "/mnt/user/docker/fileflows/docker-compose.yml",
  "com.docker.compose.project": "fileflows",
  "com.docker.compose.service": "worker"
};

test("a rejected label anchor reports its reason and path before the name fallback", () => {
  const result = rawComposeLocation("fileflows", undefined, labels, null, base, () => true);
  assert.deepEqual(result, {
    ok: false,
    reason: "compose-anchor-outside-base-path",
    projectDir: "/mnt/user/docker/fileflows"
  });
});

test("a manual selection takes precedence and uses the project name from the label", () => {
  const result = rawComposeLocation("fileflows", undefined, labels, {
    projectDir: "/mnt/cache/docker/fileflows",
    composeFileName: "docker-compose.yml",
    project: "fileflows",
    serviceName: "worker"
  }, base, () => true);
  assert.deepEqual(result, { ok: true, location: {
    projectDir: "/mnt/cache/docker/fileflows",
    composeFileName: "docker-compose.yml",
    projectName: "fileflows"
  } });
});

test("without compose labels the name fallback finds docker-compose.yml", () => {
  const result = rawComposeLocation("fileflows", undefined, undefined, null, base,
    (_dir, name) => name === "docker-compose.yml");
  assert.deepEqual(result, { ok: true, location: {
    projectDir: "/mnt/cache/docker/fileflows",
    composeFileName: "docker-compose.yml",
    projectName: "fileflows"
  } });
});

test("an ambiguous label anchor also hides a stored registry anchor", () => {
  const ambiguous = { ...labels,
    "com.docker.compose.project.working_dir": "/mnt/cache/docker/fileflows",
    "com.docker.compose.project.config_files": "/mnt/cache/docker/fileflows/compose.yaml,/mnt/cache/docker/fileflows/compose.override.yaml"
  };
  const registry = { projectDir: "/mnt/cache/docker/fileflows", projectName: "fileflows",
    serviceName: "worker", composeFileName: "compose.yaml", origin: "adopted" as const };
  assert.deepEqual(rawComposeLocation("fileflows", registry, ambiguous, null, base, () => true), {
    ok: false, reason: "compose-anchor-file-ambiguous", projectDir: "/mnt/cache/docker/fileflows"
  });
});
