import { useTranslations } from "use-intl";

import { MeasurementStale } from "../../domain/hosts";
import { byteSize, useLanguage } from "../../platform/i18n";
import { LazySparkline } from "../../platform/ui/metrics/LazySparkline";
import { Card } from "../../platform/ui/shadcn/card";
import { cpuPoints, formatPercent, memoryPoints } from "./metric-values";
import { useContainerStats } from "./metrics-queries";

// CPU und RAM eines Containers mit den letzten zehn Minuten als Verlauf
// (#213, docs/design/management-aids.md §4.1).
//
// ⚠️ EIN GESTOPPTER CONTAINER BEKOMMT KEINE ANFRAGE, KEINEN VERLAUF UND KEINE
// NULL (Abnahme von #213). Der Agent misst ihn zwar weiter — mit `null`, weil
// es nichts zu messen gibt —, und sein Puffer trägt noch die Werte von vor dem
// Stopp. Beides gezeichnet sähe aus wie ein Container, der eben noch lief oder
// gerade nichts tut.
//
// ⚠️ DER TAKT IST DER DES AGENTEN: zehn Sekunden. Schneller zu fragen brächte
// keinen neuen Punkt, nur eine Anfrage mehr. Er steht in
// `metrics-queries.ts`, seit die Fläche über eine Abfrage lädt (#283).

export function ContainerMetrics({
  hostId,
  containerId,
  running
}: {
  hostId: string;
  containerId: string;
  running: boolean;
}) {
  const t = useTranslations();
  if (!running) {
    return (
      <Card className="gap-1 border-card-line bg-body-face p-4" data-testid="container-metrics-stopped">
        <p className="text-sm font-medium">{t("metricsTitle")}</p>
        <p className="text-[13px] text-muted-foreground">{t("metricsStopped")}</p>
      </Card>
    );
  }
  // ⚠️ `key` AN ARM UND KENNUNG. Die Seite findet ihren Container über den
  // Namen; nach einem `compose up` trägt derselbe Name eine neue Kennung,
  // und die Fläche bleibt offen. Ohne frisches Einhängen stünden die Werte
  // des alten Containers weiter da — schlägt die erste Anfrage für den neuen
  // fehl (etwa eine 403 vor dem Abgleich der Allowlist), sogar dauerhaft neben
  // der Fehlermeldung.
  return <LiveMetrics key={`${hostId}/${containerId}`} hostId={hostId} containerId={containerId} />;
}

function LiveMetrics({ hostId, containerId }: { hostId: string; containerId: string }) {
  const t = useTranslations();
  const { language } = useLanguage();
  // ⚠️ DER SCHLÜSSEL TRÄGT ARM UND KENNUNG: eine neue Kennung ist ein neuer
  // Eintrag ohne Daten, und ein Fehler dort steht nicht neben den Werten des
  // alten Containers. Eine ältere, langsamere Antwort überschreibt keine
  // jüngere: darum kümmert sich die Abfrage.
  const query = useContainerStats(hostId, containerId);
  const stats = query.data === undefined ? undefined : query.data.stats;
  const failed = query.isError;

  const bytes = (value: number): string => {
    const size = byteSize(value, language);
    return t(size.key, { value: size.value });
  };
  const percent = (value: number): string => formatPercent(value, language);
  const samples = stats?.samples ?? [];
  const limit = stats?.memLimitBytes ?? null;

  return (
    <Card className="gap-3 border-card-line bg-body-face p-4" data-testid="container-metrics">
      <p className="flex items-baseline gap-2 text-sm font-medium">
        {t("metricsTitle")}
        <MeasurementStale hostId={hostId} sampledAt={stats?.sampledAt ?? null} />
        <span className="text-xs font-normal text-subtle-foreground">{t("metricsHistory")}</span>
      </p>
      {failed ? (
        <p role="alert" className="text-[13px] text-destructive">
          {t("metricsFailed")}
        </p>
      ) : null}
      {stats === undefined && !failed ? <p className="text-[13px] text-muted-foreground">{t("loading")}</p> : null}
      {stats === undefined ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1" data-testid="container-metrics-cpu">
            <p className="text-[13px] text-subtle-foreground">
              {t("metricsCpu")} <span className="text-xs">({t("metricsCpuHint")})</span>
            </p>
            <p className="font-mono text-[15px] tabular-nums" data-testid="container-metrics-cpu-value">
              {stats?.cpuPercent == null ? (
                <span className="text-muted-foreground">{t("metricsUnavailable")}</span>
              ) : (
                percent(stats.cpuPercent)
              )}
            </p>
            {samples.length === 0 ? null : (
              <LazySparkline
                points={cpuPoints(samples)}
                label={t("metricsCpuChart")}
                color="var(--chart-1)"
                format={percent}
                testId="container-metrics-cpu-chart"
              />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1" data-testid="container-metrics-memory">
            <p className="text-[13px] text-subtle-foreground">{t("metricsMemory")}</p>
            <p className="font-mono text-[15px] tabular-nums" data-testid="container-metrics-memory-value">
              {stats?.memUsageBytes == null ? (
                <span className="text-muted-foreground">{t("metricsUnavailable")}</span>
              ) : limit === null ? (
                bytes(stats.memUsageBytes)
              ) : (
                t("metricsMemoryOf", { used: bytes(stats.memUsageBytes), total: bytes(limit) })
              )}
            </p>
            {samples.length === 0 ? null : (
              <LazySparkline
                points={memoryPoints(samples)}
                label={t("metricsMemoryChart")}
                color="var(--chart-2)"
                max={limit ?? undefined}
                format={bytes}
                testId="container-metrics-memory-chart"
              />
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
