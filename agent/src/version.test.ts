import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_VERSION, readAgentVersion } from "./version.js";

function tempPackage(content: string): URL {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-version-")), "package.json");
  fs.writeFileSync(file, content, "utf8");
  return new URL(`file://${file}`);
}

test("the version comes from the image's package.json", () => {
  assert.equal(readAgentVersion(tempPackage('{"version":"1.2.3"}')), "1.2.3");
});

test("AGENT_VERSION matches the repo's package.json", () => {
  // Exactly the error this file is meant to prevent: a version string that
  // stays put while the package.json moves on.
  const expected = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(AGENT_VERSION, expected);
});

test("an unusable or missing value is honestly reported as 'unknown'", () => {
  assert.equal(readAgentVersion(tempPackage('{"version":"latest"}')), "unknown");
  assert.equal(readAgentVersion(tempPackage("kein json")), "unknown");
  assert.equal(readAgentVersion(new URL("file:///gibt/es/nicht/package.json")), "unknown");
});
