import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readArmAgentImage } from "./arm-agent-image.js";

test("the hub release selects the same agent tag in source and runtime layouts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-candidate-"));
  try {
    for (const version of ["0.32.0-rc.3", "0.33.0", "0.33.0-rc.1"]) {
      const releaseDirectory = join(directory, version);
      mkdirSync(releaseDirectory);
      writeFileSync(join(releaseDirectory, "package.json"), JSON.stringify({ type: "module", version }));
      for (const layout of ["src", "dist"]) {
        const moduleDirectory = join(releaseDirectory, "server", layout, "domain", "hosts");
        mkdirSync(moduleDirectory, { recursive: true });
        const moduleFile = join(moduleDirectory, "arm-agent-image.ts");
        copyFileSync(new URL("./arm-agent-image.ts", import.meta.url), moduleFile);
        const { ARM_AGENT_IMAGE } = await import(pathToFileURL(moduleFile).href) as { ARM_AGENT_IMAGE: string };
        assert.equal(ARM_AGENT_IMAGE, `ghcr.io/florianfinn/docklet-hub-agent:v${version}`, layout);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive and update targets preserve stable and candidate release versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-release-"));
  const manifest = pathToFileURL(join(directory, "package.json"));
  try {
    for (const version of ["0.32.0", "0.32.0-rc.3", "0.33.0", "0.33.0-rc.1", "1.2.3-rc.12", "1.2.3"]) {
      writeFileSync(manifest, JSON.stringify({ version }));
      assert.equal(readArmAgentImage(manifest), `ghcr.io/florianfinn/docklet-hub-agent:v${version}`);
    }
    for (const version of [null, "latest", "0.32.0\n", "0.32.0:latest", "0.32.0-beta.1"]) {
      writeFileSync(manifest, JSON.stringify({ version }));
      assert.throws(() => readArmAgentImage(manifest), /valid release version/);
    }
    writeFileSync(manifest, "{");
    assert.throws(() => readArmAgentImage(manifest), SyntaxError);
    rmSync(manifest);
    assert.throws(() => readArmAgentImage(manifest));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
