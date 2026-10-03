import type { RawStats } from "./engine.js";

// Reine Umrechnung der Docker-Stats-Antwort (Etappe 6b). Getrennt von
// engine.ts gehalten, damit die Formel ohne Docker testbar ist — dieselbe
// Trennung wie bei hardening.ts (Beschaffen vs. Auswerten).

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

export function containerStatsOf(raw: RawStats | null): ContainerStats {
  if (!raw) return EMPTY_STATS;

  const memUsageBytes = memUsageOf(raw);
  const memLimit = raw.memory_stats?.limit;

  return withHistory({
    cpuPercent: cpuPercentOf(raw),
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

// Dieselbe Formel, die `docker stats` selbst verwendet: die Differenz zweier
// Messungen (aktuell/vorherig) relativ zur verstrichenen System-Zeit, skaliert
// auf die Anzahl der CPUs. Ohne beide Messungen (Container gerade erst
// gestartet, precpu_stats noch leer) gibt es keinen sinnvollen Wert.
function cpuPercentOf(raw: RawStats): number | null {
  const cpu = raw.cpu_stats;
  const precpu = raw.precpu_stats;
  if (!cpu?.cpu_usage || !precpu?.cpu_usage) return null;
  if (typeof cpu.system_cpu_usage !== "number" || typeof precpu.system_cpu_usage !== "number") return null;

  const cpuDelta = (cpu.cpu_usage.total_usage ?? 0) - (precpu.cpu_usage.total_usage ?? 0);
  const systemDelta = cpu.system_cpu_usage - precpu.system_cpu_usage;
  if (systemDelta <= 0) return 0;
  if (cpuDelta <= 0) return 0;

  const numberCpus = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  const percent = (cpuDelta / systemDelta) * numberCpus * 100;
  return Math.round(percent * 10) / 10;
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
