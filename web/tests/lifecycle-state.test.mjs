import test from "node:test";
import assert from "node:assert/strict";
import { actionBlocker, runtimeBlocker, effectiveDefinition, requiresConfirmation, targetsOverlap } from "../src/features/containers/lifecycle-state.ts";
const container = (status, exitCode = null) => ({ id: "web-id", name: "demo-web", image: "nginx:1.27", status, exitCode,
  running: status === "running", startedAt: null, health: null, compose: { project: "demo", service: "web" }, stats: null,
  runtimeAccess: { blocker: null }, externalManagement: null, state: "ok", marks: [], system: false });
const target = (status) => ({ kind: "container", hostId: "demo-host", container: container(status) });
const host = { host: { status: "online" }, agent: { reachable: true, readOnly: false, contractVersion: 13 }, lifecycle: { applyDefinition: true, stopIntents: { observing: true, intents: [] } } };
for (const status of ["running", "restarting", "paused", "created", "exited", "dead", "removing", "unknown"])
  for (const action of ["start", "stop", "restart"]) test(`${status}: ${action} follows the lifecycle matrix`, () => {
    const current = target(status);
    const reason = runtimeBlocker(current, host, "admin", false) ?? actionBlocker(current, action);
    const expected = ["dead", "removing", "unknown"].includes(status) ? "unknown-state" :
      ["running", "restarting", "paused"].includes(status) ? action === "start" ? "already-running" : null : action === "start" ? null : "already-stopped";
    assert.equal(reason, expected);
  });
for (const [reason, patch, role, busy] of [
  ["offline", { host: { status: "offline" } }, "admin", false],
  ["role", {}, "user", false], ["read-only", { agent: { reachable: true, readOnly: true, contractVersion: 13 } }, "admin", false],
  ["capability", { agent: { reachable: true, readOnly: false, contractVersion: 11 } }, "admin", false], ["busy", {}, "admin", true]
]) test(`${reason} blocks every runtime action`, () => assert.equal(runtimeBlocker(target("running"), { ...host, ...patch }, role, busy), reason));
for (const reason of ["observe-only", "not-allowlisted", "self-management-locked"]) test(`agent eligibility ${reason} blocks`, () => {
  const current = target("running"); current.container.runtimeAccess.blocker = reason;
  assert.equal(runtimeBlocker(current, host, "admin", false), reason);
});
test("mixed stack offers all actions; a successful one-shot task does not keep Start open", () => {
  const stack = { kind: "stack", hostId: "demo-host", stack: { project: "demo", system: false, hubOwned: true,
    containers: [container("running"), { ...container("exited", 1), id: "db-id", name: "demo-db" }] } };
  for (const action of ["start", "stop", "restart"]) assert.equal(actionBlocker(stack, action), null);
  stack.stack.containers[1].exitCode = 0;
  assert.equal(actionBlocker(stack, "start", host), null);
  stack.stack.containers[1].oneShot = true;
  assert.equal(actionBlocker(stack, "start", host), "already-running");
  assert.equal(actionBlocker(stack, "stop"), null);
});
test("effective mode and confirmation are limited to stack actions", () => {
  const current = target("running");
  const stack = { kind: "stack", hostId: "demo-host", stack: { project: "demo", hubOwned: true, containers: [current.container] } };
  assert.equal(effectiveDefinition(current, host), false); assert.equal(effectiveDefinition(stack, host), true);
  assert.equal(effectiveDefinition({ ...stack, stack: { ...stack.stack, hubOwned: false } }, host), false);
  assert.equal(effectiveDefinition(stack, { ...host, lifecycle: { applyDefinition: false } }), false);
  for (const action of ["start", "stop", "restart"]) {
    assert.equal(requiresConfirmation(current, action), false); assert.equal(requiresConfirmation(stack, action), action !== "start");
  }
});
test("service and stack operations share their project lock, while other hosts are independent", () => {
  const current = target("running");
  const stack = { kind: "stack", hostId: "demo-host", stack: { project: "demo" } };
  assert.equal(targetsOverlap(current, stack), true);
  assert.equal(targetsOverlap(current, { ...stack, hostId: "other-host" }), false);
  assert.equal(targetsOverlap(current, { ...stack, stack: { project: "other" } }), false);
});

test("zero exits keep Start available after a hub stop or a manual stop in a mixed stack", () => {
  const web = container("exited", 0);
  const db = { ...container("exited", 0), id: "db-id", name: "demo-db", compose: { project: "demo", service: "db" } };
  const current = { kind: "stack", hostId: "demo-host", stack: { project: "demo", containers: [web, db] } };
  const stoppedHost = { ...host, lifecycle: { ...host.lifecycle, stopIntents: { observing: true, intents: [
    { target: { kind: "compose", projectName: "demo", serviceName: "web" } },
    { target: { kind: "compose", projectName: "demo", serviceName: "db" } }
  ] } } };
  assert.equal(actionBlocker(current, "start", stoppedHost), null);
  web.status = "running";
  assert.equal(actionBlocker(current, "start", stoppedHost), null);
  db.oneShot = true;
  assert.equal(actionBlocker(current, "start", stoppedHost), null);
});
test("only explicit completed one-off jobs with known absence of stop intent suppress stack Start", () => {
  const current = { kind: "stack", stack: { containers: [container("exited", 0)] } };
  assert.equal(actionBlocker(current, "start", host), null);
  current.stack.containers[0].oneShot = true;
  for (const exitCode of [1, 137, null]) {
    current.stack.containers[0].exitCode = exitCode;
    assert.equal(actionBlocker(current, "start", host), null);
  }
  current.stack.containers[0].exitCode = 0;
  assert.equal(actionBlocker(current, "start", host), "completed");
  assert.equal(actionBlocker(current, "start"), null);
  assert.equal(actionBlocker(current, "start", { ...host, lifecycle: { stopIntents: { observing: false, intents: [] } } }), null);
});
