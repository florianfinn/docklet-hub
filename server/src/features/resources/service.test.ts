import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOST_THEME, type HostResources } from "contract";

import type { HostRecord, HostRouteAccessResult } from "../../domain/hosts/index.js";
import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import { fetchHostResources } from "./agent-client.js";
import { createResourcesService, markSystemResources } from "./service.js";

const TARGET: AgentTarget = { baseUrl: "http://agent.test", secret: "s".repeat(32) };
const REQUEST = { hostId: "h1", userId: "admin-1" };

const HOST: HostRecord = {
  id: "h1",
  name: "nas",
  agentUrl: "http://agent.test",
  kind: "external",
  state: "registered",
  tunnelAddress: null,
  wireguardPublicKey: null,
  endpointOverride: null,
  failedAttempts: 0,
  dockerGid: null,
  bindBasePath: null,
  createdAt: new Date("2026-10-03T10:00:00.000Z"),
  registeredAt: null,
  lastSeenAt: null,
  display: DEFAULT_HOST_THEME
};

const HUB_DB = { name: "docklet-hub-db-1", running: true, image: "postgres:17.6", composeProject: "docklet-hub" };
const SHOP = { name: "shop-web-1", running: true, image: "example/web:1.2.0", composeProject: "shop" };

const RESOURCES: HostResources = {
  readAt: "2026-10-04T12:00:00.000Z",
  storage: {
    ok: true,
    summary: {
      images: { count: 2, sizeBytes: 900, unusedBytes: 300 },
      containers: { count: 2, sizeBytes: 140, unusedBytes: 40 },
      volumes: { count: 2, sizeBytes: 5000, unusedBytes: 0 },
      buildCache: { count: 0, sizeBytes: null, unusedBytes: null }
    }
  },
  usage: { ok: true },
  images: {
    ok: true,
    items: [
      { id: "sha256:a", tags: ["ghcr.io/example/docklet-hub-agent:v0.32.0"], sizeBytes: 300, sharedSizeBytes: 0, createdAt: null, usedBy: [] },
      { id: "sha256:b", tags: ["postgres:17.6"], sizeBytes: 400, sharedSizeBytes: 0, createdAt: null, usedBy: [HUB_DB] },
      { id: "sha256:c", tags: ["example/web:1.2.0"], sizeBytes: 200, sharedSizeBytes: 0, createdAt: null, usedBy: [SHOP] }
    ]
  },
  volumes: {
    ok: true,
    items: [
      { name: "docklet-hub_db", driver: "local", scope: "local", anonymous: false, composeProject: "docklet-hub", sizeBytes: 4000, usedBy: [] },
      { name: "shop_data", driver: "local", scope: "local", anonymous: false, composeProject: "shop", sizeBytes: 1000, usedBy: [SHOP, HUB_DB] },
      { name: "loose", driver: "local", scope: "local", anonymous: false, composeProject: null, sizeBytes: null, usedBy: null }
    ]
  },
  networks: { ok: false, reason: "engine-timeout" }
};

function opened(writable: boolean): HostRouteAccessResult {
  return {
    ok: true,
    access: { host: HOST, target: TARGET, options: { actor: { kind: "user", id: "admin-1" } }, writable }
  };
}

test("marks what belongs to hub or agent with the rule of the system containers", () => {
  const view = markSystemResources(RESOURCES);
  assert.ok(view.images.ok && view.volumes.ok);
  // By the image repository, by a system user, and neither.
  assert.deepEqual(
    view.images.items.map((image) => image.system),
    [true, true, false]
  );
  // By its own compose project, by one system user among others, and unknown usage.
  assert.deepEqual(
    view.volumes.items.map((volume) => volume.system),
    [true, true, false]
  );
  // A failed section passes through as it is.
  assert.deepEqual(view.networks, { ok: false, reason: "engine-timeout" });
});

test("reads as a reading route and passes on the session's actor", async () => {
  const seen: Array<{ writing: string; actor: unknown }> = [];
  let writing = "";
  const service = createResourcesService({
    openHost: async (_request, mode) => {
      writing = mode;
      return opened(true);
    },
    fetchResources: async (target, options) => {
      seen.push({ writing, actor: options.actor });
      assert.equal(target, TARGET);
      return RESOURCES;
    }
  });
  const result = await service.read(REQUEST);
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ writing: "reads", actor: { kind: "user", id: "admin-1" } }]);
});

test("an outdated arm is refused before it is asked", async () => {
  let asked = 0;
  const service = createResourcesService({
    openHost: async () => opened(false),
    fetchResources: async () => {
      asked += 1;
      return RESOURCES;
    }
  });
  const result = await service.read(REQUEST);
  assert.equal(asked, 0);
  assert.ok(!result.ok && result.failure.kind === "problem");
  assert.equal(result.failure.status, 409);
  assert.equal(result.failure.error, "agent-outdated");
});

test("a refusal of the host chain passes through", async () => {
  const failure = { kind: "problem" as const, status: 404, error: "host-unknown", message: "x" };
  const service = createResourcesService({
    openHost: async () => ({ ok: false, failure }),
    fetchResources: async () => assert.fail("must not be reached")
  });
  assert.deepEqual(await service.read(REQUEST), { ok: false, failure });
});

test("an agent error becomes a route failure", async () => {
  const error = new AgentError("Der Agent war nicht erreichbar.");
  const service = createResourcesService({
    openHost: async () => opened(true),
    fetchResources: async () => {
      throw error;
    }
  });
  assert.deepEqual(await service.read(REQUEST), { ok: false, failure: { kind: "agent-error", error } });
});

test("an answer outside the contract is an agent error, not a crash", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ readAt: "x", images: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  await assert.rejects(
    fetchHostResources(TARGET, { actor: { kind: "user", id: "admin-1" }, fetchImpl }),
    (error: unknown) => error instanceof AgentError && /passt nicht zum Vertrag/.test(error.message)
  );
});

test("asks the agent at GET /resources with a window longer than its own", async () => {
  const calls: Array<{ url: string; method: string | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify(RESOURCES), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const resources = await fetchHostResources(TARGET, { actor: { kind: "user", id: "admin-1" }, fetchImpl });
  assert.deepEqual(calls, [{ url: "http://agent.test/resources", method: "GET" }]);
  assert.deepEqual(resources, RESOURCES);
});
