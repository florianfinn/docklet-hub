import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const base = { DOCKER_AGENT_SECRET: "s".repeat(32) };
test("bootstrap tunnel protection accepts only a concrete address in the tunnel network", () => {
  const config = loadConfig({
    ...base,
    DOCKER_AGENT_HOST: "10.253.0.7",
    DOCKER_AGENT_REQUIRE_TUNNEL_BIND: "true",
    DOCKER_AGENT_TUNNEL_CIDR: "10.253.0.0/24"
  });
  assert.equal(config.listenHost, "10.253.0.7");
  assert.equal(config.requireTunnelBind, true);
});

test("bootstrap tunnel protection rejects 0.0.0.0 and public addresses", () => {
  for (const host of ["0.0.0.0", "203.0.113.10", "10.254.0.3"]) {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          DOCKER_AGENT_HOST: host,
          DOCKER_AGENT_REQUIRE_TUNNEL_BIND: "true",
          DOCKER_AGENT_TUNNEL_CIDR: "10.253.0.0/24"
        }),
      /concrete address/
    );
  }
});

test("registration URL must come together with a token from the same tunnel network", () => {
  assert.throws(
    () =>
      loadConfig({
        ...base,
        DOCKER_AGENT_REGISTRATION_URL: "http://10.253.0.2:8080/api/docker/hosts/2/register"
      }),
    /must be set together/
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        DOCKER_AGENT_REGISTRATION_URL: "https://example.invalid/register",
        DOCKER_AGENT_REGISTRATION_TOKEN: "t".repeat(32)
      }),
    /WireGuard network/
  );
});

// --- Self-protection paths (S23) --------------------------------------------

test("selfPaths are derived from the base path", () => {
  const local = loadConfig(base);
  assert.deepEqual(local.selfPaths, [
    "/home/docker/dashboard-state",
    "/home/docker/dashboard-repo"
  ]);

  const foreign = loadConfig({ ...base, DOCKER_AGENT_BIND_BASE_PATH: "/mnt/user/docker" });
  assert.deepEqual(foreign.selfPaths, [
    "/mnt/user/docker/dashboard-state",
    "/mnt/user/docker/dashboard-repo"
  ]);
});

test("DOCKER_AGENT_SELF_PATHS is added on top", () => {
  const config = loadConfig({
    ...base,
    DOCKER_AGENT_BIND_BASE_PATH: "/mnt/user/docker",
    DOCKER_AGENT_SELF_PATHS: "/mnt/user/appdata/dashboard-agent-bootstrap, /boot/config/agent/"
  });
  assert.deepEqual(config.selfPaths, [
    "/mnt/user/docker/dashboard-state",
    "/mnt/user/docker/dashboard-repo",
    "/mnt/user/appdata/dashboard-agent-bootstrap",
    "/boot/config/agent"
  ]);
});

test("a self path that covers the whole working tree is rejected", () => {
  // ⚠️ The most important of these tests. The base path IS the working tree of
  // all managed containers — if it counted as an "own path", EVERY container
  // with a bind below it would carry a delegation lock. That is practically
  // the entire existing setup.
  for (const pathname of ["/", "/mnt/user/docker", "/mnt/user", "/mnt"]) {
    assert.throws(
      () => loadConfig({
        ...base,
        DOCKER_AGENT_BIND_BASE_PATH: "/mnt/user/docker",
        DOCKER_AGENT_SELF_PATHS: pathname
      }),
      /bind base path|neither '\/'/,
      pathname
    );
  }
});

test("relative paths and '..' are rejected", () => {
  assert.throws(() => loadConfig({ ...base, DOCKER_AGENT_SELF_PATHS: "relativ/pfad" }), /absolute paths/);
  assert.throws(() => loadConfig({ ...base, DOCKER_AGENT_SELF_PATHS: "/a/../b" }), /absolute paths/);
});

test("without DOCKER_AGENT_SECRET_ALT no rotation is running", () => {
  assert.equal(loadConfig(base).sharedSecretAlt, null);
  // An empty value is not a rotation but a forgotten entry in the .env — it
  // must not open a window.
  assert.equal(loadConfig({ ...base, DOCKER_AGENT_SECRET_ALT: "  " }).sharedSecretAlt, null);
});

test("the transition value is taken over if it is long enough", () => {
  const alt = "a".repeat(32);
  assert.equal(loadConfig({ ...base, DOCKER_AGENT_SECRET_ALT: alt }).sharedSecretAlt, alt);
});

test("a transition value that is too short aborts the start", () => {
  assert.throws(
    () => loadConfig({ ...base, DOCKER_AGENT_SECRET_ALT: "a".repeat(31) }),
    /DOCKER_AGENT_SECRET_ALT is too short/
  );
});

test("transition value equal to the main value is a window that is none", () => {
  assert.throws(
    () => loadConfig({ ...base, DOCKER_AGENT_SECRET_ALT: base.DOCKER_AGENT_SECRET }),
    /identical/
  );
});
