import assert from "node:assert/strict";
import test from "node:test";
import { collectStatsWave, containerStatsOf, CpuCounterHistory, StatsRingBuffer } from "./stats.js";
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

// One-shot stats as Docker returns them: precpu_stats stays empty.
function oneShot(totalUsage: number, systemUsage: number, onlineCpus?: number): RawStats {
  return {
    cpu_stats: { cpu_usage: { total_usage: totalUsage }, system_cpu_usage: systemUsage, online_cpus: onlineCpus },
    memory_stats: { usage: 100, limit: 1000, stats: { cache: 0 } }
  };
}

test("CPU percent from two consecutive own samples, scaled to the CPU count", () => {
  const counters = new CpuCounterHistory();
  assert.equal(counters.percent("c", oneShot(1_000_000_000, 10_000_000_000, 4)), null);
  // cpuDelta=1e9, systemDelta=1e10 -> 0.1 * 4 * 100 = 40%
  assert.equal(counters.percent("c", oneShot(2_000_000_000, 20_000_000_000, 4)), 40);
});

test("without online_cpus the count falls back to the length of percpu_usage", () => {
  const counters = new CpuCounterHistory();
  const sample = (total: number, system: number): RawStats => ({
    cpu_stats: { cpu_usage: { total_usage: total, percpu_usage: [1, 2] }, system_cpu_usage: system }
  });
  counters.percent("c", sample(1_000_000_000, 10_000_000_000));
  assert.equal(counters.percent("c", sample(2_000_000_000, 20_000_000_000)), 20);
});

test("the first sample of a container has no CPU value", () => {
  assert.equal(new CpuCounterHistory().percent("c", oneShot(2_000_000_000, 20_000_000_000)), null);
});

test("samples are kept per container", () => {
  const counters = new CpuCounterHistory();
  counters.percent("a", oneShot(1_000_000_000, 10_000_000_000, 1));
  assert.equal(counters.percent("b", oneShot(5_000_000_000, 20_000_000_000, 1)), null);
  assert.equal(counters.percent("a", oneShot(2_000_000_000, 20_000_000_000, 1)), 10);
});

test("a counter reset (container restart) yields null and becomes the new baseline", () => {
  const counters = new CpuCounterHistory();
  counters.percent("c", oneShot(5_000_000_000, 10_000_000_000, 1));
  assert.equal(counters.percent("c", oneShot(1_000_000_000, 20_000_000_000, 1)), null);
  assert.equal(counters.percent("c", oneShot(2_000_000_000, 30_000_000_000, 1)), 10);
});

test("a falling system counter yields null instead of a negative value", () => {
  const counters = new CpuCounterHistory();
  counters.percent("c", oneShot(1_000_000_000, 20_000_000_000, 1));
  assert.equal(counters.percent("c", oneShot(2_000_000_000, 10_000_000_000, 1)), null);
});

test("a zero system delta yields 0%, not an error", () => {
  const counters = new CpuCounterHistory();
  counters.percent("c", oneShot(1_000_000_000, 10_000_000_000, 1));
  assert.equal(counters.percent("c", oneShot(2_000_000_000, 10_000_000_000, 1)), 0);
});

test("a sample without CPU counters yields null and the next sample starts over", () => {
  const counters = new CpuCounterHistory();
  counters.percent("c", oneShot(1_000_000_000, 10_000_000_000, 1));
  assert.equal(counters.percent("c", null), null);
  assert.equal(counters.percent("c", oneShot(2_000_000_000, 20_000_000_000, 1)), null);
  assert.equal(counters.percent("c", oneShot(3_000_000_000, 30_000_000_000, 1)), 10);
});

test("a removed container loses its baseline and starts with null when it returns", () => {
  const counters = new CpuCounterHistory();
  counters.percent("c", oneShot(1_000_000_000, 10_000_000_000, 1));
  counters.retain(["other"]);
  assert.equal(counters.percent("c", oneShot(2_000_000_000, 20_000_000_000, 1)), null);
});

test("containerStatsOf takes the CPU value from the caller", () => {
  assert.equal(containerStatsOf(oneShot(1, 1), 12.5).cpuPercent, 12.5);
  assert.equal(containerStatsOf(oneShot(1, 1)).cpuPercent, null);
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

function waveFixture(fetchStats: (containerId: string) => Promise<RawStats | null>) {
  const history = new StatsRingBuffer();
  const counters = new CpuCounterHistory();
  return { history, counters, wave: { history, counters, fetchStats } };
}

test("a wave computes CPU from the previous wave and keeps memory as before", async () => {
  let total = 1_000_000_000;
  let system = 10_000_000_000;
  const { history, wave } = waveFixture(async () => oneShot(total, system, 2));
  await collectStatsWave(["c"], wave);
  total += 1_000_000_000;
  system += 10_000_000_000;
  await collectStatsWave(["c"], wave);

  const snapshot = history.snapshot("c");
  assert.deepEqual(
    snapshot.samples.map((sample) => sample.cpuPercent),
    [null, 20]
  );
  assert.equal(snapshot.memUsageBytes, 100);
  assert.equal(snapshot.memLimitBytes, 1000);
});

test("a failed stats call records an empty sample and does not poison the baseline", async () => {
  let step = 0;
  const responses: (() => Promise<RawStats | null>)[] = [
    async () => oneShot(1_000_000_000, 10_000_000_000, 1),
    async () => {
      throw new Error("socket closed");
    },
    async () => oneShot(9_000_000_000, 20_000_000_000, 1),
    async () => oneShot(10_000_000_000, 30_000_000_000, 1)
  ];
  const { history, wave } = waveFixture(() => responses[step++]!());
  const originalError = console.error;
  console.error = () => {};
  try {
    for (let index = 0; index < responses.length; index++) await collectStatsWave(["c"], wave);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(
    history.snapshot("c").samples.map((sample) => sample.cpuPercent),
    [null, null, null, 10]
  );
});

test("a container removed between waves starts with null when it returns", async () => {
  let total = 1_000_000_000;
  const { history, wave } = waveFixture(async () => {
    total += 1_000_000_000;
    return oneShot(total, total * 10, 1);
  });
  await collectStatsWave(["c"], wave);
  await collectStatsWave(["c"], wave);
  await collectStatsWave([], wave);
  await collectStatsWave(["c"], wave);
  assert.deepEqual(
    history.snapshot("c").samples.map((sample) => sample.cpuPercent),
    [null]
  );
});

test("a wave over 35 containers with 10 ms latency ends far below the 10 s interval", async () => {
  const ids = Array.from({ length: 35 }, (_, index) => `c${index}`);
  const { history, wave } = waveFixture(
    () => new Promise((resolve) => setTimeout(() => resolve(oneShot(1, 1)), 10))
  );
  const started = performance.now();
  await collectStatsWave(ids, wave);
  const elapsedMs = performance.now() - started;

  // Six lanes need six rounds of 10 ms; one second leaves room for a slow CI.
  assert.ok(elapsedMs < 1_000, `wave took ${elapsedMs} ms`);
  assert.equal(ids.every((id) => history.snapshot(id).samples.length === 1), true);
});
