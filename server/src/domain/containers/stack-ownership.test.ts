import test from "node:test";
import assert from "node:assert/strict";
import { stackOwnership } from "./stack-ownership.js";
import type { ContainerEntry } from "contract";
const container = { compose: { project: "demo", service: "web" }, externalManagement: null } as ContainerEntry;
const stack = { projectName: "demo", projectDir: "/srv/example/demo", composeFileName: "compose.yml", filePresent: true,
  management: "full", services: [] };
for (const [name, discovery, expected] of [
  ["full definition", { stacks: [stack], findings: [] }, true],
  ["missing file", { stacks: [{ ...stack, filePresent: false }], findings: [] }, false],
  ["read-only", { stacks: [{ ...stack, management: "read-only" }], findings: [] }, false],
  ["not discovered", { stacks: [], findings: [] }, false],
  ["discovery failed", null, null]
] as const) test(`stack ownership: ${name}`, () => {
  assert.equal(stackOwnership("demo", [container], discovery as never), expected);
  assert.equal(stackOwnership("demo", [{ ...container, externalManagement: { manager: "example-manager" } }], discovery as never), false);
});
