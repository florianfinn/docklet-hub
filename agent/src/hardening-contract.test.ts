import assert from "node:assert/strict";
import test from "node:test";
import { HARDENING_RULE_SEVERITY, HARDENING_RULES, parseHardeningFinding } from "contract";
import { findHardeningViolations, violationValue, type InspectedContainer } from "./hardening.js";
import { violationKey } from "./compose-raw.js";

// The hub explains findings by the rule vocabulary in contract/. These tests
// tie the agent's actual check to that vocabulary: every rule the agent
// reports is known there, with the same severity.

function container(overrides: Partial<InspectedContainer>): InspectedContainer {
  return {
    id: "abc123",
    name: "example",
    image: "example/app:1.0",
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    pidMode: "",
    ipcMode: "",
    networkMode: "bridge",
    binds: [],
    devices: [],
    memoryLimitBytes: 512 * 1024 * 1024,
    pidsLimit: 256,
    cpuLimited: true,
    logDriver: "json-file",
    logOptions: { "max-size": "10m" },
    ...overrides
  };
}

const EVERYTHING = findHardeningViolations(
  container({
    privileged: true,
    capAdd: ["SYS_ADMIN"],
    capDrop: [],
    securityOpt: ["seccomp=unconfined"],
    pidMode: "host",
    binds: [
      "/var/run/docker.sock:/var/run/docker.sock",
      "/srv/agent-state/secret:/secret",
      "/etc/ssl:/ssl:ro",
      "/mnt/media:/media",
      "/srv/apps/other/data:/data"
    ],
    unresolvedVolumes: ["cache"],
    devices: ["/dev/dri"],
    memoryLimitBytes: 0,
    logOptions: {}
  }),
  { bindBasePath: "/srv/apps", secureUniverse: "/srv/apps/example", selfPaths: ["/srv/agent-state"] }
);

test("every rule of the contract is reachable by the agent's check", () => {
  const reported = new Set(EVERYTHING.map((violation) => violation.rule));
  assert.deepEqual([...reported].sort(), [...HARDENING_RULES].sort());
});

test("the agent reports each rule with the severity the contract names", () => {
  for (const violation of EVERYTHING) {
    assert.equal(violation.severity, HARDENING_RULE_SEVERITY[violation.rule], violation.rule);
  }
});

test("a compose finding key parses back into service, rule and subject", () => {
  const socket = EVERYTHING.find((violation) => violation.rule === "docker-socket-mount");
  assert.ok(socket);
  const parsed = parseHardeningFinding(violationKey("web", violationValue(socket)));
  assert.equal(parsed.service, "web");
  assert.equal(parsed.rule, "docker-socket-mount");
  assert.equal(parsed.severity, "delegation-lock");
  assert.equal(parsed.subject, "/var/run/docker.sock");
});
