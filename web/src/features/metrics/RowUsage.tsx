import { useTranslations } from "use-intl";

import type { ContainerEntry } from "contract";

import { MeasurementStale } from "../../domain/hosts";
import { byteSize, useLanguage } from "../../platform/i18n";
import { formatPercent } from "./metric-values";

// CPU und RAM eines Containers als letzter Wert in seiner Zeile (#213). Der
// Verlauf steht im Detail; die Übersicht bekommt ihn gar nicht erst.
//
// ⚠️ EIN GESTOPPTER CONTAINER ZEIGT NICHTS — auch keine Null. Ein fehlender
// Einzelwert fehlt ebenso, statt als „0" dazustehen: `null` heißt beim
// Agenten „gerade nicht ermittelbar".
//
// ⚠️ Erst ab mittlerer Breite. Die Zeile trägt schon Punkt, Namen, Marken und
// den Statustext des Agenten; auf einem Telefon schöben zwei Zahlen mehr den
// Namen aus der Zeile.
export function RowUsage({ container, hostId }: { container: ContainerEntry; hostId?: string }) {
  const t = useTranslations();
  const { language } = useLanguage();
  if (!container.running || container.stats === null) return null;
  const { cpuPercent, memUsageBytes } = container.stats;
  if (cpuPercent === null && memUsageBytes === null) return null;

  const memory = memUsageBytes === null ? null : byteSize(memUsageBytes, language);
  return (
    <span
      className="hidden shrink-0 items-center gap-2 font-mono text-xs text-muted-foreground tabular-nums md:flex"
      title={t("metricsCpuHint")}
      data-testid={`container-usage-${container.name}`}
    >
      {cpuPercent === null ? null : <span>{t("metricsRowCpu", { value: formatPercent(cpuPercent, language) })}</span>}
      {memory === null ? null : <span>{t(memory.key, { value: memory.value })}</span>}
      <MeasurementStale hostId={hostId} sampledAt={container.stats.sampledAt} />
    </span>
  );
}
