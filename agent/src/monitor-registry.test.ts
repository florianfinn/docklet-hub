import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MonitorRegistry } from "./monitor-registry.js";

test("MonitorRegistry still maps a new Docker id via the stable name", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-monitor-"));
  try {
    const file = path.join(directory, "monitors.json");
    const registry = new MonitorRegistry(file);
    registry.replaceAll([{ monitorId: "54", containerId: "a".repeat(64), containerName: "/frps" }]);

    assert.equal(registry.has("b".repeat(64), "frps"), true);
    assert.equal(registry.has("b".repeat(64), "anderer-dienst"), false);
    assert.deepEqual(registry.list(), [
      { monitorId: "54", containerId: "a".repeat(64), containerName: "frps" }
    ]);

    const reloaded = new MonitorRegistry(file);
    assert.deepEqual(reloaded.list(), registry.list());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("old id-based monitor files stay compatible", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-monitor-legacy-"));
  try {
    const file = path.join(directory, "monitors.json");
    fs.writeFileSync(file, JSON.stringify([{ containerId: "legacy" }]), "utf8");
    const registry = new MonitorRegistry(file);
    assert.equal(registry.has("legacy"), true);
    assert.deepEqual(registry.list(), [{ containerId: "legacy" }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
