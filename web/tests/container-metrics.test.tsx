// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Die Begründung samt Messung steht im Kopf von
// `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";

import type { ContainerEntry, ContainerStats, ContainerStatsSample } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import { ContainerMetrics, RowUsage } from "../src/features/metrics/index.js";
import { cpuPoints, formatPercent, hasValues } from "../src/features/metrics/metric-values.js";

// Die Abnahme von #213 am gezeichneten Baum:
//
//   1. Das Detail eines laufenden Containers zeigt nach zehn Minuten Laufzeit
//      des Agenten 60 Werte — ablesbar an `data-points` der Sparkline.
//   2. Ein gestoppter Container zeigt keinen Verlauf und keine Null. Geprüft
//      wird zusätzlich der AUSGEBLIEBENE AUFRUF: eine Fassung, die den Verlauf
//      holt und nur nicht zeichnet, fragte den Agenten trotzdem.
//   3. `null` ist „nicht ermittelbar" und nicht „0 %".
//
// NICHT geprüft: wie recharts die Linie zeichnet. Die Lücke bei `null`
// (`connectNulls={false}`) ist eine Eigenschaft der Bibliothek; geprüft wird
// hier, dass `null` bis dorthin `null` bleibt.

const HOST_ID = "host-1";
const CONTAINER_ID = "c1";

// ⚠️ DER TAKT DER FLÄCHE STEHT, BIS EIN FALL IHN WEITERDREHT. `ContainerMetrics`
// fragt alle zehn Sekunden nach (`REFRESH_MS`), und ein Fall, der „genau ein
// Abruf" zählt, zählte sonst gegen die Wanduhr. Gemessen am 2026-09-30 im
// vollen Lauf unter Last: der erste Fall brauchte 10,95 s bis zu seiner
// Prüfung, der Takt hatte einmal gefeuert, und der Fall fiel mit zwei Abrufen.
// Eingefroren wird nur `setInterval` — `settle()` und das Nachladen der
// Sparkline laufen über `setTimeout` und bleiben echt.
beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
afterEach(() => mock.timers.reset());

function samples(count: number, cpuPercent: number | null = 12.5): ContainerStatsSample[] {
  const start = Date.parse("2026-09-30T10:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    sampledAt: new Date(start + index * 10_000).toISOString(),
    cpuPercent,
    memUsageBytes: 64 * 1024 * 1024,
    memLimitBytes: 512 * 1024 * 1024
  }));
}

function statsOf(history: ContainerStatsSample[]): ContainerStats {
  const latest = history.at(-1);
  return {
    cpuPercent: latest?.cpuPercent ?? null,
    memUsageBytes: latest?.memUsageBytes ?? null,
    memLimitBytes: latest?.memLimitBytes ?? null,
    sampledAt: latest?.sampledAt ?? null,
    samples: history
  };
}

function stubStats(stats: ContainerStats | null): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ stats }), { status: 200, headers: { "content-type": "application/json" } })
    );
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// Die Sprache der Oberfläche folgt im Prüfstand der Browsersprache von
// happy-dom; geprüft wird deshalb gegen beide Fassungen, wie in
// `container-screen.test.tsx`.
function oneOf(shown: string, texts: string[]): boolean {
  return texts.some((text) => shown.includes(text));
}

function textAt(testId: string): string {
  return at(testId)?.textContent ?? "";
}

function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
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

async function mount(running: boolean) {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <ContainerMetrics hostId={HOST_ID} containerId={CONTAINER_ID} running={running} />
    </AppLanguageProvider>
  );
  await settle();
  return mounted;
}

test("ein laufender Container zeigt nach zehn Minuten 60 Werte", async () => {
  const server = stubStats(statsOf(samples(60)));
  const mounted = await mount(true);
  try {
    assert.deepEqual(server.calls, [`/api/hosts/${HOST_ID}/containers/${CONTAINER_ID}/stats`]);
    await untilCharts("[data-points]", 2);
    assert.equal(at("container-metrics-cpu-chart")?.getAttribute("data-points"), "60");
    assert.equal(at("container-metrics-memory-chart")?.getAttribute("data-points"), "60");
    const cpu = textAt("container-metrics-cpu-value");
    assert.ok(oneOf(cpu, [formatPercent(12.5, "de"), formatPercent(12.5, "en")]), `gesehen: ${cpu}`);
    // Der Nenner ist das Limit des Containers.
    const memory = textAt("container-metrics-memory-value");
    assert.ok(memory.includes("64") && memory.includes("512"), `gesehen: ${memory}`);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("nach zehn Sekunden fragt die Fläche ein zweites Mal", async () => {
  const server = stubStats(statsOf(samples(60)));
  const mounted = await mount(true);
  try {
    mock.timers.tick(9_999);
    await settle();
    assert.equal(server.calls.length, 1, "vor Ablauf des Takts kein zweiter Abruf");
    mock.timers.tick(1);
    await settle();
    assert.equal(server.calls.length, 2, "nach zehn Sekunden der zweite Abruf");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein gestoppter Container zeigt keinen Verlauf, keine Null und fragt nicht", async () => {
  const server = stubStats(statsOf(samples(60)));
  const mounted = await mount(false);
  try {
    assert.ok(at("container-metrics-stopped") !== null, "der Hinweis auf den gestoppten Container steht da");
    assert.ok(at("container-metrics-cpu-chart") === null, "kein Verlauf der CPU");
    assert.ok(at("container-metrics-memory-chart") === null, "kein Verlauf des RAM");
    assert.ok(!/\d/.test(textAt("container-metrics-stopped")), "keine Zahl, also auch keine Null");
    assert.deepEqual(server.calls, [], "ein gestoppter Container wird nicht gefragt");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein Wert, der nicht ermittelbar ist, heißt so und nicht 0 %", async () => {
  const server = stubStats(statsOf(samples(3, null)));
  const mounted = await mount(true);
  try {
    const cpu = textAt("container-metrics-cpu-value");
    assert.ok(oneOf(cpu, [de.metricsUnavailable, en.metricsUnavailable]), `gesehen: ${cpu}`);
    assert.ok(!/\d/.test(cpu), `keine Zahl, gesehen: ${cpu}`);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein Agent ohne Messwerte lässt die Fläche stehen", async () => {
  const server = stubStats(null);
  const mounted = await mount(true);
  try {
    assert.ok(at("container-metrics") !== null);
    assert.ok(at("container-metrics-cpu-chart") === null, "ohne Messpunkte keine Linie");
    assert.ok(oneOf(textAt("container-metrics-cpu-value"), [de.metricsUnavailable, en.metricsUnavailable]));
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("null bleibt in den Punkten der Sparkline null", () => {
  const points = cpuPoints([...samples(1, null), ...samples(1, 3)]);
  assert.deepEqual(
    points.map((point) => point.value),
    [null, 3]
  );
  assert.equal(hasValues(cpuPoints(samples(2, null))), false);
});

test("die CPU wird nicht gekappt: 250 % bleiben 250 %", () => {
  // `docker stats` misst je Kern; auf einem Vierkerner ist das ein gültiger Wert.
  assert.equal(formatPercent(250, "en"), "250%");
  assert.equal(formatPercent(2.5, "en"), "2.5%");
});

// ── Die Zeile der Übersicht ─────────────────────────────────────────────────

function entryOf(running: boolean, stats: ContainerStats | null): ContainerEntry {
  return {
    id: CONTAINER_ID,
    name: "immich",
    image: "demo:1",
    status: running ? "Up 2 hours" : "Exited (0) 3 minutes ago",
    running,
    startedAt: null,
    health: null,
    compose: null,
    stats,
    externalManagement: null
  };
}

async function row(entry: ContainerEntry) {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <RowUsage container={entry} />
    </AppLanguageProvider>
  );
  await settle();
  return mounted;
}

test("die Zeile zeigt den letzten Wert eines laufenden Containers", async () => {
  const mounted = await row(entryOf(true, { ...statsOf([]), cpuPercent: 12.5, memUsageBytes: 64 * 1024 * 1024 }));
  try {
    const shown = textAt("container-usage-immich");
    assert.ok(oneOf(shown, [formatPercent(12.5, "de"), formatPercent(12.5, "en")]), `gesehen: ${shown}`);
    assert.ok(shown.includes("64"), `gesehen: ${shown}`);
  } finally {
    await mounted.unmount();
  }
});

test("ein gestoppter Container und ein Container ohne Werte zeigen in der Zeile nichts", async () => {
  for (const entry of [
    entryOf(false, { ...statsOf([]), cpuPercent: 0, memUsageBytes: 0 }),
    entryOf(true, statsOf([])),
    entryOf(true, null)
  ]) {
    const mounted = await row(entry);
    try {
      assert.ok(at("container-usage-immich") === null, `gesehen bei ${JSON.stringify(entry.stats)}`);
    } finally {
      await mounted.unmount();
    }
  }
});

test("ein fehlender Einzelwert fehlt in der Zeile, statt als Null dazustehen", async () => {
  const mounted = await row(entryOf(true, { ...statsOf([]), cpuPercent: null, memUsageBytes: 2048 }));
  try {
    const shown = textAt("container-usage-immich");
    assert.ok(!shown.includes("CPU"), `gesehen: ${shown}`);
  } finally {
    await mounted.unmount();
  }
});

// ── Wechsel der Kennung und späte Antworten ─────────────────────────────────

test("eine neue Kennung unter demselben Namen zeigt nicht die Werte des alten Containers", async () => {
  // Nach einem `compose up` bleibt die Seite offen, die Kennung wechselt, und
  // die erste Anfrage für die neue scheitert (403 vor dem Abgleich).
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).includes("/containers/alt/")
        ? new Response(JSON.stringify({ stats: statsOf(samples(60)) }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        : new Response(JSON.stringify({ error: "agent-forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" }
          })
    )) as typeof fetch;
  let switchTo: (containerId: string) => void = () => undefined;
  function Switcher() {
    const [containerId, setContainerId] = React.useState("alt");
    switchTo = setContainerId;
    return <ContainerMetrics hostId={HOST_ID} containerId={containerId} running={true} />;
  }
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <Switcher />
    </AppLanguageProvider>
  );
  try {
    await settle();
    await untilCharts("[data-points]", 2);
    await React.act(async () => {
      switchTo("neu");
    });
    for (let round = 0; round < 10; round += 1) await settle();
    assert.ok(document.body.querySelector('[role="alert"]') !== null, "die Fehlermeldung steht da");
    assert.ok(document.body.querySelector("[data-points]") === null, "kein Verlauf des alten Containers");
    assert.ok(!/\d/.test(textAt("container-metrics-cpu-value")), "keine Zahl des alten Containers");
  } finally {
    await mounted.unmount();
    globalThis.fetch = original;
  }
});
