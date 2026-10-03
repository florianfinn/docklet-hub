// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — die
// Begründung steht im Kopf von `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import type { DockerHost } from "../src/domain/hosts/index.js";
import type { HostLoad } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import type { HostCounters } from "../src/domain/hosts/index.js";
import { HostCard } from "../src/features/hosts/HostCard.js";
import { ContainerLoad } from "../src/features/metrics/index.js";
import { formatPercent } from "../src/features/metrics/metric-values.js";

// WAS DIESE DATEI PRÜFT (#214)
//
// Die Host-Karte zeigt CPU und RAM DURCH CONTAINER — mit genau dieser
// Beschriftung, denn die Summe ist nicht die Last des Hosts. Die Zahl kommt
// fertig vom Server (`server/src/features/metrics/container-load.ts`, dort ist die
// Summe gegen die Container-Details geprüft); hier wird nur geprüft, dass die
// Karte sie zeigt und ohne sie nichts erfindet.

function hostOf(): DockerHost {
  return {
    id: "host-1",
    name: "hub",
    agentUrl: "http://docker-agent:8099",
    kind: "local",
    state: "registered",
    status: "online",
    agentVersion: "0.30.0",
    tunnelAddress: null,
    display: { hue: "neutral", ink: "head" },
    agentUpdate: null,
    lastSeenAt: null
  };
}

const LOAD: HostLoad = {
  cpuPercent: 40,
  memPercent: 50,
  memUsageBytes: 512 * 1024 * 1024,
  cpuCores: 4,
  memTotalBytes: 1024 * 1024 * 1024,
  series: [
    { sampledAt: "2026-09-30T10:00:00.000Z", cpuPercent: 35, memPercent: 49 },
    { sampledAt: "2026-09-30T10:00:10.000Z", cpuPercent: null, memPercent: null },
    { sampledAt: "2026-09-30T10:00:20.000Z", cpuPercent: 40, memPercent: 50 }
  ]
};

function textOf(testId: string): string {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element instanceof HTMLElement, `„${testId}" steht nicht im Dokument`);
  return element.textContent ?? "";
}

/**
 * Wartet, bis die nachgeladene Sparkline steht (`platform/ui/metrics/LazySparkline.tsx`).
 *
 * ⚠️ Mit eigener Frist und mit einer Meldung: ein `settle()` allein reicht
 * nicht, das Nachladen braucht mehrere Umläufe. Ohne Frist hinge eine Fassung,
 * die die Linie nie zeichnet, bis zum Ende des Laufs.
 */
async function untilCharts(selector: string, count: number): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    if (document.body.querySelectorAll(selector).length >= count) return;
    await settle();
  }
  assert.fail(`nach 200 Umläufen stehen keine ${count} Verläufe unter „${selector}“`);
}

async function card(counters: HostCounters) {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCard
        host={hostOf()}
        role="user"
        counters={counters}
        onRemoved={() => {}}
        onAgentUpdated={() => {}}
        renderLoad={(hostId, load) => <ContainerLoad hostId={hostId} load={load} />}
      />
    </AppLanguageProvider>
  );
  await settle();
  return mounted;
}

const SUMMARY = { stacks: 1, containers: 2, running: 2 };

test("die Host-Karte zeigt CPU und RAM durch Container", async () => {
  const mounted = await card({ state: "ready", summary: SUMMARY, load: LOAD });
  try {
    const panel = textOf("host-load-host-1");
    assert.ok(
      [de.hostLoadCpu, en.hostLoadCpu].some((label) => panel.includes(label)),
      `die Beschriftung sagt „durch Container“, gesehen: ${panel}`
    );
    const cpu = textOf("host-load-cpu-host-1");
    assert.ok(cpu === formatPercent(40, "de") || cpu === formatPercent(40, "en"), `gesehen: ${cpu}`);
    const memory = textOf("host-load-memory-host-1");
    assert.ok(memory === formatPercent(50, "de") || memory === formatPercent(50, "en"), `gesehen: ${memory}`);
    // Beide Verläufe tragen alle drei Wellen, die Lücke eingeschlossen.
    await untilCharts('[data-testid="host-load-host-1"] [data-points]', 2);
    const charts = [...document.body.querySelectorAll('[data-testid="host-load-host-1"] [data-points]')];
    assert.deepEqual(
      charts.map((chart) => chart.getAttribute("data-points")),
      ["3", "3"]
    );
  } finally {
    await mounted.unmount();
  }
});

test("ohne gerechnete Last zeigt die Karte keine — und keine Null", async () => {
  for (const counters of [
    { state: "ready", summary: SUMMARY, load: null },
    { state: "loading" },
    { state: "unavailable" }
  ] satisfies HostCounters[]) {
    const mounted = await card(counters);
    try {
      assert.ok(
        document.body.querySelector('[data-testid="host-load-host-1"]') === null,
        `bei ${JSON.stringify(counters)} steht keine Last da`
      );
    } finally {
      await mounted.unmount();
    }
  }
});

test("eine Last, die nicht ermittelbar ist, heißt so und nicht 0 %", async () => {
  const mounted = await card({
    state: "ready",
    summary: SUMMARY,
    load: { ...LOAD, cpuPercent: null, series: LOAD.series.map((point) => ({ ...point, cpuPercent: null })) }
  });
  try {
    const cpu = textOf("host-load-cpu-host-1");
    assert.ok(cpu === de.metricsUnavailable || cpu === en.metricsUnavailable, `gesehen: ${cpu}`);
    await untilCharts('[data-testid="host-load-host-1"] [data-points]', 1);
    // Noch ein paar Umläufe, damit eine zweite Linie Zeit hätte zu erscheinen.
    for (let round = 0; round < 10; round += 1) await settle();
    const charts = document.body.querySelectorAll('[data-testid="host-load-host-1"] [data-points]');
    assert.equal(charts.length, 1, "ohne einen einzigen CPU-Wert keine CPU-Linie, der RAM bleibt");
  } finally {
    await mounted.unmount();
  }
});
