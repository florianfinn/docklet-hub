import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_GLOBAL_THEME } from "contract";
import { describeNetwork, readSettings, type SettingsReaders } from "./service.js";

// The answer of `GET /settings` without Express and without Postgres (#269):
// fake readers that record the order they were called in. The HTTP side runs
// against the whole router in `api/settings-*-routes.test.ts`.

const CONFIG = { wireguardEndpoint: "hub.example.org", wireguardPort: 51821 };

function readers(calls: string[], externalEndpoint: string | null = null): SettingsReaders {
  return {
    readNetwork: async () => (calls.push("network"), { externalEndpoint }),
    readTheme: async () => (calls.push("theme"), DEFAULT_GLOBAL_THEME),
    readLogSettings: async () => (calls.push("logs"), { tailLines: 200 }),
    readContainerView: async () => (calls.push("containers"), { showSystem: true })
  };
}

test("readSettings setzt alle vier Teile zusammen und liest in der alten Reihenfolge", async () => {
  const calls: string[] = [];
  const settings = await readSettings(readers(calls), CONFIG);
  assert.deepEqual(calls, ["network", "theme", "logs", "containers"]);
  assert.deepEqual(settings.theme, DEFAULT_GLOBAL_THEME);
  assert.deepEqual(settings.logs, { tailLines: 200 });
  assert.deepEqual(settings.containers, { showSystem: true });
  assert.equal(settings.network.externalEndpoint, null);
});

test("describeNetwork zeigt das Ziel von innen und das von außen aufgelöst, den Rohwert unverändert", () => {
  const network = describeNetwork(CONFIG, "hub.dyndns.invalid");
  assert.equal(network.externalEndpoint, "hub.dyndns.invalid");
  assert.equal(network.internalTarget, "hub.example.org:51821");
  assert.equal(network.externalTarget, "hub.dyndns.invalid:51821");
  assert.equal(network.externalTargetUnreachable, false);
});

test("describeNetwork nennt ein privates Ziel von außen nicht erreichbar", () => {
  assert.equal(describeNetwork(CONFIG, "192.168.77.10").externalTargetUnreachable, true);
});

test("describeNetwork antwortet „noch nicht eingerichtet“ mit null und wirft nicht", () => {
  const network = describeNetwork({ wireguardEndpoint: undefined, wireguardPort: 51821 } as never, null);
  assert.equal(network.internalTarget, null);
  assert.equal(network.externalTarget, null);
  assert.equal(network.externalTargetUnreachable, false);
});
