import assert from "node:assert/strict";
import test from "node:test";
import { containerStatsOf, StatsRingBuffer } from "./stats.js";
import type { RawStats } from "./engine.js";

test("null raw data yields null throughout (container without readable stats)", () => {
  assert.deepEqual(containerStatsOf(null), {
    cpuPercent: null,
    memUsageBytes: null,
    memLimitBytes: null,
    sampledAt: null,
    samples: []
  });
});

test("CPU percent from the difference of two measurements, scaled to the CPU count", () => {
  const raw: RawStats = {
    cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 },
    memory_stats: { usage: 100, limit: 1000, stats: { cache: 0 } }
  };
  // cpuDelta=1e9, systemDelta=1e10 -> 0.1 * 4 * 100 = 40%
  assert.equal(containerStatsOf(raw).cpuPercent, 40);
});

test("without online_cpus the count falls back to the length of percpu_usage", () => {
  const raw: RawStats = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2] },
      system_cpu_usage: 20_000_000_000
    },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 }
  };
  assert.equal(containerStatsOf(raw).cpuPercent, 20);
});

test("missing precpu_stats (container just started) -> no value instead of a guess", () => {
  const raw: RawStats = {
    cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 20_000_000_000 }
  };
  assert.equal(containerStatsOf(raw).cpuPercent, null);
});

test("a negative or zero system delta yields 0%, not an error", () => {
  const raw: RawStats = {
    cpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 10_000_000_000 }
  };
  assert.equal(containerStatsOf(raw).cpuPercent, 0);
});

test("RAM usage subtracts the cache share", () => {
  const raw: RawStats = { memory_stats: { usage: 500, limit: 1000, stats: { cache: 200 } } };
  const stats = containerStatsOf(raw);
  assert.equal(stats.memUsageBytes, 300);
  assert.equal(stats.memLimitBytes, 1000);
});

test("a limit of 0 (no limit set) becomes null, not 0 bytes", () => {
  const raw: RawStats = { memory_stats: { usage: 500, limit: 0 } };
  assert.equal(containerStatsOf(raw).memLimitBytes, null);
});

test("RAM usage never goes negative, even if the cache value is larger than usage", () => {
  const raw: RawStats = { memory_stats: { usage: 100, stats: { cache: 500 } } };
  assert.equal(containerStatsOf(raw).memUsageBytes, 0);
});

test("the ring buffer keeps exactly the last data points and returns the newest as the current value", () => {
  const ring = new StatsRingBuffer(2);
  const first = containerStatsOf({ memory_stats: { usage: 10, limit: 100 } });
  const second = containerStatsOf({ memory_stats: { usage: 20, limit: 100 } });
  const third = containerStatsOf({ memory_stats: { usage: 30, limit: 100 } });
  ring.record("c", first, "2026-08-03T10:00:00.000Z");
  ring.record("c", second, "2026-08-03T10:00:10.000Z");
  ring.record("c", third, "2026-08-03T10:00:20.000Z");

  assert.deepEqual(ring.snapshot("c"), {
    cpuPercent: null,
    memUsageBytes: 30,
    memLimitBytes: 100,
    sampledAt: "2026-08-03T10:00:20.000Z",
    samples: [
      { sampledAt: "2026-08-03T10:00:10.000Z", cpuPercent: null, memUsageBytes: 20, memLimitBytes: 100 },
      { sampledAt: "2026-08-03T10:00:20.000Z", cpuPercent: null, memUsageBytes: 30, memLimitBytes: 100 }
    ]
  });
});

test("the ring buffer forgets removed allowlist containers", () => {
  const ring = new StatsRingBuffer();
  ring.record("alt", containerStatsOf(null), "2026-08-03T10:00:00.000Z");
  ring.retain(["neu"]);
  assert.equal(ring.snapshot("alt").sampledAt, null);
});
