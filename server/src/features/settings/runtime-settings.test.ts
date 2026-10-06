import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { DEFAULT_GLOBAL_THEME, DEFAULT_SELF_HEALING_CONFIG, settingsSchema } from "contract";
import type { Auth } from "../../platform/auth/auth.js";
import { listenOnFetchablePort } from "../../platform/testing/port-test-support.js";
import { registerSettingsRoutes } from "./routes.js";
import { readApplyComposeDefinition, readRuntimeSettings, recordSelfHealingDelivery } from "./runtime-store.js";
import { readSelfHealingSettings } from "./runtime-service.js";
import { runtimePool } from "./runtime-test-support.js";

async function start(role: "admin" | "user" = "admin", deliveryFails = false) {
  const f = runtimePool();
  const sync = { syncConnected: async () => {
    if (deliveryFails) throw new Error("Offline");
    await recordSelfHealingDelivery(f.pool, "demo-host", f.state.revision, "synced");
  } } as never;
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerSettingsRoutes(router, { pool: f.pool, selfHealingSync: sync,
    auth: { api: { getSession: async () => ({ user: { id: "demo-admin", role } }) } } as unknown as Auth,
    config: { wireguardEndpoint: "hub.example.org", wireguardPort: 51821 },
    readers: { readTheme: async () => DEFAULT_GLOBAL_THEME, readLogSettings: async () => ({ tailLines: 200 }),
      readContainerView: async () => ({ showSystem: false }), readRuntime: () => readRuntimeSettings(f.pool),
      readSelfHealing: () => readSelfHealingSettings(f.pool) }
  });
  app.use("/api", router);
  // The network reader belongs to the existing settings API too.
  const originalQuery = f.pool.query.bind(f.pool);
  f.pool.query = ((sql: string, ...args: unknown[]) => sql.includes("FROM hub_network")
    ? Promise.resolve({ rows: [{ external_endpoint: null }] }) : originalQuery(sql, ...args as [])) as typeof f.pool.query;
  const server = http.createServer(app);
  await listenOnFetchablePort(server);
  return { ...f, call: async (method: string, path = "/settings", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }, close: () => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  }) };
}

test("Settings-API liest Werkswerte und liefert den unverteilten Host sichtbar", async () => {
  const f = await start("user");
  try {
    const response = await f.call("GET");
    assert.equal(response.status, 200);
    const result = settingsSchema.parse(response.body);
    assert.deepEqual(result.runtime, { applyComposeDefinition: true });
    assert.deepEqual(result.selfHealing.config, DEFAULT_SELF_HEALING_CONFIG);
    assert.equal(result.selfHealing.hosts[0].status, "pending");
    assert.equal(await readApplyComposeDefinition(f.pool), true);
  } finally { await f.close(); }
});

test("beide Schreibwege speichern und lesen die gewählten Werte samt quittiertem Host", async () => {
  const f = await start();
  try {
    assert.equal((await f.call("PUT", "/settings/runtime", { runtime: { applyComposeDefinition: false } })).status, 200);
    assert.equal(await readApplyComposeDefinition(f.pool), false);
    const config = { ...DEFAULT_SELF_HEALING_CONFIG, enabled: false, attempts: 1, retryDelaysSeconds: [20], maintenanceDurationSeconds: null };
    const response = await f.call("PUT", "/settings/self-healing", { selfHealing: { config } });
    assert.equal(response.status, 200);
    const result = settingsSchema.parse((await f.call("GET")).body);
    assert.deepEqual(result.selfHealing.config, config);
    assert.equal(result.selfHealing.revision, 2);
    assert.equal(result.selfHealing.hosts[0].status, "synced");
    assert.equal(result.selfHealing.hosts[0].appliedRevision, 2);
  } finally { await f.close(); }
});

test("offline bleibt die Speicherung erfolgreich und der Übertragungsstand ausstehend", async () => {
  const f = await start("admin", true);
  try {
    const config = { ...DEFAULT_SELF_HEALING_CONFIG, enabled: false };
    const response = await f.call("PUT", "/settings/self-healing", { selfHealing: { config } });
    assert.equal(response.status, 200);
    assert.deepEqual(f.state.config, config);
    assert.equal(settingsSchema.parse((await f.call("GET")).body).selfHealing.hosts[0].status, "pending");
  } finally { await f.close(); }
});

test("ungültige Eingaben und fehlende Adminrechte schreiben nichts", async () => {
  for (const role of ["admin", "user"] as const) {
    const f = await start(role);
    try {
      for (const [path, body] of [["/settings/runtime", { runtime: { applyComposeDefinition: "false" } }],
        ["/settings/self-healing", { selfHealing: { config: { ...DEFAULT_SELF_HEALING_CONFIG, attempts: 2 } } }]] as const)
        assert.equal((await f.call("PUT", path, body)).status, role === "admin" ? 400 : 403);
      if (role === "user") for (const [path, body] of [["/settings/runtime", { runtime: { applyComposeDefinition: false } }],
        ["/settings/self-healing", { selfHealing: { config: DEFAULT_SELF_HEALING_CONFIG } }]] as const)
        assert.equal((await f.call("PUT", path, body)).status, 403);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test("fehlgeschlagene Quittung bleibt sichtbar und erhält die letzte bestätigte Revision", async () => {
  const f = runtimePool();
  await recordSelfHealingDelivery(f.pool, "demo-host", 1, "synced");
  await recordSelfHealingDelivery(f.pool, "demo-host", 2, "failed");
  const result = await readSelfHealingSettings(f.pool);
  assert.equal(result.hosts[0].status, "failed");
  assert.equal(result.hosts[0].appliedRevision, 1);
});
