import fs from "node:fs";

// The agent's own version.
//
// It is needed to be able to carry out SAFE UPDATES at all: the dashboard
// manages agents on foreign hosts it cannot touch. Without information on
// "which version runs there", "all agents are up to date" is an assumption and
// not a finding — and in the very component with root-equivalent access that
// is the wrong kind of assumption.
//
// ⚠️ Previously a CONSTANT stood here ("0.1.0", bootstrap-registration.ts). It
// stayed unchanged over six releases while package.json went up to 0.7.0. A
// version value that does not move along is worse than none: it looks like a
// finding.
//
// What is read is the package.json the runtime image contains anyway
// (Dockerfile: `COPY package.json ./`) — the same file the release workflow
// checks the Git tag against. That way there is exactly ONE source.
//
// If reading fails, that is not a startup error: the agent should not fail
// because of a label. "unknown" is reported — honest, and conspicuous
// enough in the update view.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function readAgentVersion(file = new URL("../package.json", import.meta.url)): string {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && VERSION_PATTERN.test(raw.version) ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const AGENT_VERSION = readAgentVersion();
