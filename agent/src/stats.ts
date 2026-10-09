import type { RawStats } from "./engine.js";
import { mapLimit } from "./concurrency.js";

// Conversion of Docker stats responses, kept apart from engine.ts so the
// formula and the sampling wave are testable without Docker.

export type ContainerStats = {
  cpuPercent: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  sampledAt: string | null;
  samples: ContainerStatsSample[];
};

export type ContainerStatsSample = {
  sampledAt: string;
  cpuPercent: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
};

const EMPTY_STATS: ContainerStats = {
  cpuPercent: null,
  memUsageBytes: null,
  memLimitBytes: null,
  sampledAt: null,
  samples: []
};

// `cpuPercent` comes from the caller, because one-shot stats carry no
// previous sample; see CpuCounterHistory.
export function containerStatsOf(raw: RawStats | null, cpuPercent: number | null = null): ContainerStats {
  if (!raw) return EMPTY_STATS;

  const memUsageBytes = memUsageOf(raw);
  const memLimit = raw.memory_stats?.limit;

  return withHistory({
    cpuPercent,
    memUsageBytes,
    // 0 means "no limit set", not "0 bytes available" — the same Docker
    // convention as for memoryLimitBytes in hardening.ts.
    memLimitBytes: typeof memLimit === "number" && memLimit > 0 ? memLimit : null
  });
}

function withHistory(stats: Omit<ContainerStats, "sampledAt" | "samples">): ContainerStats {
  return { ...stats, sampledAt: null, samples: [] };
}

// The buffer is deliberately only agent memory: ten minutes of history are a
// live view, not an operational or audit history. That way the sampling
// creates neither DB load nor a second persistent source for metrics.
export class StatsRingBuffer {
  private readonly samplesByContainer = new Map<string, ContainerStatsSample[]>();

  constructor(private readonly capacity = 60) {}

  record(containerId: string, stats: ContainerStats, sampledAt = new Date().toISOString()): void {
    const next: ContainerStatsSample = {
      sampledAt,
      cpuPercent: stats.cpuPercent,
      memUsageBytes: stats.memUsageBytes,
      memLimitBytes: stats.memLimitBytes
    };
    const samples = this.samplesByContainer.get(containerId) ?? [];
    samples.push(next);
    if (samples.length > this.capacity) samples.splice(0, samples.length - this.capacity);
    this.samplesByContainer.set(containerId, samples);
  }

  snapshot(containerId: string): ContainerStats {
    const samples = this.samplesByContainer.get(containerId) ?? [];
    const latest = samples.at(-1);
    if (!latest) return EMPTY_STATS;
    return {
      cpuPercent: latest.cpuPercent,
      memUsageBytes: latest.memUsageBytes,
      memLimitBytes: latest.memLimitBytes,
      sampledAt: latest.sampledAt,
      samples: [...samples]
    };
  }

  retain(containerIds: Iterable<string>): void {
    const current = new Set(containerIds);
    for (const id of this.samplesByContainer.keys()) {
      if (!current.has(id)) this.samplesByContainer.delete(id);
    }
  }
}

type CpuCounters = { total: number; system: number; cpus: number };

function cpuCountersOf(raw: RawStats | null): CpuCounters | null {
  const cpu = raw?.cpu_stats;
  if (typeof cpu?.cpu_usage?.total_usage !== "number" || typeof cpu.system_cpu_usage !== "number") return null;
  return {
    total: cpu.cpu_usage.total_usage,
    system: cpu.system_cpu_usage,
    cpus: cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1
  };
}

// The `docker stats` formula, applied between two own one-shot samples of the
// same container. The first sample after start, a gap or a counter reset
// (container restart) yields null instead of a guess.
export class CpuCounterHistory {
  private readonly lastByContainer = new Map<string, CpuCounters>();

  percent(containerId: string, raw: RawStats | null): number | null {
    const current = cpuCountersOf(raw);
    const previous = this.lastByContainer.get(containerId);
    if (!current) {
      this.lastByContainer.delete(containerId);
      return null;
    }
    this.lastByContainer.set(containerId, current);
    if (!previous) return null;

    const cpuDelta = current.total - previous.total;
    const systemDelta = current.system - previous.system;
    if (cpuDelta < 0 || systemDelta < 0) return null;
    if (systemDelta === 0 || cpuDelta === 0) return 0;

    const percent = (cpuDelta / systemDelta) * current.cpus * 100;
    return Math.round(percent * 10) / 10;
  }

  forget(containerId: string): void {
    this.lastByContainer.delete(containerId);
  }

  retain(containerIds: Iterable<string>): void {
    const current = new Set(containerIds);
    for (const id of this.lastByContainer.keys()) {
      if (!current.has(id)) this.lastByContainer.delete(id);
    }
  }
}

export type StatsWave = {
  history: StatsRingBuffer;
  counters: CpuCounterHistory;
  fetchStats: (containerId: string) => Promise<RawStats | null>;
  concurrency?: number;
};

// One sampling wave over the allowed containers. Best effort: a failed call
// records an empty sample and drops the container's CPU baseline.
export async function collectStatsWave(containerIds: readonly string[], wave: StatsWave): Promise<void> {
  wave.history.retain(containerIds);
  wave.counters.retain(containerIds);
  await mapLimit(containerIds, wave.concurrency ?? 6, async (containerId) => {
    try {
      const raw = await wave.fetchStats(containerId);
      wave.history.record(containerId, containerStatsOf(raw, wave.counters.percent(containerId, raw)));
    } catch (error) {
      console.error(`[agent] stats for ${containerId} not readable:`, error);
      wave.counters.forget(containerId);
      wave.history.record(containerId, containerStatsOf(null));
    }
  });
}

// With Linux cgroups the cache share counts towards "usage", but it can be
// discarded at any time and is therefore not what a viewer understands as
// "RAM usage" — the same correction that `docker stats` itself applies.
function memUsageOf(raw: RawStats): number | null {
  const memory = raw.memory_stats;
  if (!memory || typeof memory.usage !== "number") return null;
  const cache = memory.stats?.cache ?? memory.stats?.inactive_file ?? 0;
  return Math.max(memory.usage - cache, 0);
}
