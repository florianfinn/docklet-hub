import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SELF_HEALING_CONFIG, SELF_HEALING_LIMITS, runtimeSettingsSchema, selfHealingConfigSchema } from "contract";

const defaults = DEFAULT_SELF_HEALING_CONFIG;

test("Migration 017 setzt alle Werkswerte auch ohne erneute Ersteinrichtung", () => {
  const sql = readFileSync(new URL("../../platform/db/migrations/017-runtime-settings.sql", import.meta.url), "utf8");
  assert.match(sql, /apply_compose_definition boolean NOT NULL DEFAULT true/);
  const config = /self_healing_config jsonb NOT NULL DEFAULT '([^']+)'::jsonb/.exec(sql);
  assert.ok(config);
  assert.deepEqual(JSON.parse(config[1]), defaults);
  assert.match(sql, /INSERT INTO runtime_settings \(singleton\) VALUES \(true\)/);
  assert.match(sql, /REFERENCES docker_host\(id\) ON DELETE CASCADE/);
  assert.equal(selfHealingConfigSchema.safeParse(defaults).success, true);
});

test("jede Konfigurationsgrenze akzeptiert beide Endpunkte und lehnt Werte daneben sowie Brüche ab", () => {
  for (const key of ["stabilityWindowSeconds", "maintenanceDurationSeconds"] as const) {
    const { min, max } = SELF_HEALING_LIMITS[key];
    for (const value of [min, max]) assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, [key]: value }).success, true);
    for (const value of [min - 1, max + 1, min + 0.5, "60", undefined, Infinity, NaN])
      assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, [key]: value }).success, false, `${key}: ${String(value)}`);
  }
  assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, maintenanceDurationSeconds: null }).success, true);
  assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, stabilityWindowSeconds: null }).success, false);
  for (const attempts of [1, 10]) assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, attempts,
    retryDelaysSeconds: Array(attempts).fill(1) }).success, true);
  for (const attempts of [0, 11, 1.5, "3", null])
    assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, attempts }).success, false);
  for (const delay of [1, 86_400]) assert.equal(selfHealingConfigSchema.safeParse({ ...defaults,
    retryDelaysSeconds: [delay, delay, delay] }).success, true);
  for (const delay of [0, 86_401, 1.5, "10", null]) assert.equal(selfHealingConfigSchema.safeParse({ ...defaults,
    retryDelaysSeconds: [delay, 60, 300] }).success, false);
});

test("genau ein Abstand je Versuch; Pflichtfelder, Booleans und unbekannte Felder werden geprüft", () => {
  for (const retryDelaysSeconds of [[], [10], [10, 60], [10, 60, 300, 600], Array(11).fill(1)])
    assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, retryDelaysSeconds }).success, false);
  assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, enabled: false }).success, true);
  for (const enabled of [undefined, null, "true", 1])
    assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, enabled }).success, false);
  assert.equal(selfHealingConfigSchema.safeParse({ ...defaults, extra: true }).success, false);
  assert.equal(runtimeSettingsSchema.safeParse({ applyComposeDefinition: false }).success, true);
  for (const applyComposeDefinition of [undefined, null, "false", 0])
    assert.equal(runtimeSettingsSchema.safeParse({ applyComposeDefinition }).success, false);
});
