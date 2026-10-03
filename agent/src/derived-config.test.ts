import assert from "node:assert/strict";
import test from "node:test";
import { derivedConfig, withoutDigest } from "./derived-config.js";
import type { RawInspect } from "./engine.js";

test("withoutDigest cuts off the manifest digest", () => {
  assert.equal(withoutDigest("nginx:1.27@sha256:abc"), "nginx:1.27");
  assert.equal(withoutDigest("nginx:1.27"), "nginx:1.27");
  assert.equal(withoutDigest("nginx@sha256:abc"), "nginx");
});

// ⚠️ The actual test of this stage: what is NOT in the response.
// §16.3 — host paths are a map of the server, labels carry Traefik rules and
// occasionally credentials, env reveals something through the key names
// alone.
test("the derived information contains neither host paths nor env, labels or capabilities", () => {
  const raw: RawInspect = {
    Id: "abc",
    Name: "/palworld",
    Config: {
      Image: "palworld:latest@sha256:deadbeef",
      Env: ["ADMIN_PASSWORD=hunter2", "PATH=/usr/bin"],
      Labels: { "traefik.http.routers.pal.rule": "Host(`pal.example.org`)" },
      ExposedPorts: { "8211/udp": {} },
      Healthcheck: { Test: ["CMD", "curl", "-f", "http://localhost:8211"] }
    },
    State: { Status: "running", Running: true, Health: { Status: "healthy" } },
    Mounts: [
      { Type: "bind", Source: "/mnt/user/docker/palworld/data", Destination: "/palworld", RW: true }
    ],
    NetworkSettings: {
      Networks: { "palworld_default": {} },
      Ports: { "8211/udp": [{ HostIp: "0.0.0.0", HostPort: "8211" }] as unknown as Record<string, unknown> }
    },
    HostConfig: {
      Privileged: true,
      CapAdd: ["NET_ADMIN"],
      Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
      RestartPolicy: { Name: "unless-stopped" },
      Devices: [{ PathOnHost: "/dev/dri", PathInContainer: "/dev/dri" }]
    }
  };

  const info = derivedConfig(raw);

  assert.deepEqual(info, {
    image: "palworld:latest",
    ports: ["8211/udp"],
    restart: "unless-stopped",
    health: { defined: true, status: "healthy" },
    mountDestinations: ["/palworld"],
    networks: ["palworld_default"]
  });

  const text = JSON.stringify(info);
  for (const forbidden of [
    "/mnt/user/docker",
    "ADMIN_PASSWORD",
    "hunter2",
    "traefik",
    "NET_ADMIN",
    "docker.sock",
    "/dev/dri",
    "8211\"" // the HOST side of the port binding does not appear as a value of its own
  ]) {
    assert.ok(!text.includes(forbidden), `must not be contained: ${forbidden}`);
  }
});

test("a stopped container still yields the ports from Config.ExposedPorts", () => {
  const info = derivedConfig({
    Id: "abc",
    Name: "/gestoppt",
    Config: { Image: "nginx", ExposedPorts: { "80/tcp": {}, "443/tcp": {} } },
    State: { Status: "exited", Running: false }
  });
  assert.deepEqual(info.ports, ["443/tcp", "80/tcp"]);
  assert.deepEqual(info.health, { defined: false, status: null });
  // Without a RestartPolicy the honest value is "no", not an empty string.
  assert.equal(info.restart, "no");
  assert.deepEqual(info.networks, []);
});
