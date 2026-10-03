import type { ContainerStatsSample, LoadPoint } from "contract";
import type { Language } from "../../platform/i18n/languages";

// Die Aufbereitung der Messwerte für die Oberfläche (#213, #214) — ohne
// Browser prüfbar, deshalb eine eigene Datei.
//
// ⚠️ `null` BLEIBT `null`. Beim Agenten heißt es „gerade nicht ermittelbar"
// und nicht null Prozent; die Sparkline zeichnet daraus eine Lücke. Wer hier
// ein `?? 0` einbaut, zeichnet einen ruhigen Container, wo keine Messung ist.

/** Ein Punkt der Sparkline. */
export type ChartPoint = { sampledAt: string; value: number | null };

export function cpuPoints(samples: readonly ContainerStatsSample[]): ChartPoint[] {
  return samples.map((sample) => ({ sampledAt: sample.sampledAt, value: sample.cpuPercent }));
}

export function memoryPoints(samples: readonly ContainerStatsSample[]): ChartPoint[] {
  return samples.map((sample) => ({ sampledAt: sample.sampledAt, value: sample.memUsageBytes }));
}

export function loadCpuPoints(series: readonly LoadPoint[]): ChartPoint[] {
  return series.map((point) => ({ sampledAt: point.sampledAt, value: point.cpuPercent }));
}

export function loadMemoryPoints(series: readonly LoadPoint[]): ChartPoint[] {
  return series.map((point) => ({ sampledAt: point.sampledAt, value: point.memPercent }));
}

/** Ob überhaupt ein Punkt einen Wert trägt — sonst gibt es nichts zu zeichnen. */
export function hasValues(points: readonly ChartPoint[]): boolean {
  return points.some((point) => point.value !== null);
}

/**
 * Ein Prozentwert in der Schreibweise der Sprache („12,5 %", „12.5%").
 *
 * ⚠️ OHNE OBERGRENZE. Die CPU eines Containers folgt `docker stats`, und dort
 * sind 250 % auf einem Vierkerner ein gültiger Wert. Gekappt wird nur die
 * Last durch Container, und das tut der Server.
 */
export function formatPercent(value: number, language: Language): string {
  return new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: value < 10 ? 1 : 0
  }).format(value / 100);
}
