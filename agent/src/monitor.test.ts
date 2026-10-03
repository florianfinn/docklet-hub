import assert from "node:assert/strict";
import test from "node:test";
import { toMonitorStatus } from "./monitor.js";
import type { RawInspect } from "./engine.js";

// Watch-only-Monitor (D1): die reduzierte Form (W2). Der Test sichert vor allem
// die BEWUSSTE Auslassung ab — hier darf kein Name, Image, Env, Mount o.ae.
// hereinrutschen.

test("toMonitorStatus liefert nur die vier reduzierten Felder", () => {
  const raw = {
    Id: "abc123",
    Name: "/geheim-minecraft",
    Image: "itzg/minecraft-server:latest",
    Config: { Image: "itzg/minecraft-server:latest", Env: ["RCON_PASSWORD=secret"] },
    State: { Status: "running", Running: true, StartedAt: "2026-07-22T10:00:00Z", Health: { Status: "healthy" } }
  } as unknown as RawInspect;

  const status = toMonitorStatus(raw);
  assert.deepEqual(status, {
    id: "abc123",
    running: true,
    startedAt: "2026-07-22T10:00:00Z",
    health: "healthy",
    status: "running"
  });
  // W2: keine Aufklaerungs-Felder.
  assert.equal(Object.keys(status).sort().join(","), "health,id,running,startedAt,status");
});

test("toMonitorStatus falls back cleanly when fields are missing", () => {
  const raw = { Id: "def456", State: { Status: "exited", Running: false } } as unknown as RawInspect;
  const status = toMonitorStatus(raw);
  assert.equal(status.running, false);
  assert.equal(status.startedAt, null);
  assert.equal(status.health, null);
  assert.equal(status.status, "exited");
});

test("toMonitorStatus meldet unbekannten Status statt undefined", () => {
  const raw = { Id: "ghi789", State: {} } as unknown as RawInspect;
  assert.equal(toMonitorStatus(raw).status, "unknown");
  assert.equal(toMonitorStatus(raw).running, false);
});
