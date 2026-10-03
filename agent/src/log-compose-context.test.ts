import assert from "node:assert/strict";
import test from "node:test";
import { EnvRedactionUnavailableError } from "./env-file.js";
import {
  requiredComposeContextForFileLogs,
  verifiedComposeContextForLogs
} from "./log-compose-context.js";
import type { RegistryEntry } from "./registry.js";

const BASE = "/home/docker";
const ENTRY: RegistryEntry = {
  containerId: "abc",
  containerName: "web",
  imageRef: "example/web:1",
  allowed: true,
  secured: true,
  compose: {
    projectDir: "/home/docker/site",
    projectName: "site",
    serviceName: "web",
    composeFileName: "compose.yaml",
    origin: "adopted"
  }
};
const LABELS = {
  "com.docker.compose.project.working_dir": "/home/docker/site",
  "com.docker.compose.project": "site",
  "com.docker.compose.service": "web",
  "com.docker.compose.project.config_files": "/home/docker/site/compose.yaml"
};

test("log compose context requires an exact match with the registry anchor", () => {
  assert.deepEqual(verifiedComposeContextForLogs(ENTRY, LABELS, BASE), {
    projectDir: "/home/docker/site",
    project: "site",
    serviceName: "web",
    composeFileName: "compose.yaml"
  });
  // If even a single field differs, the directory counts as unconfirmed.
  assert.equal(
    verifiedComposeContextForLogs(ENTRY, { ...LABELS, "com.docker.compose.service": "db" }, BASE),
    null
  );
});

// ⚠️ The live finding of 2026-08-05. Before, this combination threw, and because
// "allowlisted AND adopted" is the exception among existing containers, the
// log endpoint delivered 503 instead of logs for 8 of 10 managed containers.
//
// The difference that matters: for the REDACTION the directory is only a source
// of additional search terms (if it is missing, less gets replaced — nothing
// leaks), for READING a log file it is the root of a file access (if it were
// missing, it would be a read primitive into a foreign project).
test("compose labels without registry anchor: redaction without project env, file logs blocked", () => {
  assert.equal(verifiedComposeContextForLogs(null, LABELS, BASE), null);
  assert.throws(() => requiredComposeContextForFileLogs(null, LABELS, BASE), EnvRedactionUnavailableError);
});

test("non-compose stdout needs no project env, but file logs do", () => {
  const nonComposeEntry: RegistryEntry = { ...ENTRY, compose: undefined };
  assert.equal(verifiedComposeContextForLogs(nonComposeEntry, {}, BASE), null);
  assert.throws(
    () => requiredComposeContextForFileLogs(nonComposeEntry, {}, BASE),
    EnvRedactionUnavailableError
  );
  // Anchor present, labels missing: likewise unconfirmed.
  assert.equal(verifiedComposeContextForLogs(ENTRY, {}, BASE), null);
  assert.throws(() => requiredComposeContextForFileLogs(ENTRY, {}, BASE), EnvRedactionUnavailableError);
});

// A foreign IMAGE can set compose labels (`Config.Labels` mixes image and
// container labels). Without a confirming anchor such a label must NEVER make
// the agent point at a directory — neither for the `.env` nor, all the more so,
// for a file access.
test("forged labels do not select a foreign project directory", () => {
  const forged = {
    "com.docker.compose.project.working_dir": "/home/docker/dashboard-repo",
    "com.docker.compose.project": "dashboard",
    "com.docker.compose.service": "api",
    "com.docker.compose.project.config_files": "/home/docker/dashboard-repo/docker-compose.yml"
  };
  assert.equal(verifiedComposeContextForLogs(ENTRY, forged, BASE), null);
  assert.throws(
    () => requiredComposeContextForFileLogs(ENTRY, forged, BASE),
    EnvRedactionUnavailableError
  );
});
