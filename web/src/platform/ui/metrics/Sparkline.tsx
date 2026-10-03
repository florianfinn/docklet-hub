import { Line, LineChart, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../shadcn/chart";

// Ein Verlauf ohne Achsen — die letzten zehn Minuten einer Messgröße (#213,
// #214), gezeichnet mit dem shadcn-Baustein `chart`
// (docs/design/management-aids.md §4.1).
//
// ⚠️ `connectNulls={false}`: ein `null` ist beim Agenten „gerade nicht
// ermittelbar" und wird eine LÜCKE in der Linie. Eine Linie, die über die
// Lücke hinweg verbunden wird, behauptete Werte, die niemand gemessen hat;
// eine Null behauptete einen ruhigen Container.
//
// ⚠️ OHNE ANIMATION. Die Fläche fragt alle zehn Sekunden neu, und eine Linie,
// die bei jeder Antwort neu einfliegt, zeigt Bewegung, wo sich kaum etwas
// geändert hat.
//
// ⚠️ `data-points` trägt die Zahl der Messpunkte. Die Abnahme von #213
// („nach zehn Minuten 60 Werte") ist daran ablesbar, ohne die gezeichnete
// Linie auszuzählen.

export type SparklinePoint = { sampledAt: string; value: number | null };

export function Sparkline({
  points,
  label,
  color,
  max,
  format,
  testId
}: {
  points: readonly SparklinePoint[];
  // Was der Verlauf zeigt — für den Screenreader, der die Linie nicht sieht.
  label: string;
  // Eine Farbe aus der Palette, etwa `var(--chart-1)`.
  color: string;
  // Obergrenze der Skala; ohne sie folgt sie den Werten.
  max?: number;
  format: (value: number) => string;
  testId?: string;
}) {
  const config = { value: { label, color } } satisfies ChartConfig;
  return (
    <ChartContainer
      config={config}
      role="img"
      aria-label={label}
      data-testid={testId}
      data-points={points.length}
      className="aspect-auto h-12 w-full"
    >
      <LineChart data={[...points]} margin={{ top: 4, right: 0, bottom: 4, left: 0 }}>
        <XAxis dataKey="sampledAt" hide />
        <YAxis hide domain={[0, max ?? "auto"]} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel formatter={(value) => <span>{format(Number(value))}</span>} />}
        />
        <Line
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
