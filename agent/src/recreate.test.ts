import assert from "node:assert/strict";
import test from "node:test";
import { actionFailureOf } from "./action-failure.js";
import { EngineError } from "./engine.js";
import type { RawInspect } from "./engine.js";
import {
  buildCreatePayload,
  isComposeManaged,
  recreateContainer,
  RecreateFailure,
  type RecreateEngine
} from "./recreate.js";

function inspect(overrides: Partial<RawInspect> = {}): RawInspect {
  return {
    Id: "abc123def456789",
    Name: "/minecraft",
    Image: "sha256:altesimage",
    Config: {
      Image: "itzg/minecraft-server:2024.1",
      Env: ["EULA=TRUE", "MEMORY=4G"],
      Labels: { "com.docker.compose.project": "spiele", "com.docker.compose.service": "mc" },
      Hostname: "abc123def456"
    } as RawInspect["Config"],
    HostConfig: {
      Binds: ["/home/docker/minecraft/data:/data"],
      NetworkMode: "spiele_default",
      RestartPolicy: { Name: "unless-stopped" }
    } as RawInspect["HostConfig"],
    NetworkSettings: {
      Networks: {
        "spiele_default": { Aliases: ["mc", "abc123def456"], IPAddress: "172.20.0.5", MacAddress: "02:42" }
      }
    },
    ...overrides
  } as RawInspect;
}

test("the payload takes over the existing definition and only swaps the image", () => {
  const payload = buildCreatePayload(inspect(), { imageRef: "itzg/minecraft-server:2024.2" });

  assert.equal(payload.name, "minecraft");
  assert.equal(payload.config.Image, "itzg/minecraft-server:2024.2");
  assert.deepEqual(payload.config.Env, ["EULA=TRUE", "MEMORY=4G"]);
  // The HostConfig block goes along unchanged — binds, restart policy, limits.
  assert.deepEqual(payload.config.HostConfig, {
    Binds: ["/home/docker/minecraft/data:/data"],
    NetworkMode: "spiele_default",
    RestartPolicy: { Name: "unless-stopped" }
  });
});

test("compose labels are kept verbatim", () => {
  // Dockge keeps running alongside until stage 9. A container without its
  // compose labels would be a foreign body for Compose.
  const payload = buildCreatePayload(inspect(), { imageRef: "x:1" });
  assert.deepEqual(payload.config.Labels, {
    "com.docker.compose.project": "spiele",
    "com.docker.compose.service": "mc"
  });
  assert.equal(isComposeManaged(inspect()), true);
});

test("the hostname assigned by Docker is discarded, a configured one is not", () => {
  // Default hostname = short container id. If it were taken over, the new
  // container would carry the id of the old one as its hostname.
  const auto = buildCreatePayload(inspect(), { imageRef: "x:1" });
  assert.equal(auto.config.Hostname, undefined);

  const configured = inspect({
    Config: { ...inspect().Config, Hostname: "mc-server" } as RawInspect["Config"]
  });
  assert.equal(buildCreatePayload(configured, { imageRef: "x:1" }).config.Hostname, "mc-server");
});

test("in a foreign netns the hostname is dropped, even one that looks configured", () => {
  // ⚠️ Found live (#36): with `network_mode: container:<id>` inspect reports
  // the hostname of the container WHOSE netns is used — here the short id of
  // the WireGuard sidecar. It therefore looks like a deliberately set value
  // (it is not a prefix of the container's OWN id), and the engine rejects a
  // create with a set hostname in this mode:
  // "conflicting options: hostname and the network mode".
  const inForeignNetns = inspect({
    Config: { ...inspect().Config, Hostname: "d0306a3a8a67" } as RawInspect["Config"],
    HostConfig: {
      ...inspect().HostConfig,
      NetworkMode: "container:d0306a3a8a677d3180dced25106ec80bbfc46c1ebe3599cb4a7df981fb70897"
    } as RawInspect["HostConfig"]
  });
  assert.equal(buildCreatePayload(inForeignNetns, { imageRef: "x:1" }).config.Hostname, undefined);
});

test("in a foreign netns disallowed network options are dropped without changing the inspect value", () => {
  const hostConfig = {
    NetworkMode: "container:sidecar123",
    Dns: ["1.1.1.1"],
    DnsSearch: ["example.test"],
    DnsOptions: ["ndots:1"],
    ExtraHosts: ["internal:127.0.0.1"],
    PortBindings: { "7878/tcp": [{ HostPort: "7878" }] },
    PublishAllPorts: true,
    RestartPolicy: { Name: "unless-stopped" }
  };
  const raw = inspect({
    Config: {
      ...inspect().Config,
      Hostname: "sidecar123",
      MacAddress: "02:42:ac:11:00:02",
      ExposedPorts: { "7878/tcp": {} }
    } as RawInspect["Config"],
    HostConfig: hostConfig as RawInspect["HostConfig"],
    NetworkSettings: { Networks: { inherited: { Aliases: ["radarr"] } } }
  });
  const payload = buildCreatePayload(raw, { imageRef: "x:1" });
  const createdHostConfig = payload.config.HostConfig as Record<string, unknown>;

  assert.equal(payload.config.Hostname, undefined);
  assert.equal(payload.config.ExposedPorts, undefined);
  assert.equal(payload.config.MacAddress, undefined);
  assert.equal(payload.config.NetworkingConfig, undefined);
  assert.deepEqual(payload.additionalNetworks, []);
  assert.equal(createdHostConfig.Dns, undefined);
  assert.equal(createdHostConfig.DnsSearch, undefined);
  assert.equal(createdHostConfig.DnsOptions, undefined);
  assert.equal(createdHostConfig.ExtraHosts, undefined);
  assert.equal(createdHostConfig.PortBindings, undefined);
  assert.equal(createdHostConfig.PublishAllPorts, undefined);
  assert.deepEqual(createdHostConfig.RestartPolicy, hostConfig.RestartPolicy);
  assert.deepEqual(raw.HostConfig, hostConfig);
});

test("runtime fields of the network are not carried along", () => {
  const payload = buildCreatePayload(inspect(), { imageRef: "x:1" });
  const endpoint = (payload.config.NetworkingConfig as Record<string, Record<string, unknown>>)
    .EndpointsConfig["spiele_default"] as Record<string, unknown>;

  // IP and MAC belonged to the old container.
  assert.equal(endpoint.IPAddress, undefined);
  assert.equal(endpoint.MacAddress, undefined);
  // The alias stays — but without the short container id.
  assert.deepEqual(endpoint.Aliases, ["mc"]);
});

test("additional networks are kept separately", () => {
  // On create the engine reliably connects only one.
  const multiple = inspect({
    NetworkSettings: {
      Networks: {
        "spiele_default": { Aliases: ["mc"] },
        monitoring: { Aliases: ["mc-metrics"] }
      }
    }
  });
  const payload = buildCreatePayload(multiple, { imageRef: "x:1" });
  assert.deepEqual(Object.keys((payload.config.NetworkingConfig as Record<string, object>).EndpointsConfig), [
    "spiele_default"
  ]);
  assert.deepEqual(
    payload.additionalNetworks.map((n) => n.name),
    ["monitoring"]
  );
});

// --- The choreography ------------------------------------------------------

type Call = { op: string; args: string[] };

function fakeEngine(overrides: Partial<RecreateEngine> = {}): {
  engine: RecreateEngine;
  calls: Call[];
} {
  const calls: Call[] = [];
  const log = (op: string, ...args: string[]) => calls.push({ op, args });
  const engine: RecreateEngine = {
    async stop(id) {
      log("stop", id);
    },
    async start(id) {
      log("start", id);
    },
    async rename(id, name) {
      log("rename", id, name);
    },
    async remove(id) {
      log("remove", id);
    },
    async create(name) {
      log("create", name);
      return "neu999";
    },
    async connectNetwork(network, id) {
      log("connect", network, id);
    },
    async inspect(id) {
      log("inspect", id);
      return { Id: id, Name: "/minecraft", Image: "sha256:neuesimage" } as RawInspect;
    },
    ...overrides
  };
  return { engine, calls };
}

test("the old container is renamed, not deleted — and only removed at the end", () => {
  return (async () => {
    const { engine, calls } = fakeEngine();
    const result = await recreateContainer(engine, inspect(), {
      imageRef: "itzg/minecraft-server:2024.2",
      expectedImageId: "sha256:neuesimage",
      nowSuffix: "111"
    });

    // No "connect": this container is only attached to its primary network,
    // and that is already connected on create.
    assert.deepEqual(
      calls.map((a) => a.op),
      ["stop", "rename", "create", "start", "inspect", "remove"]
    );
    // Decisive: the rename comes BEFORE the create, the remove LAST.
    assert.deepEqual(calls[1].args, ["abc123def456789", "minecraft-alt-111"]);
    assert.deepEqual(calls.at(-1)?.args, ["abc123def456789"]);
    assert.equal(result.newContainerId, "neu999");
  })();
});

test("further networks are attached after the create", () => {
  return (async () => {
    const multiple = inspect({
      NetworkSettings: {
        Networks: { "spiele_default": { Aliases: ["mc"] }, monitoring: { Aliases: ["mc-metrics"] } }
      }
    });
    const { engine, calls } = fakeEngine();
    await recreateContainer(engine, multiple, {
      imageRef: "x:1",
      expectedImageId: "sha256:neuesimage",
      nowSuffix: "111"
    });

    const connect = calls.find((a) => a.op === "connect");
    assert.ok(connect, "second network must be connected");
    assert.deepEqual(connect.args, ["monitoring", "neu999"]);
    // And BEFORE the start — otherwise the container would briefly run without its network.
    assert.ok(calls.indexOf(connect) < calls.findIndex((a) => a.op === "start"));
  })();
});

test("if the create fails, the old container is brought back", () => {
  return (async () => {
    const { engine, calls } = fakeEngine({
      async create() {
        throw new Error("no space left on device");
      }
    });

    await assert.rejects(
      recreateContainer(engine, inspect(), {
        imageRef: "x:1",
        expectedImageId: "sha256:neuesimage",
        nowSuffix: "111"
      }),
      /no space left/
    );

    // The old container was NOT removed but renamed back and started.
    // Without that it would be gone after a failed create.
    const ops = calls.map((a) => a.op);
    assert.deepEqual(ops, ["stop", "rename", "rename", "start"]);
    assert.deepEqual(calls[2].args, ["abc123def456789", "minecraft"]);
  })();
});

test("a failure names the successful rollback", async () => {
  const { engine } = fakeEngine({
    async create() {
      throw new Error("create rejected");
    }
  });
  await assert.rejects(
    recreateContainer(engine, inspect(), { imageRef: "x:1", expectedImageId: "sha256:neuesimage" }),
    (error: unknown) => {
      assert.ok(error instanceof RecreateFailure);
      assert.equal(error.rollbackAttempted, true);
      assert.equal(error.rolledBack, true);
      assert.match(error.message, /create rejected/);
      return true;
    }
  );
});

test("a real engine throw carries status and rollback outcome through to the response", async () => {
  const { engine } = fakeEngine({
    async create() {
      throw new EngineError('engine responded 400: {"message":"conflicting network options"}', 400);
    }
  });
  await assert.rejects(
    recreateContainer(engine, inspect(), { imageRef: "x:1", expectedImageId: "sha256:neuesimage" }),
    (error: unknown) => {
      const failure = actionFailureOf(error);
      assert.ok(failure);
      assert.equal(failure.status, 400);
      assert.deepEqual(failure.body, {
        error: "engine-action-failed",
        engineStatus: 400,
        engineMessage: "conflicting network options",
        rollbackAttempted: true,
        rolledBack: true
      });
      return true;
    }
  );
});

test("a previously stopped container stays stopped after the rollback", async () => {
  const { engine, calls } = fakeEngine({
    async stop() {
      throw new EngineError("already stopped", 304);
    },
    async create() {
      throw new Error("create rejected");
    }
  });
  await assert.rejects(
    recreateContainer(engine, inspect({ State: { Running: false } }), {
      imageRef: "x:1", expectedImageId: "sha256:neuesimage"
    }),
    (error: unknown) => error instanceof RecreateFailure && error.rolledBack
  );
  assert.equal(calls.some((call) => call.op === "start"), false);
});

test("a failed rollback step is reported, the old one is started anyway", async () => {
  const calls: string[] = [];
  const { engine } = fakeEngine({
    async create() {
      throw new Error("create rejected");
    },
    async rename(_id, name) {
      calls.push(`rename:${name}`);
      if (name === "minecraft") throw new Error("rename back rejected");
    },
    async start(id) {
      calls.push(`start:${id}`);
    }
  });
  await assert.rejects(
    recreateContainer(engine, inspect(), { imageRef: "x:1", expectedImageId: "sha256:neuesimage" }),
    (error: unknown) => {
      assert.ok(error instanceof RecreateFailure);
      assert.equal(error.rollbackAttempted, true);
      assert.equal(error.rolledBack, false);
      return true;
    }
  );
  assert.ok(calls.includes("start:abc123def456789"));
});

test("an error before the first intervention triggers no rollback", async () => {
  const { engine } = fakeEngine({
    async stop() {
      throw new Error("stop rejected");
    }
  });
  await assert.rejects(
    recreateContainer(engine, inspect(), { imageRef: "x:1", expectedImageId: "sha256:neuesimage" }),
    (error: unknown) => {
      assert.ok(error instanceof RecreateFailure);
      assert.equal(error.rollbackAttempted, false);
      assert.equal(error.rolledBack, false);
      return true;
    }
  );
});

test("without a healthcheck the running container and its image id decide", async () => {
  const raw = inspect({ Config: { ...inspect().Config, Healthcheck: null } as RawInspect["Config"] });
  const { engine } = fakeEngine();
  const result = await recreateContainer(engine, raw, {
    imageRef: "x:1",
    expectedImageId: "sha256:neuesimage"
  });
  assert.equal(result.newContainerId, "neu999");
});

test("if the new container runs on a different image, it is rolled back", () => {
  return (async () => {
    // The case the confirmation is built against in the first place: between
    // confirmation and create the ref points to something else.
    const { engine, calls } = fakeEngine({
      async inspect(id) {
        return { Id: id, Image: "sha256:etwasanderes" } as RawInspect;
      }
    });

    await assert.rejects(
      recreateContainer(engine, inspect(), {
        imageRef: "x:1",
        expectedImageId: "sha256:neuesimage",
        nowSuffix: "111"
      }),
      /confirmed was sha256:neuesimage/
    );

    const ops = calls.map((a) => a.op);
    // The new one is removed, the old one brought back.
    assert.ok(ops.includes("remove"), "new container must be removed");
    assert.equal(ops.at(-1), "start");
  })();
});
