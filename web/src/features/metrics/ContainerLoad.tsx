import { useTranslations } from "use-intl";

import type { HostLoad } from "contract";

import { byteSize, useLanguage } from "../../platform/i18n";
import { LazySparkline } from "../../platform/ui/metrics/LazySparkline";
import { formatPercent, hasValues, loadCpuPoints, loadMemoryPoints } from "./metric-values";

// Die Last eines Arms DURCH SEINE CONTAINER auf der Host-Karte (#214,
// docs/design/management-aids.md §4.2).
//
// ⚠️ DIE BESCHRIFTUNG SAGT „DURCH CONTAINER" UND NICHT „HOST". Summiert wird,
// was der Agent sampelt; Prozesse außerhalb von Docker und Container außerhalb
// seiner Allowlist fehlen. Fremdverwaltete zählen seit #124 mit, ab Agent
// v0.31.0. Der Hinweis darunter sagt das in einem Satz.
//
// ⚠️ DIE ZAHL IST DIE SUMME DER CONTAINER-DETAILS, gerechnet im Server
// (`server/src/features/metrics/container-load.ts`). Diese Datei rechnet nichts
// nach: eine zweite Summe im Browser wiche beim ersten Sonderfall ab.

export function ContainerLoad({ hostId, load }: { hostId: string; load: HostLoad }) {
  const t = useTranslations();
  const { language } = useLanguage();
  const percent = (value: number): string => formatPercent(value, language);
  const cpu = loadCpuPoints(load.series);
  const memory = loadMemoryPoints(load.series);
  const bytes = (value: number): string => {
    const size = byteSize(value, language);
    return t(size.key, { value: size.value });
  };
  const memoryShown =
    load.memUsageBytes === null || load.memTotalBytes === null
      ? null
      : t("metricsMemoryOf", { used: bytes(load.memUsageBytes), total: bytes(load.memTotalBytes) });

  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3" data-testid={`host-load-${hostId}`}>
      <p className="flex items-baseline gap-2 text-[13px] font-medium">
        {t("hostLoadTitle")}
        <span className="text-xs font-normal text-subtle-foreground">{t("metricsHistory")}</span>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs text-subtle-foreground">{t("hostLoadCpu")}</p>
          <p className="font-mono text-[15px] tabular-nums" data-testid={`host-load-cpu-${hostId}`}>
            {load.cpuPercent === null ? (
              <span className="text-muted-foreground">{t("metricsUnavailable")}</span>
            ) : (
              percent(load.cpuPercent)
            )}
          </p>
          {hasValues(cpu) ? (
            <LazySparkline points={cpu} label={t("hostLoadCpuChart")} color="var(--chart-1)" max={100} format={percent} />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs text-subtle-foreground">{t("hostLoadMemory")}</p>
          <p className="font-mono text-[15px] tabular-nums" data-testid={`host-load-memory-${hostId}`}>
            {load.memPercent === null ? (
              <span className="text-muted-foreground">{t("metricsUnavailable")}</span>
            ) : (
              percent(load.memPercent)
            )}
          </p>
          {memoryShown === null ? null : <p className="text-xs text-muted-foreground">{memoryShown}</p>}
          {hasValues(memory) ? (
            <LazySparkline points={memory} label={t("hostLoadMemoryChart")} color="var(--chart-2)" max={100} format={percent} />
          ) : null}
        </div>
      </div>
      <p className="text-xs text-subtle-foreground">{t("hostLoadHint")}</p>
    </div>
  );
}
