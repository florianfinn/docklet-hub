import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SELF_HEALING_CONFIG, type SelfHealingConfig } from "contract";
import type { HostRecord } from "../../domain/hosts/index.js";
import { createSelfHealingSync } from "./self-healing-sync.js";

const host = { id: "demo", name: "Demo", state: "registered" } as HostRecord;
function fixture() {
  let latest = { config: structuredClone(DEFAULT_SELF_HEALING_CONFIG), revision: 1 };
  const sent: { hostId: string; config: SelfHealingConfig }[] = [];
  const recorded: { hostId: string; revision: number; status: string }[] = [];
  let offline = false;
  const sync = createSelfHealingSync({ read: async () => latest,
    listHosts: async () => [host, { ...host, id: "pending", state: "pending" }],
    send: async (record, config) => { if (offline) throw new Error("offline"); sent.push({ hostId: record.id, config }); },
    record: async (hostId, revision, status) => { recorded.push({ hostId, revision, status }); }
  });
  return { sync, sent, recorded, change: () => { latest = { config: { ...latest.config, enabled: false }, revision: 2 }; },
    offline: (value: boolean) => { offline = value; } };
}

test("Verbindung überträgt Werkswerte; unveränderte Sonden schonen Audit und Änderung überträgt erneut", async () => {
  const f = fixture();
  await f.sync.syncHost(host);
  assert.deepEqual(f.sent, [{ hostId: host.id, config: DEFAULT_SELF_HEALING_CONFIG }]);
  await f.sync.syncHost(host);
  assert.equal(f.sent.length, 1);
  f.change();
  await f.sync.syncConnected();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].config.enabled, false);
  assert.equal(f.recorded[1].revision, 2);
});

test("Live-Wiederverbindung überträgt auch eine unveränderte Revision erneut", async () => {
  const f = fixture();
  await f.sync.syncHost(host, true);
  await f.sync.syncHost(host);
  assert.equal(f.sent.length, 1);
  await f.sync.syncHost(host, true);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].config, DEFAULT_SELF_HEALING_CONFIG);
});

test("fehlgeschlagene Übertragung wird protokolliert und bei nächster erfolgreicher Sonde wiederholt", async () => {
  const f = fixture();
  f.offline(true);
  await f.sync.syncHost(host);
  assert.equal(f.recorded[0].status, "failed");
  f.offline(false);
  await f.sync.syncHost(host);
  assert.equal(f.recorded[1].status, "synced");
  assert.equal(f.sent.length, 1);
});

test("Änderung erreicht alle angebundenen Hosts, während noch nicht registrierte Hosts übersprungen werden", async () => {
  const sent: string[] = [];
  const sync = createSelfHealingSync({ read: async () => ({ config: DEFAULT_SELF_HEALING_CONFIG, revision: 1 }),
    listHosts: async () => [host, { ...host, id: "other" }, { ...host, id: "pending", state: "pending" }],
    send: async (record) => { if (record.id === "other") throw new Error("offline"); sent.push(record.id); },
    record: async () => undefined
  });
  await sync.syncConnected();
  assert.deepEqual(sent, [host.id]);
});

test("überlappende Änderungen senden die aktuelle Revision nacheinander je Host", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  let revision = 1;
  const sent: boolean[] = [];
  const recorded: number[] = [];
  const sync = createSelfHealingSync({ read: async () => ({ config: { ...DEFAULT_SELF_HEALING_CONFIG, enabled: revision === 1 }, revision }),
    listHosts: async () => [host], send: async (_host, config) => {
      sent.push(config.enabled); if (sent.length === 1) { started(); await blocked; }
    }, record: async (_host, value) => { recorded.push(value); }
  });
  const first = sync.syncHost(host);
  await firstStarted;
  revision = 2;
  const second = sync.syncHost(host);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(sent, [true, false]);
  assert.deepEqual(recorded, [1, 2]);
});
