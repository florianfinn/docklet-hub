import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Guard over the runtime dependencies of the agent (#272,
// docs/design/feature-architecture.md, section 6). The agent is the process
// next to `docker.sock`; what runs in it is a decision, not a side effect of
// an install. Allowed are the shared `contract` from the workspace and zod,
// pinned to one exact version, the same as in `contract/`. Anything else, or
// a range instead of a pin, fails here.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(new URL(path, `file://${ROOT}`), "utf8");
const readJson = (path) => JSON.parse(read(path));

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * What is wrong with the runtime dependencies of an agent manifest, measured
 * against the manifest of `contract`. An empty list means: nothing.
 */
export function agentDependencyFindings(agentManifest, contractManifest) {
  const findings = [];
  const dependencies = agentManifest.dependencies ?? {};
  const contractZod = contractManifest.dependencies?.zod;

  for (const [name, spec] of Object.entries(dependencies)) {
    if (name === "contract") {
      if (spec !== "workspace:*") findings.push(`contract kommt nicht aus dem Workspace („${spec}")`);
    } else if (name === "zod") {
      if (!EXACT_VERSION.test(spec)) findings.push(`zod ist nicht exakt festgelegt („${spec}")`);
      else if (spec !== contractZod) findings.push(`zod ${spec} weicht von contract ab (${contractZod})`);
    } else {
      findings.push(`${name} ist keine erlaubte Laufzeitabhängigkeit`);
    }
  }
  if (!("contract" in dependencies)) findings.push("contract fehlt");
  if (!("zod" in dependencies)) findings.push("zod fehlt");
  // `optionalDependencies` and `peerDependencies` land at runtime as well.
  for (const field of ["optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(agentManifest[field] ?? {})) {
      findings.push(`${name} steht in ${field}`);
    }
  }
  return findings;
}

test("der Wächter schlägt bei jeder falschen Probe an", () => {
  const contract = { dependencies: { zod: "4.5.2" } };
  const good = { dependencies: { contract: "workspace:*", zod: "4.5.2" } };
  assert.deepEqual(agentDependencyFindings(good, contract), []);

  const samples = [
    [{ dependencies: { ...good.dependencies, "left-pad": "1.3.0" } }, /left-pad ist keine erlaubte/],
    [{ dependencies: { ...good.dependencies, zod: "^4.5.2" } }, /nicht exakt/],
    [{ dependencies: { ...good.dependencies, zod: "~4.5.2" } }, /nicht exakt/],
    [{ dependencies: { ...good.dependencies, zod: "latest" } }, /nicht exakt/],
    [{ dependencies: { ...good.dependencies, zod: "4.5.1" } }, /weicht von contract ab/],
    [{ dependencies: { ...good.dependencies, contract: "0.1.0" } }, /nicht aus dem Workspace/],
    [{ dependencies: { contract: "workspace:*" } }, /zod fehlt/],
    [{ ...good, optionalDependencies: { fsevents: "2.3.3" } }, /fsevents steht in optionalDependencies/]
  ];
  for (const [manifest, expected] of samples) {
    const findings = agentDependencyFindings(manifest, contract);
    assert.ok(findings.some((finding) => expected.test(finding)), `${JSON.stringify(manifest)}: ${findings.join("; ")}`);
  }
});

test("agent/package.json nennt nur contract und zod, exakt wie contract", () => {
  assert.deepEqual(agentDependencyFindings(readJson("agent/package.json"), readJson("contract/package.json")), []);

  // The lockfile is what the image installs; the manifest alone could say
  // 4.5.2 while the lock still holds another resolution.
  const { importers } = parse(read("pnpm-lock.yaml"));
  assert.equal(importers.agent.dependencies.zod.version, importers.contract.dependencies.zod.version);
  assert.deepEqual(Object.keys(importers.agent.dependencies).sort(), ["contract", "zod"]);
});

test("das Agent-Image trägt zod und contract/dist, nicht die Quelle von contract", () => {
  const dockerfile = read("agent/Dockerfile");
  const [buildStage, runtimeStage] = dockerfile.split(/^FROM .*$/m).slice(1);
  assert.ok(runtimeStage, "agent/Dockerfile hat keine zweite Stufe");
  assert.match(buildStage, /^RUN pnpm --filter contract run build$/m, "contract wird im Image nicht gebaut");
  assert.match(buildStage, /cp -rL agent\/node_modules\/zod \/out\/node_modules\/zod/, "zod kommt nicht als Datei ins Image");
  assert.match(buildStage, /cp -r contract\/dist \/out\/node_modules\/contract\/dist/, "contract/dist kommt nicht ins Image");
  assert.doesNotMatch(buildStage, /\/out\/[^\n]*contract\/src/, "die Quelle von contract liegt im Laufzeitbaum");
  assert.match(runtimeStage, /^COPY --from=build \/out\/node_modules \.\/node_modules$/m, "das Image trägt den Laufzeitbaum nicht");
  assert.doesNotMatch(runtimeStage, /contract\/src/, "das Image trägt die TypeScript-Quelle von contract");
  assert.doesNotMatch(runtimeStage, /^RUN\b[^\n]*\b(pnpm|npm install)\b/m, "die Laufzeitstufe installiert selbst");
});
