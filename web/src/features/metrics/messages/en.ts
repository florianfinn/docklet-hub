// English texts of the feature `metrics` (#283). The reasons stand next to the
// German texts (`de.ts`); here is only the translation.
//
// `satisfies typeof deMetrics`: only on an object literal does TypeScript
// check for excess properties.

import type { deMetrics } from "./de";

export const enMetrics = {
  metricsTitle: "Usage",
  metricsHistory: "last 10 minutes",
  metricsCpu: "CPU",
  metricsCpuHint: "as in docker stats — 100 % per core",
  metricsMemory: "RAM",
  metricsMemoryOf: "{used} of {total}",
  metricsUnavailable: "not available",
  metricsStopped: "The container is not running — there is no history.",
  metricsFailed: "The metrics could not be loaded.",
  metricsCpuChart: "CPU over the last 10 minutes",
  metricsMemoryChart: "RAM over the last 10 minutes",
  metricsRowCpu: "CPU {value}",

  hostLoadTitle: "Load from containers",
  hostLoadCpu: "CPU from containers",
  hostLoadMemory: "RAM from containers",
  hostLoadHint: "Sum of the containers the agent measures — not the load of the whole host.",
  hostLoadCpuChart: "CPU from containers over the last 10 minutes",
  hostLoadMemoryChart: "RAM from containers over the last 10 minutes"
} satisfies typeof deMetrics;
