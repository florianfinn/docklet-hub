import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOST_THEME, type HostThemePreset } from "contract";
import type { AgentHealth, HostRecord } from "../../domain/hosts/index.js";
import { setHostColor, type AppearanceDeps } from "./service.js";

// The service of the feature `appearance` without Express, without Postgres
// and without an agent (#268): a fake store and a fake probe that records what
// it was asked. The HTTP side of the same route runs against the whole router
// in `app/theme-routes.test.ts`.

const REACHABLE: AgentHealth = { reachable: true, version: "0.32.0", contractVersion: 9, readOnly: false, entries: 3 };
const COLOURED: HostThemePreset = { ...DEFAULT_HOST_THEME, hue: "teal", ink: "head" };

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

function deps(record: HostRecord | null) {
  const calls: string[] = [];
  const fake: AppearanceDeps = {
    setHostDisplay: async (hostId, display) => {
      calls.push(`set ${hostId} ${display.hue}/${display.ink}`);
      return record && { ...record, display };
    },
    probeAgent: async (url) => {
      calls.push(`probe ${url}`);
      return REACHABLE;
    }
  };
  return { fake, calls };
}

test("an unknown arm is a `host-unknown` and nobody is probed", async () => {
  const { fake, calls } = deps(null);
  const result = await setHostColor(fake, "nope", COLOURED);
  assert.deepEqual(result, { kind: "host-unknown" });
  assert.deepEqual(calls, ["set nope teal/head"]);
});

test("the view carries the stored colour and the health that was read again", async () => {
  const { fake, calls } = deps(host());
  const result = await setHostColor(fake, "h1", COLOURED);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.host.display, COLOURED);
  assert.equal(result.host.status, "online");
  assert.deepEqual(calls, ["set h1 teal/head", "probe http://192.0.2.20:8099"]);
});

test("an arm in the state `pending` is not asked: its tunnel is not up yet", async () => {
  const { fake, calls } = deps(host({ state: "pending" }));
  const result = await setHostColor(fake, "h1", COLOURED);
  assert.equal(result.kind, "ok");
  assert.deepEqual(calls, ["set h1 teal/head"]);
});
