import { readFileSync } from "node:fs";

// Source and compiled modules resolve the root manifest at the same depth.
// The release workflow publishes hub and agent under this exact version.
export function readArmAgentImage(manifest = new URL("../../../../package.json", import.meta.url)): string {
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
    throw new Error("The hub manifest must contain a valid release version.");
  }
  return `ghcr.io/florianfinn/docklet-hub-agent:v${version}`;
}

export const ARM_AGENT_IMAGE = readArmAgentImage();
