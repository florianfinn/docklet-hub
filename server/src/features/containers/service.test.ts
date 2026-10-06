import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HOST_THEME, type ContainerViewSettings } from "contract";
import type { ContainerOverviewEntry } from "../../domain/containers/index.js";
import { MIN_AGENT_VERSION, type AgentHealth, type HostRecord } from "../../domain/hosts/index.js";
import type { AgentTarget } from "../../platform/agent-transport/protocol.js";
import { EMPTY_DECORATION, type HostDecoration } from "./decoration.js";
import { createContainersService, type ContainersServiceDeps } from "./service.js";

// `GET /overview` and the write of the container view without Express and
// without Postgres (#282): which arm is asked as whom, an arm that does not
// answer, a stack the operator hid (#209) and a bad value of `showSystem`.
// The HTTP side of the same cases stays in `app/settings-containers-routes.test.ts`
// and `app/agent-secret-routing.test.ts`, through the real router.

function record(name: string, overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: `id-${name}`,
    name,
    agentUrl: `http://${name}:8099`,
    kind: "internal",
    state: "registered",
    tunnelAddress: null,
    wireguardPublicKey: null,
    endpointOverride: null,
    failedAttempts: 0,
    dockerGid: null,
    bindBasePath: null,
    display: DEFAULT_HOST_THEME,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    registeredAt: null,
    lastSeenAt: null,
    ...overrides
  };
}

function entry(name: string, project: string | null): ContainerOverviewEntry {
  return {
    id: `id-${name}`,
    name,
    image: "example:1",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: project === null ? null : { project, service: name },
    stats: null,
    externalManagement: null
  };
}

const ONLINE: AgentHealth = {
  reachable: true,
  version: MIN_AGENT_VERSION,
  contractVersion: 12,
  readOnly: true,
  entries: null
};

type Calls = { fetched: { baseUrl: string; actor: unknown }[]; written: ContainerViewSettings[] };

function serviceWith(hosts: HostRecord[], overrides: Partial<ContainersServiceDeps> & { answers?: Record<string, ContainerOverviewEntry[]> } = {}) {
  const calls: Calls = { fetched: [], written: [] };
  const { answers = {}, ...rest } = overrides;
  const deps: ContainersServiceDeps = {
    hosts: {
      list: async () => hosts,
      connect: async (host) => ({ baseUrl: host.agentUrl, secret: "s".repeat(32) }) satisfies AgentTarget
    },
    probe: async () => ONLINE,
    decorationFor: async () => EMPTY_DECORATION,
    writeViewSettings: async (settings) => {
      calls.written.push(settings);
      return settings;
    },
    agent: {
      fetchContainers: async (target, options) => {
        calls.fetched.push({ baseUrl: target.baseUrl, actor: options.actor });
        const host = hosts.find((candidate) => candidate.agentUrl === target.baseUrl);
        return answers[host?.name ?? ""] ?? [];
      }
    },
    ...rest
  };
  return { service: createContainersService(deps), calls };
}

test("jeder Arm wird unter dem Aufrufer der Sitzung gefragt", async () => {
  const { service, calls } = serviceWith([record("local-host"), record("vps")]);

  await service.overview({ userId: "user-7" });

  assert.deepEqual(
    calls.fetched,
    [
      { baseUrl: "http://local-host:8099", actor: { kind: "user", id: "user-7" } },
      { baseUrl: "http://vps:8099", actor: { kind: "user", id: "user-7" } }
    ]
  );
});

test("ein unerreichbarer Arm steht mit seiner Meldung in der Liste und wird nicht nach Containern gefragt", async () => {
  const silent: AgentHealth = { reachable: false, error: "Zeitüberlauf nach 3000 ms" };
  const { service, calls } = serviceWith([record("local-host"), record("unraid")], {
    probe: async (host) => (host.name === "unraid" ? silent : ONLINE),
    answers: { "local-host": [entry("teamspeak", null)] }
  });

  const hosts = await service.overview({ userId: "user-7" });

  assert.deepEqual(
    hosts.map((overview) => [overview.host.name, overview.host.status, overview.error]),
    [
      ["local-host", "online", null],
      ["unraid", "offline", "Zeitüberlauf nach 3000 ms"]
    ]
  );
  assert.deepEqual(hosts[1].stacks, []);
  assert.deepEqual(calls.fetched.map((call) => call.baseUrl), ["http://local-host:8099"]);
});

test("ein ausgeblendeter Stack bleibt in der Antwort und trägt hidden (#209)", async () => {
  const decoration: HostDecoration = { ...EMPTY_DECORATION, hiddenStacks: new Set(["arr"]) };
  const { service } = serviceWith([record("local-host")], {
    decorationFor: async () => decoration,
    answers: { "local-host": [entry("arr-sonarr-1", "arr"), entry("blog-web-1", "blog")] }
  });

  const [overview] = await service.overview({ userId: "user-7" });

  assert.deepEqual(
    overview.stacks.map((stack) => [stack.project, stack.hidden]),
    [
      ["arr", true],
      ["blog", false]
    ]
  );
});

test("die Marken kommen für jeden Arm einzeln aus dem Leser, den die App hereinreicht", async () => {
  const asked: string[] = [];
  const { service } = serviceWith([record("local-host"), record("vps")], {
    decorationFor: async (host) => {
      asked.push(host.id);
      return EMPTY_DECORATION;
    }
  });

  await service.overview({ userId: "user-7" });

  assert.deepEqual(asked.sort(), ["id-local-host", "id-vps"]);
});

test("showSystem wird als Wahrheitswert geschrieben und der Stand der Antwort kommt aus dem Speicher", async () => {
  const { service, calls } = serviceWith([]);

  assert.deepEqual(await service.updateViewSettings(true), { ok: true, settings: { showSystem: true } });
  assert.deepEqual(await service.updateViewSettings(false), { ok: true, settings: { showSystem: false } });
  assert.deepEqual(calls.written, [{ showSystem: true }, { showSystem: false }]);
});

test("ein Wert, der kein Wahrheitswert ist, wird abgelehnt und nichts geschrieben", async () => {
  const { service, calls } = serviceWith([]);

  for (const value of ["true", "false", 1, 0, null, undefined, {}]) {
    assert.deepEqual(await service.updateViewSettings(value), { ok: false });
  }
  assert.deepEqual(calls.written, []);
});

 test("scoped overview asks only the selected host under the session actor", async () => {
  const first = record("first"); const second = record("second");
  const { service, calls } = serviceWith([first, second]);
  const result = await service.overview({ userId: "user-1", hostId: second.id });
  assert.deepEqual(result.map((entry) => entry.host.id), [second.id]);
  assert.deepEqual(calls.fetched, [{ baseUrl: second.agentUrl, actor: { kind: "user", id: "user-1" } }]);
});
