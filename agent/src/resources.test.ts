import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "./engine-errors.js";
import { readHostResources, resourceReadFailure, RESOURCE_PATHS, storageSummaryOf, type ResourcePath } from "./resources.js";

const IMAGE_APP = "sha256:" + "a".repeat(64);
const IMAGE_OLD = "sha256:" + "b".repeat(64);
const ANONYMOUS = "c".repeat(64);
const NOW = () => new Date("2026-10-04T12:00:00.000Z");

const containers = [
  {
    Id: "1",
    Names: ["/shop-web-1"],
    Image: "example/web:1.2.0",
    ImageID: IMAGE_APP,
    State: "running",
    Labels: { "com.docker.compose.project": "shop", "traefik.http.routers.web.rule": "Host(`shop.example.org`)" },
    SizeRw: 100,
    Mounts: [
      { Type: "volume", Name: "shop_data" },
      { Type: "bind", Source: "/srv/shop" }
    ],
    NetworkSettings: { Networks: { shop_default: { NetworkID: "net-shop" } } }
  },
  {
    Id: "2",
    Names: ["/shop-worker-1"],
    Image: "example/web:1.2.0",
    ImageID: IMAGE_APP,
    State: "exited",
    Labels: { "com.docker.compose.project": "shop" },
    SizeRw: 40,
    Mounts: [{ Type: "volume", Name: "shop_data" }, { Type: "volume", Name: ANONYMOUS }],
    NetworkSettings: { Networks: { shop_default: { NetworkID: "net-shop" }, bridge: {} } }
  }
];

const answers: Record<ResourcePath, unknown> = {
  "/system/df": {
    LayersSize: 1000,
    Images: [
      { Id: IMAGE_APP, Size: 600, SharedSize: 100, Containers: 2 },
      { Id: IMAGE_OLD, Size: 300, SharedSize: 100, Containers: 0 }
    ],
    Containers: containers,
    Volumes: [
      { Name: "shop_data", UsageData: { Size: 5000, RefCount: 2 } },
      { Name: ANONYMOUS, UsageData: { Size: 70, RefCount: 1 } },
      { Name: "old_cache", UsageData: { Size: -1, RefCount: 0 } }
    ],
    BuildCache: [
      { Size: 10, InUse: false, Shared: false },
      { Size: 20, InUse: true, Shared: false }
    ]
  },
  "/images/json": [
    { Id: IMAGE_OLD, RepoTags: ["<none>:<none>"], Size: 300, Created: 1_700_000_000 },
    { Id: IMAGE_APP, RepoTags: ["example/web:1.2.0"], Size: 600, Created: 1_800_000_000 }
  ],
  "/volumes": {
    Volumes: [
      { Name: "shop_data", Driver: "local", Scope: "local", Labels: { "com.docker.compose.project": "shop" } },
      { Name: ANONYMOUS, Driver: "local", Scope: "local", Labels: null },
      { Name: "old_cache", Driver: "local", Scope: "local", Labels: { "com.docker.volume.anonymous": "" } }
    ],
    Warnings: null
  },
  "/networks": [
    { Id: "net-shop", Name: "shop_default", Driver: "bridge", Scope: "local", Internal: false, Labels: { "com.docker.compose.project": "shop" } },
    { Id: "net-bridge", Name: "bridge", Driver: "bridge", Scope: "local", Internal: false, Labels: {} },
    { Id: "net-backend", Name: "backend", Driver: "bridge", Scope: "local", Internal: true, Labels: {} }
  ],
  "/containers/json?all=1": containers
};

function reader(overrides: Partial<Record<ResourcePath, () => Promise<unknown>>> = {}) {
  const seen: ResourcePath[] = [];
  return {
    seen,
    read: async (path: ResourcePath) => {
      seen.push(path);
      const override = overrides[path];
      return override ? override() : answers[path];
    }
  };
}

test("reads every section and assigns users from the container list", async () => {
  const resources = await readHostResources(reader().read, NOW);
  assert.equal(resources.readAt, "2026-10-04T12:00:00.000Z");
  assert.deepEqual(resources.usage, { ok: true });

  assert.ok(resources.images.ok);
  const [app, old] = resources.images.items;
  assert.deepEqual(app.tags, ["example/web:1.2.0"]);
  assert.equal(app.sharedSizeBytes, 100);
  assert.deepEqual(app.usedBy?.map((user) => [user.name, user.running, user.composeProject]), [
    ["shop-web-1", true, "shop"],
    ["shop-worker-1", false, "shop"]
  ]);
  assert.deepEqual(old.tags, []);
  assert.deepEqual(old.usedBy, []);
  assert.equal(old.createdAt, "2023-11-14T22:13:20.000Z");

  assert.ok(resources.volumes.ok);
  const volumes = Object.fromEntries(resources.volumes.items.map((volume) => [volume.name, volume]));
  assert.equal(volumes.shop_data.usedBy?.length, 2);
  assert.equal(volumes.shop_data.composeProject, "shop");
  assert.equal(volumes.shop_data.sizeBytes, 5000);
  assert.equal(volumes.shop_data.anonymous, false);
  assert.equal(volumes[ANONYMOUS].anonymous, true);
  assert.equal(volumes.old_cache.anonymous, true);
  // -1 is Docker's "not computed", not a size.
  assert.equal(volumes.old_cache.sizeBytes, null);
  assert.deepEqual(volumes.old_cache.usedBy, []);

  assert.ok(resources.networks.ok);
  const networks = Object.fromEntries(resources.networks.items.map((network) => [network.name, network]));
  assert.equal(networks.shop_default.usedBy?.length, 2);
  assert.equal(networks.bridge.predefined, true);
  // An endpoint without NetworkID is matched by name.
  assert.deepEqual(networks.bridge.usedBy?.map((user) => user.name), ["shop-worker-1"]);
  assert.equal(networks.backend.internalOnly, true);
  assert.equal(networks.backend.predefined, false);
  assert.deepEqual(networks.backend.usedBy, []);
});

test("passes on no label beyond the compose project", async () => {
  const resources = await readHostResources(reader().read, NOW);
  assert.doesNotMatch(JSON.stringify(resources), /traefik|example\.org|\/srv\/shop/);
});

test("only GETs the five fixed paths", async () => {
  const { seen, read } = reader();
  await readHostResources(read, NOW);
  assert.deepEqual([...seen].sort(), [...RESOURCE_PATHS].sort());
});

test("a failed section names its reason and leaves the others readable", async () => {
  const timeout = Object.assign(new Error("Engine-Timeout"), { code: "ETIMEDOUT" });
  const resources = await readHostResources(
    reader({
      "/system/df": async () => {
        throw timeout;
      },
      "/networks": async () => {
        throw new EngineError("engine responded 500", 500);
      }
    }).read,
    NOW
  );
  assert.deepEqual(resources.storage, { ok: false, reason: "engine-timeout" });
  assert.deepEqual(resources.networks, { ok: false, reason: "engine-refused" });
  assert.ok(resources.images.ok);
  // Without disk usage the sizes stay unknown instead of turning into zero.
  assert.ok(resources.volumes.ok);
  assert.ok(resources.volumes.items.every((volume) => volume.sizeBytes === null));
  assert.ok(resources.images.items.every((image) => image.sharedSizeBytes === null));
});

test("unknown usage stays null and is reported, never an empty list", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const resources = await readHostResources(
    reader({
      "/containers/json?all=1": async () => {
        throw refused;
      }
    }).read,
    NOW
  );
  assert.deepEqual(resources.usage, { ok: false, reason: "engine-unreachable" });
  assert.ok(resources.images.ok && resources.volumes.ok && resources.networks.ok);
  assert.ok(resources.images.items.every((image) => image.usedBy === null));
  assert.ok(resources.volumes.items.every((volume) => volume.usedBy === null));
  assert.ok(resources.networks.items.every((network) => network.usedBy === null));
});

test("an answer that is no list is unreadable", async () => {
  const resources = await readHostResources(reader({ "/images/json": async () => ({ message: "x" }) }).read, NOW);
  assert.deepEqual(resources.images, { ok: false, reason: "unreadable" });
});

test("disk usage follows the arithmetic of docker system df", () => {
  const summary = storageSummaryOf(answers["/system/df"] as Parameters<typeof storageSummaryOf>[0]);
  // 1000 layer bytes minus the unique 500 bytes of the one image in use.
  assert.deepEqual(summary.images, { count: 2, sizeBytes: 1000, unusedBytes: 500 });
  assert.deepEqual(summary.containers, { count: 2, sizeBytes: 140, unusedBytes: 40 });
  // The uncomputed size counts as unknown, not as zero.
  assert.deepEqual(summary.volumes, { count: 3, sizeBytes: 5070, unusedBytes: null });
  assert.deepEqual(summary.buildCache, { count: 2, sizeBytes: 30, unusedBytes: 10 });
});

test("classifies read failures by cause", () => {
  assert.equal(resourceReadFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "engine-timeout");
  assert.equal(resourceReadFailure(Object.assign(new Error("x"), { code: "ENOENT" })), "engine-unreachable");
  assert.equal(resourceReadFailure(new EngineError("x", 503)), "engine-refused");
  assert.equal(resourceReadFailure(new SyntaxError("x")), "unreadable");
});

test("empty or fully used parts sum to zero, not to unknown", () => {
  const summary = storageSummaryOf({
    LayersSize: 0,
    Images: [],
    Containers: [
      { State: "running", SizeRw: 10 },
      { State: "paused", SizeRw: 20 },
      { State: "restarting", SizeRw: 30 }
    ],
    Volumes: [{ Name: "a", UsageData: { Size: 5, RefCount: 1 } }],
    BuildCache: []
  });
  // Paused and restarting containers count as active, as in docker system df.
  assert.deepEqual(summary.containers, { count: 3, sizeBytes: 60, unusedBytes: 0 });
  assert.deepEqual(summary.volumes, { count: 1, sizeBytes: 5, unusedBytes: 0 });
  assert.deepEqual(summary.buildCache, { count: 0, sizeBytes: 0, unusedBytes: 0 });
  assert.deepEqual(summary.images, { count: 0, sizeBytes: 0, unusedBytes: 0 });
});

test("shared build cache counts in neither total", () => {
  const summary = storageSummaryOf({ LayersSize: 0, Images: [], BuildCache: [{ Size: 7, Shared: true }, { Size: 3 }] });
  assert.deepEqual(summary.buildCache, { count: 2, sizeBytes: 3, unusedBytes: 3 });
});

test("a disk usage answer without the per-object lists is unreadable, not zero", async () => {
  const resources = await readHostResources(
    reader({ "/system/df": async () => ({ ImagesUsage: { TotalSize: 1000 } }) }).read,
    NOW
  );
  assert.deepEqual(resources.storage, { ok: false, reason: "unreadable" });
  assert.ok(resources.volumes.ok);
  assert.ok(resources.volumes.items.every((volume) => volume.sizeBytes === null));
});

test("an image without a size stays unknown", async () => {
  const resources = await readHostResources(
    reader({ "/images/json": async () => [{ Id: IMAGE_OLD, RepoTags: null }] }).read,
    NOW
  );
  assert.ok(resources.images.ok);
  assert.equal(resources.images.items[0].sizeBytes, null);
});
