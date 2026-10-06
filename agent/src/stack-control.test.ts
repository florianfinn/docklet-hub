import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedStackMatches,
  isStackAction,
  stackActionDeny,
  stackDefinitionFromConfig,
  stackNeedsDependencySafeRestart,
  stackMutationBaseDeny
} from "./stack-control.js";

test("stack expectation binds project, path, file and the exact service set", () => {
  const actual = {
    projectName: "homepage",
    projectDir: "/srv/compose/homepage",
    composeFileName: "compose.yml",
    services: [
      { serviceName: "db", containerId: "db-id" },
      { serviceName: "web", containerId: "web-id" }
    ]
  };
  assert.equal(expectedStackMatches({ ...actual, services: [...actual.services].reverse() }, actual), true);
  assert.equal(
    expectedStackMatches(
      { ...actual, services: [...actual.services, { serviceName: "admin", containerId: "admin-id" }] },
      actual
    ),
    false
  );
  assert.equal(
    expectedStackMatches(
      { ...actual, services: [{ serviceName: "db", containerId: "other" }, actual.services[1]] },
      actual
    ),
    false
  );
  assert.equal(expectedStackMatches({ ...actual, projectDir: "/srv/compose/other" }, actual), false);
});

test("detects all S11 couplings in normalised Compose JSON", () => {
  const result = stackDefinitionFromConfig({
    services: {
      web: {
        network_mode: "service:vpn",
        pid: "service:worker",
        ipc: "service:db",
        depends_on: {
          db: { condition: "service_healthy", required: true },
          worker: { condition: "service_started", required: true }
        }
      },
      vpn: {},
      worker: {},
      db: {}
    }
  });
  assert.deepEqual(result, {
    services: ["db", "vpn", "web", "worker"],
    couplings: [
      { kind: "ipc", sourceService: "web", targetService: "db" },
      { kind: "service_healthy", sourceService: "web", targetService: "db" },
      { kind: "network_mode", sourceService: "web", targetService: "vpn" },
      { kind: "pid", sourceService: "web", targetService: "worker" }
    ]
  });
});

// The notation `arr_stack` depends on — and which up to v0.12.1 produced no
// coupling at all (outage of 2026-08-25).
test("resolves the container: notation via container_name", () => {
  const result = stackDefinitionFromConfig({
    services: {
      gluetun: { container_name: "gluetun_arrstack" },
      sonarr: { container_name: "sonarr_arrstack", network_mode: "container:gluetun_arrstack" },
      sabnzbd: { container_name: "sabnzbd_arrstack", pid: "container:gluetun_arrstack" },
      prowlarr: { container_name: "prowlarr_arrstack", ipc: "container:gluetun_arrstack" }
    }
  });
  assert.deepEqual(result?.couplings, [
    { kind: "ipc", sourceService: "prowlarr", targetService: "gluetun" },
    { kind: "pid", sourceService: "sabnzbd", targetService: "gluetun" },
    { kind: "network_mode", sourceService: "sonarr", targetService: "gluetun" }
  ]);
});

// A container outside the project cannot be taken along by a stack action —
// there "no coupling" is the right answer, not an invented one pointing at a
// service of the same name.
test("container: pointing at a name outside the project yields no coupling", () => {
  const result = stackDefinitionFromConfig({
    services: {
      app: { container_name: "app_1", network_mode: "container:fremder_vpn" },
      // Same SERVICE name as the target but a different container_name: the
      // resolution must not fall back to the service name.
      "fremder_vpn": { container_name: "ganz_anders" }
    }
  });
  assert.deepEqual(result?.couplings, []);
});

test("ignores plain depends_on relations and host namespaces", () => {
  const result = stackDefinitionFromConfig({
    services: {
      web: {
        network_mode: "host",
        pid: "host",
        ipc: "private",
        depends_on: { db: { condition: "service_started" } }
      },
      db: {}
    }
  });
  assert.deepEqual(result?.couplings, []);
});

test("coupled stacks need a dependency-safe restart", () => {
  assert.equal(stackNeedsDependencySafeRestart([]), false);
  for (const kind of ["network_mode", "pid", "ipc", "service_healthy"] as const) {
    assert.equal(
      stackNeedsDependencySafeRestart([{ kind, sourceService: "app", targetService: "anchor" }]),
      true
    );
  }
});

test("invalid or empty service objects are detected fail-closed", () => {
  assert.equal(stackDefinitionFromConfig(null), null);
  assert.equal(stackDefinitionFromConfig({ services: [] }), null);
  assert.equal(stackDefinitionFromConfig({ services: {} }), null);
});

test("only the five explicit stack actions are valid", () => {
  for (const value of ["start", "stop", "restart", "apply", "down"]) {
    assert.equal(isStackAction(value), true);
  }
  assert.equal(isStackAction("build"), false);
  assert.equal(isStackAction("pull"), false);
  assert.equal(isStackAction("rm"), false);
});

test("kill switch and self-management block every stack mutation", () => {
  assert.deepEqual(
    stackMutationBaseDeny({ readOnly: true, selfManaged: false }),
    { status: 503, code: "agent-read-only" }
  );
  assert.deepEqual(
    stackMutationBaseDeny({ readOnly: false, selfManaged: true }),
    { status: 403, code: "self-management-locked" }
  );
  assert.equal(stackMutationBaseDeny({ readOnly: false, selfManaged: false }), null);
});

test("stack action policy enforces the start fallback and exact down confirmation", () => {
  assert.deepEqual(
    stackActionDeny({
      action: "start",
      missingServices: ["db"],
      projectName: "homepage",
      confirmation: undefined,
      allowFallbackUp: false
    }),
    { status: 409, code: "stack-start-requires-apply" }
  );
  for (const action of ["apply", "stop", "restart"] as const) {
    assert.equal(
      stackActionDeny({ action, missingServices: ["db"], projectName: "homepage", confirmation: undefined, allowFallbackUp: false }),
      null
    );
  }
  assert.deepEqual(
    stackActionDeny({
      action: "down",
      missingServices: [],
      projectName: "homepage",
      confirmation: "Homepage",
      allowFallbackUp: false
    }),
    { status: 409, code: "stack-confirmation-wrong" }
  );
  assert.equal(
    stackActionDeny({
      action: "down",
      missingServices: [],
      projectName: "homepage",
      confirmation: "homepage",
      allowFallbackUp: false
    }),
    null
  );
});

test("start fallback needs the explicit server approval", () => {
  const base = {
    action: "start" as const,
    missingServices: ["db"],
    projectName: "homepage",
    confirmation: undefined
  };
  assert.deepEqual(
    stackActionDeny({ ...base, allowFallbackUp: false }),
    { status: 409, code: "stack-start-requires-apply" }
  );
  assert.equal(stackActionDeny({ ...base, allowFallbackUp: true }), null);
});
