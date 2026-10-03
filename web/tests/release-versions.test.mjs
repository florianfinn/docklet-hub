import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guard over the shared version of hub and agent (#279). One tag `v<semver>`
// builds both images, so the root `package.json` (the hub) and
// `agent/package.json` must carry the same version: the agent reports its
// version from its own manifest, and the hub compares it against the one it
// ships. The release workflow runs this very file before it builds anything
// (`.github/workflows/release.yml`), so it only uses `node:` modules.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(new URL(path, `file://${ROOT}`), "utf8"));

// `x.y.z`, or `x.y.z-rc.n` for the test tag of the release workflow.
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;

/**
 * What is wrong with the versions of the two manifests. An empty list means:
 * nothing.
 */
export function versionFindings(hubManifest, agentManifest) {
  const findings = [];
  for (const [name, manifest] of [["hub", hubManifest], ["agent", agentManifest]]) {
    if (typeof manifest.version !== "string" || !RELEASE_VERSION.test(manifest.version)) {
      findings.push(`die Version des ${name} ist keine Release-Version („${String(manifest.version)}")`);
    }
  }
  if (hubManifest.version !== agentManifest.version) {
    findings.push(`Hub ${String(hubManifest.version)} und Agent ${String(agentManifest.version)} laufen auseinander`);
  }
  return findings;
}

test("der Wächter schlägt bei jeder falschen Probe an", () => {
  assert.deepEqual(versionFindings({ version: "0.32.0" }, { version: "0.32.0" }), []);
  assert.deepEqual(versionFindings({ version: "0.32.0-rc.1" }, { version: "0.32.0-rc.1" }), []);
  assert.equal(versionFindings({ version: "0.32.1" }, { version: "0.32.0" }).length, 1);
  assert.equal(versionFindings({ version: "0.32.0" }, { version: "0.32.0-rc.1" }).length, 1);
  // A manifest without a usable version fails twice: once for itself and
  // once for the mismatch.
  assert.equal(versionFindings({}, { version: "0.32.0" }).length, 2);
  assert.equal(versionFindings({ version: "0.32.0" }, { version: "latest" }).length, 2);
  assert.equal(versionFindings({ version: "v0.32.0" }, { version: "v0.32.0" }).length, 2);
});

test("Hub und Agent tragen dieselbe Version", () => {
  assert.deepEqual(versionFindings(readJson("package.json"), readJson("agent/package.json")), []);
});
