import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOST_THEME, type HostLoad } from "contract";
import type { ContainerOverviewEntry } from "../../domain/containers/index.js";
import type { AgentHealth, HostRecord } from "../../domain/hosts/index.js";
import { AgentError, type AgentTarget } from "../../platform/agent-transport/protocol.js";
import { DEFAULT_BIND_BASE_PATH } from "./bootstrap/host-archive-input.js";
import { createHostsService, type HostsAgent, type HostsServiceDeps } from "./service.js";

// The service of the feature `hosts` without Express, without Postgres and
// without an agent (#266): a fake inventory, a fake probe and a fake agent that
// records what it was asked. The HTTP side of the same routes runs in
// `app/write-routes.test.ts`, `app/container-load-routes.test.ts` and
// `app/enrollment-integration.test.ts`.

const TARGET: AgentTarget = { baseUrl: "http://agent.test", secret: "s".repeat(32) };
const REACHABLE: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 6, readOnly: false, entries: 3 };
const UNREACHABLE: AgentHealth = { reachable: false, error: "Der Agent antwortet nicht." };

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: "h1",
    name: "unraid",
    agentUrl: "http://192.0.2.20:8099",
    kind: "external",
    state: "registered",
    tunnelAddress: "192.0.2.20",
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: 281,
    bindBasePath: "/mnt/user/appdata",
    createdAt: new Date("2026-09-08T10:00:00.000Z"),
    registeredAt: null,
    lastSeenAt: null,
    display: DEFAULT_HOST_THEME,
    ...overrides
  };
}

const CONTAINER = { id: "c0ffee", name: "web", running: true, stats: null } as unknown as ContainerOverviewEntry;

type Overrides = Partial<Omit<HostsServiceDeps, "agent">> & { agent?: Partial<HostsAgent> };

function service(records: HostRecord[], { agent: agentOverrides, ...overrides }: Overrides = {}) {
  const calls: string[] = [];
  const agent: HostsAgent = {
    probeAgent: async (url) => {
      calls.push(`probe ${url}`);
      return REACHABLE;
    },
    fetchContainers: async (_target, options) => {
      const actor = options.actor;
      calls.push(`containers ${actor?.kind}:${actor?.kind === "user" ? actor.id : actor?.name}`);
      return [CONTAINER];
    },
    requestSelfUpdate: async () => {
      calls.push("self-update");
      return { jobId: "job-1", imageRef: "x" };
    },
    fetchSelfUpdateStatus: async () => ({ running: false, version: "0.32.0", last: null }),
    ...agentOverrides
  };
  const deps: HostsServiceDeps = {
    hosts: {
      list: async () => records,
      find: async (id) => records.find((record) => record.id === id) ?? null,
      connect: async () => TARGET
    },
    probe: async () => REACHABLE,
    markSeen: async () => new Date("2026-10-02T08:00:00.000Z"),
    readHostInfo: () => null,
    hostLoad: () => null,
    ...overrides,
    agent
  };
  return { service: createHostsService(deps), calls };
}

test("the list asks no pending arm and writes the time an arm was seen", async () => {
  const { service: hosts, calls } = service([host(), host({ id: "h2", state: "pending", agentUrl: "http://192.0.2.21:8099" })]);
  const views = await hosts.listHosts();
  assert.deepEqual(calls, ["probe http://192.0.2.20:8099"]);
  assert.equal(views[0].lastSeenAt, "2026-10-02T08:00:00.000Z");
  assert.equal(views[1].state, "pending");
  assert.equal(views[1].lastSeenAt, null);
});

test("the list still answers when writing the time fails", async () => {
  const { service: hosts } = service([host()], {
    markSeen: async () => {
      throw new Error("db gone");
    }
  });
  const [view] = await hosts.listHosts();
  assert.notEqual(view.lastSeenAt, null);
});

test("an unknown host is a kind, not an exception", async () => {
  const { service: hosts } = service([]);
  assert.deepEqual(await hosts.readHostContainers("nope", "u1"), { kind: "host-unknown" });
  assert.deepEqual(await hosts.startAgentUpdate("nope", "u1"), { kind: "host-unknown" });
  assert.deepEqual(await hosts.readAgentUpdate("nope", "u1"), { kind: "host-unknown" });
});

test("an unreachable arm is an answer with its error, and no container call is made", async () => {
  const { service: hosts, calls } = service([host()], { probe: async () => UNREACHABLE });
  const result = await hosts.readHostContainers("h1", "u1");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.containers, null);
  assert.equal(result.error, "Der Agent antwortet nicht.");
  assert.deepEqual(calls, []);
});

test("the containers are read in the name of the caller, the load comes from the injected function", async () => {
  const load = { cpuPercent: 1 } as unknown as HostLoad;
  const { service: hosts, calls } = service([host()], { hostLoad: () => load });
  const result = await hosts.readHostContainers("h1", "admin-1");
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(calls, ["containers user:admin-1"]);
  assert.equal(result.load, load);
  assert.equal(result.error, null);
});

test("an agent error while reading containers becomes the field `error`", async () => {
  const { service: hosts } = service([host()], {
    agent: {
      fetchContainers: async () => {
        throw new AgentError("Der Agent lehnte ab.");
      }
    }
  });
  const result = await hosts.readHostContainers("h1", "u1");
  assert.equal(result.kind === "ok" && result.error, "Der Agent lehnte ab.");
});

test("the input of a new arm: gid 0 is valid, an empty base path takes the default", () => {
  const { service: hosts } = service([]);
  const parsed = hosts.parseNewHost({ name: "vps", kind: "external", dockerGid: 0, bindBasePath: "" });
  assert.deepEqual(parsed, {
    kind: "ok",
    input: { name: "vps", kind: "external", dockerGid: 0, bindBasePath: DEFAULT_BIND_BASE_PATH, endpointOverride: null }
  });
});

test("the input of a new arm: each wrong field is refused before anything is created", () => {
  const { service: hosts } = service([]);
  const refused = [
    null,
    [],
    { kind: "external", dockerGid: 1 },
    { name: "a", kind: "local", dockerGid: 1 },
    { name: "a", kind: "external", dockerGid: 1, endpointOverride: 5 },
    { name: "a", kind: "external", dockerGid: -1 },
    { name: "a", kind: "external", dockerGid: 1, bindBasePath: "/" }
  ];
  for (const body of refused) assert.equal(hosts.parseNewHost(body).kind, "invalid-input", JSON.stringify(body));
});

test("the agent update is refused for the local arm and where nothing is offered", async () => {
  const { service: hosts, calls } = service([host({ id: "local", kind: "local" }), host()]);
  assert.deepEqual(await hosts.startAgentUpdate("local", "u1"), { kind: "host-is-local" });
  // 0.32.0 is the target itself: the offer is `current`, not `available`.
  assert.deepEqual(await hosts.startAgentUpdate("h1", "u1"), { kind: "agent-update-unavailable", state: "current" });
  assert.deepEqual(calls, []);
});

test("the state of the update is listed field by field", async () => {
  const { service: hosts } = service([host()], {
    agent: { fetchSelfUpdateStatus: async () => ({ running: true, version: "0.31.0", last: null, extra: 1 }) as never }
  });
  assert.deepEqual(await hosts.readAgentUpdate("h1", "u1"), { kind: "ok", running: true, version: "0.31.0", last: null });
});
