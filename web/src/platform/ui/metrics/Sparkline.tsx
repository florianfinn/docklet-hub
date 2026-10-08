import { Line, LineChart, XAxis, YAxis } from "recharts";

import { isolatedPointIndices } from "./isolated-points";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../shadcn/chart";

// Null samples remain gaps; isolated valid samples need a dot to be visible.
// Animation stays disabled for the periodically refreshed series.
// `data-points` exposes the sample count for acceptance checks.

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
  // Accessible description of the series.
  label: string;
  // Palette color, e.g. `var(--chart-1)`.
  color: string;
  // Optional upper bound; otherwise the scale follows the values.
  max?: number;
  format: (value: number) => string;
  testId?: string;
}) {
  const isolatedIndices = isolatedPointIndices(points.map((point) => point.value));
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
          dot={({ index, cx, cy }) =>
            isolatedIndices.has(index) && cx != null && cy != null
              ? <circle key={index} cx={cx} cy={cy} r={2} fill="var(--color-value)" />
              : null
          }
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
