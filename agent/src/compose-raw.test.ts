import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RAW_CONTENT_BYTES,
  diffServices,
  newViolations,
  checkConfirmation,
  serviceNamesFromConfig,
  validateRawContent,
  violationList
} from "./compose-raw.js";

// --- Input check -----------------------------------------------------------

test("empty and overlong content are rejected", () => {
  assert.deepEqual(validateRawContent("   \n "), ["content: must not be empty"]);
  assert.equal(validateRawContent("x".repeat(MAX_RAW_CONTENT_BYTES + 1)).length, 1);
  assert.deepEqual(validateRawContent(42), ["content: must be text"]);
});

test("a NUL byte is rejected", () => {
  // Cannot occur in YAML, but it can in an attempt to cut off a check
  // behind it.
  assert.equal(validateRawContent("services:\n  web:\0\n").length, 1);
});

test("valid raw text passes", () => {
  assert.deepEqual(validateRawContent("services:\n  web:\n    image: nginx\n"), []);
});

// --- Service names ---------------------------------------------------------

test("service names come sorted and independent of translatability", () => {
  // Important: `worker` has no image and would be unreadable for our spec. For
  // the permission question it counts nonetheless — a service that dropped
  // out during translation would be a container without a permission check.
  const names = serviceNamesFromConfig({
    services: { web: { image: "nginx" }, worker: {}, api: { image: "node" } }
  });
  assert.deepEqual(names, ["api", "web", "worker"]);
});

test("without services there is no answer, not an empty one", () => {
  assert.equal(serviceNamesFromConfig({ services: {} }), null);
  assert.equal(serviceNamesFromConfig({}), null);
  assert.equal(serviceNamesFromConfig(null), null);
  assert.equal(serviceNamesFromConfig({ services: [] }), null);
});

// --- Diff ------------------------------------------------------------------

test("the diff separates remaining, new and removed", () => {
  const diff = diffServices(["homepage", "code-server"], ["homepage", "redis"]);
  assert.deepEqual(diff.remaining, ["homepage"]);
  assert.deepEqual(diff.new, ["redis"]);
  assert.deepEqual(diff.removed, ["code-server"]);
});

test("a completely new stack is the case with an empty remaining set", () => {
  // No special path: creating is the same code with before = [].
  const diff = diffServices([], ["web", "db"]);
  assert.deepEqual(diff.remaining, []);
  assert.deepEqual(diff.new, ["db", "web"]);
  assert.deepEqual(diff.removed, []);
});

test("a pure text change leads to an empty diff", () => {
  const diff = diffServices(["web"], ["web"]);
  assert.deepEqual(diff.new, []);
  assert.deepEqual(diff.removed, []);
});

// --- Confirmations ---------------------------------------------------------

test("a missing confirmation is named, not just rejected", () => {
  // The feedback IS the permission prompt: the caller learns what it has to
  // decide on before any container exists.
  const validation = checkConfirmation(["redis", "worker"], ["redis"]);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.missing, ["worker"]);
  assert.deepEqual(validation.unknown, []);
});

test("a confirmation for something that is not pending does not count", () => {
  // Exact match, not subset: whoever confirms a name the diff does not know
  // assumes a different file state — then the whole confirmation is
  // worthless. The same strictness as acknowledgeImageId (5a).
  const validation = checkConfirmation(["redis"], ["redis", "postgres"]);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.unknown, ["postgres"]);
});

test("an exact match passes", () => {
  assert.equal(checkConfirmation(["a", "b"], ["b", "a"]).ok, true);
  assert.equal(checkConfirmation([], []).ok, true);
});

// --- Hardening before/after ------------------------------------------------

test("an existing violation stays tolerated", () => {
  // dozzle already comes with socket-mount. An editor that fails on precisely
  // the stacks it was built for would be useless.
  const before = [{ serviceName: "dozzle", rules: ["socket-mount"] as const }];
  const after = [{ serviceName: "dozzle", rules: ["socket-mount"] as const }];
  assert.deepEqual(newViolations(before, after), []);
});

test("a second violation of the SAME rule is not masked by the first", () => {
  // Self-review 2026-07-21. With bare rule names this would have been an
  // empty list: `socket-mount` was already there before, so every further
  // socket mount on the same service counted as known — and would pass
  // without confirmation. That is why the key carries the detail.
  const before = [{ serviceName: "dozzle", rules: ["socket-mount — /var/run/docker.sock"] }];
  const after = [
    {
      serviceName: "dozzle",
      rules: ["socket-mount — /var/run/docker.sock", "socket-mount — /run/docker.sock"]
    }
  ];
  assert.deepEqual(newViolations(before, after), ["dozzle:socket-mount — /run/docker.sock"]);
});

test("a changed path of the same rule is a new violation", () => {
  const before = [{ serviceName: "web", rules: ["bind-outside-base — /srv/daten"] }];
  const after = [{ serviceName: "web", rules: ["bind-outside-base — /etc"] }];
  assert.deepEqual(newViolations(before, after), ["web:bind-outside-base — /etc"]);
});

test("a newly introduced violation is noticed", () => {
  const before = [{ serviceName: "dozzle", rules: ["socket-mount"] as const }];
  const after = [{ serviceName: "dozzle", rules: ["socket-mount", "privileged"] as const }];
  assert.deepEqual(newViolations(before, after), ["dozzle:privileged"]);
});

test("on a new service EVERY violation is new", () => {
  // Otherwise "placing a second container with docker.sock next to it" would
  // be covered by the existing dozzle violation — the rule would apply
  // stack-wide instead of per container. Exactly the granularity trap from 5d.
  const before = [{ serviceName: "dozzle", rules: ["socket-mount"] as const }];
  const after = [
    { serviceName: "dozzle", rules: ["socket-mount"] as const },
    { serviceName: "heimlich", rules: ["socket-mount"] as const }
  ];
  assert.deepEqual(newViolations(before, after), ["heimlich:socket-mount"]);
});

test("a fixed violation produces no finding", () => {
  const before = [{ serviceName: "web", rules: ["privileged"] as const }];
  assert.deepEqual(newViolations(before, [{ serviceName: "web", rules: [] }]), []);
});

test("the violation list is deduplicated and sorted", () => {
  const listing = violationList([
    { serviceName: "web", rules: ["dangerous-capability", "dangerous-capability"] },
    { serviceName: "api", rules: ["privileged"] }
  ]);
  assert.deepEqual(listing, ["api:privileged", "web:dangerous-capability"]);
});
