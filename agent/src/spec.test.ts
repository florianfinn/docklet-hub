import assert from "node:assert/strict";
import test from "node:test";
import { specViolatesHardening, validateSpec, type ContainerSpec } from "./spec.js";

const Base = { bindBasePath: "/home/docker" };

function spec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "minecraft",
    imageRef: "itzg/minecraft-server:2024.1",
    env: [{ key: "EULA", value: "TRUE" }],
    ports: [{ containerPort: 25565, hostPort: 25565, protocol: "tcp", hostIp: "127.0.0.1" }],
    volumes: [{ type: "bind", source: "/home/docker/minecraft/data", target: "/data", readOnly: false }],
    networks: ["spiele"],
    restartPolicy: "unless-stopped",
    resources: { memoryMb: 4096, cpus: 2, pidsLimit: 512 },
    ...overrides
  };
}

function fields(errors: { field: string }[]) {
  return errors.map((e) => e.field).sort();
}

test("a complete spec is valid", () => {
  assert.deepEqual(validateSpec(spec(), Base), []);
});

// --- Bind mounts: the allowlist already at creation ------------------------

test("bind mounts below the base path are allowed", () => {
  assert.deepEqual(validateSpec(spec(), Base), []);
});

test("bind mounts outside the base path are rejected", () => {
  const s = spec({ volumes: [{ type: "bind", source: "/etc", target: "/etc", readOnly: true }] });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].source"]);
});

test("the base path itself is not an allowed bind source", () => {
  const s = spec({ volumes: [{ type: "bind", source: "/home/docker", target: "/host", readOnly: true }] });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].source"]);
});

test("the own project directory is not an allowed bind source", () => {
  // Security review 5c (2026-07-21): the compose.yaml lives there. A container
  // that may mount it rewrites itself as privileged on the next recreate —
  // bypassing a model that deliberately has no field for that.
  const s = spec({
    volumes: [{ type: "bind", source: "/home/docker/minecraft", target: "/proj", readOnly: false }]
  });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].source"]);
});

test("nor the project directory of a NEIGHBOUR", () => {
  const s = spec({
    volumes: [{ type: "bind", source: "/home/docker/homepage", target: "/fremd", readOnly: false }]
  });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].source"]);
});

test("subdirectories stay allowed — including foreign ones", () => {
  // The tightening must not break the goal of the stage.
  for (const source of [
    "/home/docker/minecraft/data",
    "/home/docker/minecraft/a/b",
    "/home/docker/homepage/data"
  ]) {
    const s = spec({ volumes: [{ type: "bind", source, target: "/data", readOnly: false }] });
    assert.deepEqual(validateSpec(s, Base), [], source);
  }
});

// --- Stage 5e: protected class at creation ---------------------------------

const SECURED = { bindBasePath: "/home/docker", secured: true };

test("protected: the own data folder stays allowed", () => {
  // spec().name is "minecraft", so the universe is /home/docker/minecraft.
  assert.deepEqual(validateSpec(spec(), SECURED), []);
});

test("protected: a neighbour mount is rejected that would pass as normal", () => {
  const s = spec({
    volumes: [{ type: "bind", source: "/home/docker/homepage/data", target: "/fremd", readOnly: false }]
  });
  // As normal the same mount is allowed (trust decision, 6.2) ...
  assert.deepEqual(validateSpec(s, Base), []);
  // ... as protected it is not.
  assert.deepEqual(fields(validateSpec(s, SECURED)), ["volumes[0].source"]);
});

test("protected: the universe follows the name, not a value in the request", () => {
  const s = spec({
    name: "homepage",
    volumes: [{ type: "bind", source: "/home/docker/homepage/data", target: "/data", readOnly: false }]
  });
  assert.deepEqual(validateSpec(s, SECURED), []);
});

test("specViolatesHardening knows the class", () => {
  const s = spec({
    volumes: [{ type: "bind", source: "/home/docker/homepage/data", target: "/fremd", readOnly: false }]
  });
  assert.deepEqual(specViolatesHardening(s, "/home/docker", false), []);
  assert.deepEqual(specViolatesHardening(s, "/home/docker", true), ["bind-outside-universe"]);
});

test("control characters in volume paths are rejected", () => {
  // Addendum from the security review of 5c: control characters were only
  // checked in env values. A line break cannot break out of a single-quoted
  // YAML scalar — but a validation that checks the same thing in one place and
  // not in the other is an invitation.
  const withLineBreak = spec({
    volumes: [{ type: "bind", source: "/home/docker/x/data\nprivileged: true", target: "/data", readOnly: false }]
  });
  assert.ok(fields(validateSpec(withLineBreak, Base)).includes("volumes[0].source"));

  const targetWithTab = spec({
    volumes: [{ type: "named", source: "daten", target: "/data\tx", readOnly: false }]
  });
  assert.deepEqual(fields(validateSpec(targetWithTab, Base)), ["volumes[0].target"]);
});

test("bind sources cannot trick their way out of the base path via ..", () => {
  const s = spec({
    volumes: [{ type: "bind", source: "/home/docker/../../etc", target: "/etc", readOnly: true }]
  });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].source"]);
});

test("without a configured base path EVERY bind is forbidden", () => {
  // Fail closed: no base path = no allowed range = no allowed bind.
  // (For hardening the existing setup it is the other way round — there a
  // missing configuration would otherwise reject the whole existing setup.)
  assert.deepEqual(fields(validateSpec(spec(), {})), ["volumes[0].source"]);
});

test("named volumes need no base path", () => {
  const s = spec({ volumes: [{ type: "named", source: "mc-daten", target: "/data", readOnly: false }] });
  assert.deepEqual(validateSpec(s, {}), []);
});

test("a volume target with .. is rejected", () => {
  const s = spec({ volumes: [{ type: "named", source: "daten", target: "/data/../../etc", readOnly: false }] });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].target"]);
});

// --- Resource limits are optional, but a GIVEN limit is bounded ----------

test("a spec without any limits is valid", () => {
  const without = spec({ resources: { memoryMb: null, cpus: null, pidsLimit: null } });
  assert.deepEqual(validateSpec(without, Base), []);
});

test("a missing resources block is valid", () => {
  // An old caller that does not send the block at all is therefore not
  // broken — it gets a container without limits, not three field errors.
  const s = spec({ resources: undefined as unknown as ContainerSpec["resources"] });
  assert.deepEqual(validateSpec(s, Base), []);
});

test("nonsensical limits are rejected", () => {
  // ⚠️ 0 is NOT a way to deselect a limit — that is what `null` is for.
  // Whoever sends 0 has made a typo, and `cpus: 0` would be a set limit of
  // zero CPUs for Compose.
  assert.deepEqual(
    fields(validateSpec(spec({ resources: { memoryMb: 0, cpus: 0, pidsLimit: 0 } }), Base)),
    ["resources.cpus", "resources.memoryMb", "resources.pidsLimit"]
  );
  // Upwards too: a typo should not eat up the host.
  assert.deepEqual(
    fields(validateSpec(spec({ resources: { memoryMb: 999999, cpus: 2, pidsLimit: 512 } }), Base)),
    ["resources.memoryMb"]
  );
});

test("a single limit may be missing while the others are set", () => {
  const s = spec({ resources: { memoryMb: 4096, cpus: null, pidsLimit: 512 } });
  assert.deepEqual(validateSpec(s, Base), []);
});

test("without limits resource-limit-missing stays a hint and not a violation", () => {
  // The reason why leaving them out MAY be allowed at all: the rule is not in
  // SELF_CHECK_RULES. If this test fails, creating without limits is locked
  // from now on — and silently so.
  const without = spec({ resources: { memoryMb: null, cpus: null, pidsLimit: null } });
  assert.deepEqual(specViolatesHardening(without, "/home/docker"), []);
});

// --- Remaining fields -----------------------------------------------------

test("env names and values are checked", () => {
  assert.deepEqual(fields(validateSpec(spec({ env: [{ key: "2FALSCH", value: "x" }] }), Base)), [
    "env[0].key"
  ]);
  assert.deepEqual(fields(validateSpec(spec({ env: [{ key: "OK", value: "a\nb" }] }), Base)), [
    "env[0].value"
  ]);
});

test("ports are checked for range, protocol and host IP", () => {
  const s = spec({
    ports: [{ containerPort: 0, hostPort: 70000, protocol: "sctp" as "tcp", hostIp: "kein-ip" }]
  });
  assert.deepEqual(fields(validateSpec(s, Base)), [
    "ports[0].containerPort",
    "ports[0].hostIp",
    "ports[0].hostPort",
    "ports[0].protocol"
  ]);
});

test("unclean names are rejected", () => {
  for (const name of ["", "-start-mit-strich", "hat leerzeichen", "a", "x".repeat(64)]) {
    assert.deepEqual(fields(validateSpec(spec({ name }), Base)), ["name"], name);
  }
});

// --- The self-check ---------------------------------------------------------
//
// The tests of the creation payload moved to compose.test.ts with stage 5c:
// the payload is no longer built for the engine API but written as a compose
// file. The guarantee has stayed the same and is checked there — there is no
// field for privileged, capabilities or devices, so the attack surface does
// not arise.

test("the generated spec passes its own hardening check", () => {
  // The self-check: what we generate must pass our own rules.
  assert.deepEqual(specViolatesHardening(spec(), "/home/docker"), []);
});

test("the self-check fires when a bind does fall outside", () => {
  const s = spec({ volumes: [{ type: "bind", source: "/etc", target: "/etc", readOnly: true }] });
  assert.deepEqual(specViolatesHardening(s, "/home/docker"), ["sensitive-host-path"]);
});

// --- Review finding 2026-07-20: colons shift field boundaries -------------

test("a colon in the volume target is rejected", () => {
  // The bind is assembled as "source:target:mode". A colon in the target
  // shifts the field boundaries — today that runs into an engine error, but
  // security should not rely on that.
  const s = spec({
    volumes: [{ type: "named", source: "daten", target: "/data:/var/run/docker.sock", readOnly: false }]
  });
  assert.deepEqual(fields(validateSpec(s, Base)), ["volumes[0].target"]);
});

test("a colon in the bind source is rejected", () => {
  const s = spec({
    volumes: [{ type: "bind", source: "/home/docker/a:/b", target: "/data", readOnly: false }]
  });
  assert.ok(fields(validateSpec(s, Base)).includes("volumes[0].source"));
});
