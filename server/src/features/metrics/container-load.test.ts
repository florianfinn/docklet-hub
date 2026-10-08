import test from "node:test";
import assert from "node:assert/strict";

import type { ContainerOverviewEntry, ContainerStatsSample } from "../../domain/containers/index.js";
import { hostLoad, loadSeries, SAMPLE_CAPACITY } from "./container-load.js";

// Die Last eines Arms durch seine Container (#214). Geprüft ohne Agenten: die
// Messpunkte kommen als Werte herein, so wie `parseContainerList` sie liefert.

const INFO = { cpuCores: 4, memTotalBytes: 1_000 };
const T0 = Date.parse("2026-09-30T10:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function sample(offsetMs: number, cpuPercent: number | null, memUsageBytes: number | null): ContainerStatsSample {
  return { sampledAt: at(offsetMs), cpuPercent, memUsageBytes, memLimitBytes: null };
}

function container(
  id: string,
  samples: ContainerStatsSample[],
  overrides: Partial<ContainerOverviewEntry> = {}
): ContainerOverviewEntry {
  const latest = samples.at(-1);
  return {
    id,
    name: id,
    image: "example:1",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: null,
    stats: {
      cpuPercent: latest?.cpuPercent ?? null,
      memUsageBytes: latest?.memUsageBytes ?? null,
      memLimitBytes: null,
      sampledAt: latest?.sampledAt ?? null,
      samples
    },
    externalManagement: null,
    ...overrides
  };
}

test("die Zahl ist die Summe der letzten Werte, auf Kerne und Speicher umgerechnet", () => {
  const load = hostLoad(
    [container("a", [sample(0, 100, 200)]), container("b", [sample(1_000, 60, 300)])],
    INFO
  );
  assert.ok(load !== null);
  // (100 + 60) % über 4 Kerne = 40 %; (200 + 300) von 1000 Bytes = 50 %.
  assert.equal(load.cpuPercent, 40);
  assert.equal(load.memPercent, 50);
  assert.equal(load.memUsageBytes, 500);
});

test("die Zahl stimmt mit der Summe der Container-Details überein, auch wenn einer in der letzten Welle fehlt", () => {
  // Container „b" hat in der jüngsten Welle keinen Punkt; sein Detail zeigt
  // trotzdem seinen letzten Wert (80), und die Zahl folgt dem Detail.
  const a = container("a", [sample(0, 40, 100), sample(10_000, 40, 100)]);
  const b = container("b", [sample(0, 80, 100)]);
  const load = hostLoad([a, b], INFO);
  assert.equal(load?.cpuPercent, (40 + 80) / 4);
  const details = [a, b].reduce((sum, entry) => sum + (entry.stats?.cpuPercent ?? 0), 0);
  assert.equal(load?.cpuPercent, details / INFO.cpuCores);
});

test("ein gestoppter Container zählt nicht mit — sein Detail zeigt auch keinen Wert", () => {
  const load = hostLoad(
    [container("a", [sample(0, 40, 100)]), container("b", [sample(0, 400, 900)], { running: false })],
    INFO
  );
  assert.equal(load?.cpuPercent, 10);
  assert.equal(load?.memPercent, 10);
});

test("die CPU wird bei 100 % gekappt", () => {
  // A 500 % outlier on four cores must be capped at 100 %.
  const load = hostLoad([container("a", [sample(0, 500, 1)])], INFO);
  assert.equal(load?.cpuPercent, 100);
  assert.equal(load?.series[0].cpuPercent, 100);
});

test("ohne Ausstattung gibt es keinen Nenner und damit keine Last", () => {
  assert.equal(hostLoad([container("a", [sample(0, 1, 1)])], null), null);
  const load = hostLoad([container("a", [sample(0, 1, 1)])], { cpuCores: null, memTotalBytes: 1_000 });
  assert.equal(load?.cpuPercent, null, "ohne Kerne keine CPU, aber …");
  assert.equal(load?.memPercent, 0.1, "… der Speicher steht trotzdem");
});

test("ohne jeden Messwert ist die Last null und nicht null Prozent", () => {
  const load = hostLoad([container("a", [sample(0, null, null)])], INFO);
  assert.equal(load?.cpuPercent, null);
  assert.equal(load?.memPercent, null);
  assert.deepEqual(
    load?.series.map((point) => point.cpuPercent),
    [null]
  );
});

test("summiert wird je Welle, auch wenn die Punkte einer Welle über eine volle Zehnersekunde streuen", () => {
  // Eine Welle bei :04,8 und :05,3 — auf die volle Uhrzeit gerundet zerfiele
  // sie in zwei Wellen. An der Zeitlinie erkannt bleibt sie eine.
  const a = container("a", [sample(-5_200, 20, 100), sample(4_800, 20, 100)]);
  const b = container("b", [sample(-4_700, 20, 100), sample(5_300, 20, 100)]);
  const series = loadSeries([a, b], INFO);
  assert.equal(series.length, 2);
  assert.deepEqual(
    series.map((point) => point.cpuPercent),
    [10, 10]
  );
  assert.deepEqual(
    series.map((point) => point.memPercent),
    [20, 20]
  );
});

test("eine ausgelassene Welle ist eine Lücke und keine Null", () => {
  const series = loadSeries([container("a", [sample(0, 40, 100), sample(20_000, 40, 100)])], INFO);
  assert.deepEqual(
    series.map((point) => point.cpuPercent),
    [10, null, 10]
  );
  assert.deepEqual(
    series.map((point) => point.sampledAt),
    [at(0), at(10_000), at(20_000)]
  );
});

test("zwei Punkte desselben Containers sind zwei Wellen und nie eine doppelte Summe", () => {
  // Nur zwei Sekunden auseinander, und trotzdem nicht dieselbe Welle: ein
  // Container hat je Welle genau einen Punkt.
  const series = loadSeries([container("a", [sample(0, 40, 100), sample(2_000, 80, 100)])], INFO);
  assert.deepEqual(
    series.map((point) => point.cpuPercent),
    [10, 20]
  );
});

test("eine Welle, die über mehr als eine halbe Taktlänge streut, bleibt eine", () => {
  // Stempel bei 0, 4 und 8 s — je vier Sekunden Abstand, also unter der
  // halben Taktlänge. Die nächste Welle beginnt, sobald „a“ wieder dran ist.
  const series = loadSeries(
    [
      container("a", [sample(0, 20, 100), sample(10_000, 20, 100)]),
      container("b", [sample(4_000, 20, 100), sample(14_000, 20, 100)]),
      container("c", [sample(8_000, 20, 100), sample(18_000, 20, 100)])
    ],
    INFO
  );
  assert.deepEqual(
    series.map((point) => point.cpuPercent),
    [15, 15]
  );
});

test("eine noch laufende jüngste Welle fällt heraus und drückt den letzten Punkt nicht", () => {
  // Der Hub liest mitten in der Welle bei 10 s: „a“ ist schon gemessen,
  // „b“ und „c“ noch nicht. Ihre Teilsumme wäre ein Drittel der Last.
  const series = loadSeries(
    [
      container("a", [sample(0, 40, 100), sample(10_000, 40, 100)]),
      container("b", [sample(500, 40, 100)]),
      container("c", [sample(1_000, 40, 100)])
    ],
    INFO
  );
  assert.deepEqual(
    series.map((point) => point.cpuPercent),
    [30]
  );
});

test("ein neuer Container nur in der jüngsten Welle macht sie nicht unvollständig", () => {
  const series = loadSeries(
    [
      container("a", [sample(0, 40, 100), sample(10_000, 40, 100)]),
      container("neu", [sample(10_500, 40, 100)])
    ],
    INFO
  );
  assert.deepEqual(
    series.map((point) => point.cpuPercent),
    [10, 20]
  );
});

test("der Verlauf reicht höchstens zehn Minuten zurück", () => {
  const samples = Array.from({ length: SAMPLE_CAPACITY + 5 }, (_, index) => sample(index * 10_000, 4, 10));
  const series = loadSeries([container("a", samples)], INFO);
  assert.equal(series.length, SAMPLE_CAPACITY);
  assert.equal(series.at(-1)?.sampledAt, at((SAMPLE_CAPACITY + 4) * 10_000));
});

test("ohne Messpunkte gibt es keinen Verlauf", () => {
  assert.deepEqual(loadSeries([container("a", [])], INFO), []);
  assert.deepEqual(loadSeries([container("a", [], { stats: null })], INFO), []);
});
