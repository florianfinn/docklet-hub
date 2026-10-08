import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
// Die Container des Leitstands selbst (Hub, Agenten): in Übersicht und
// Container-Fläche nach Vorgabe ausgeblendet, im Reiter „Hub & Agenten" der
// Einstellungen immer sichtbar.
//
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell
// (`React.createElement`). Begründung im Kopf von `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRouter } from "react-router";

import { DEFAULT_GLOBAL_THEME } from "contract";

import type { HostOverview, OverviewContainer, Settings, StackView } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ContainersScreen } from "../src/app/screens/ContainersScreen.js";
import { SettingsScreen } from "../src/app/screens/SettingsScreen.js";
import { scopeHosts } from "../src/features/containers/container-filter.js";
import { SETTINGS_TABS } from "../src/app/settings/settings-tabs.js";

void React;

function containerOf(name: string, project: string | null, system: boolean): OverviewContainer {
  return {
    id: `id-${name}`,
    name,
    image: system ? "ghcr.io/example/docklet-hub-agent:v0.32.0" : "demo:latest",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: project === null ? null : { project, service: name },
    stats: null,
    externalManagement: null,
    state: "ok",
    marks: [],
    system
  };
}

function stackOf(project: string, system: boolean, names: string[]): StackView {
  const containers = names.map((name) => containerOf(name, project, system));
  return {
    project,
    state: "ok",
    running: containers.length,
    marks: [],
    indent: "nested",
    total: containers.length,
    hidden: false,
    system,
    containers
  };
}

function hostOf(id: string, stacks: StackView[], loose: OverviewContainer[]): HostOverview {
  return {
    host: {
      id,
      name: `arm-${id}`,
      agentUrl: "https://agent.test",
      kind: "internal",
      state: "registered",
      status: "online",
      agentVersion: "0.30.0",
      tunnelAddress: null,
      display: { hue: "neutral", ink: "edge" },
      agentUpdate: null,
      lastSeenAt: null
    },
    agent: { reachable: true, version: "0.30.0", contractVersion: null, readOnly: false, entries: null },
    stacks,
    loose,
    error: null
  };
}

// Ein Arm mit einem eigenen Stack und dem Agenten daneben, ein zweiter, auf
// dem NUR der Agent läuft.
const HOSTS: HostOverview[] = [
  hostOf(
    "h1",
    [stackOf("website", false, ["web-app"]), stackOf("docklet-hub-agent-nas", true, ["agent-main", "watcher-main"])],
    [containerOf("loose-tool", null, false)]
  ),
  hostOf("h2", [stackOf("docklet-hub-agent-nas", true, ["agent-bare"])], [])
];

function stubHub(showSystem: boolean): () => void {
  const original = globalThis.fetch;
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts: HOSTS }));
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks: [] }));
    if (url.includes("/api/settings")) {
      // A complete wire shape: every reader of `/api/settings` parses it against the
      // contract since #248.
      const settings: Settings = {
        theme: DEFAULT_GLOBAL_THEME,
        runtime: { applyComposeDefinition: true },
        selfHealing: { config: DEFAULT_SELF_HEALING_CONFIG, revision: 1, hosts: [] },
        logs: { tailLines: 500 },
        containers: { showSystem },
        network: { externalEndpoint: null, internalTarget: null, externalTarget: null, externalTargetUnreachable: false }
      };
      return Promise.resolve(json(settings));
    }
    return Promise.reject(new Error(`unerwartete Anfrage: ${url}`));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("scopeHosts trennt Leitstand und Rest und zählt, was ausgeblendet ist", () => {
  const workload = scopeHosts(HOSTS, "workload");
  assert.deepEqual(
    workload[0].stacks.map((stack) => stack.project),
    ["website"]
  );
  assert.deepEqual(
    workload[0].loose.map((container) => container.name),
    ["loose-tool"]
  );
  assert.equal(workload[0].hidden, 2);
  assert.equal(workload[1].stacks.length, 0);
  assert.equal(workload[1].hidden, 1);

  const system = scopeHosts(HOSTS, "system");
  assert.deepEqual(
    system[0].stacks.map((stack) => stack.project),
    ["docklet-hub-agent-nas"]
  );
  assert.equal(system[0].loose.length, 0);

  const all = scopeHosts(HOSTS, "all");
  assert.equal(all[0].stacks.length, 2);
  assert.equal(all[0].hidden, 0);
});

test("ein Container ohne Feld „system“ (älterer Hub) gilt nicht als Leitstand", () => {
  const legacy = containerOf("old", null, false) as Partial<OverviewContainer>;
  delete legacy.system;
  const [scoped] = scopeHosts([hostOf("h3", [], [legacy as OverviewContainer])], "workload");
  assert.equal(scoped.loose.length, 1);
});

async function mountContainers(showSystem: boolean) {
  const restore = stubHub(showSystem);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <ContainersScreen role="admin" />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  await settle();
  await settle();
  return { ...mounted, restore };
}

test("die Container-Fläche blendet Hub und Agenten nach Vorgabe aus", async () => {
  const { container, unmount, restore } = await mountContainers(false);
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("web-app"), "der eigene Stack steht da");
    assert.ok(text.includes("loose-tool"), "der Einzelgänger steht da");
    assert.ok(!text.includes("agent-main"), "der Agent ist ausgeblendet");
    assert.ok(!text.includes("agent-bare"), "auch auf dem zweiten Arm");
    // Der zweite Arm meldet NICHT „Kein Container freigegeben", sondern dass
    // ausgeblendet ist.
    assert.match(text, /ausgeblendet|hidden/);
  } finally {
    await unmount();
    restore();
  }
});

test("mit der Einstellung zeigt die Container-Fläche Hub und Agenten", async () => {
  const { container, unmount, restore } = await mountContainers(true);
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("web-app"));
    assert.ok(text.includes("agent-main"));
    assert.ok(text.includes("agent-bare"));
  } finally {
    await unmount();
    restore();
  }
});

async function mountSettings(search: string) {
  const restore = stubHub(false);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter initialEntries={[`/settings${search}`]}>
        <SettingsScreen role="admin" language="de" onLanguageChange={() => undefined} />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  await settle();
  await settle();
  return { ...mounted, restore };
}

test("der Reiter „Hub & Agenten“ zeigt nur die Container des Leitstands — unabhängig von der Einstellung", async () => {
  const { container, unmount, restore } = await mountSettings("?tab=system");
  try {
    const text = container.textContent ?? "";
    assert.ok(text.includes("agent-main"));
    assert.ok(text.includes("agent-bare"));
    assert.ok(!text.includes("web-app"), "kein Container außerhalb des Leitstands");
    const current = container.querySelector('[aria-current="page"]');
    assert.ok(current !== null, "ein Reiter ist als aktiv markiert");
    assert.equal(current.getAttribute("data-testid"), "settings-tab-system");
  } finally {
    await unmount();
    restore();
  }
});

test("jeder Reiter der Liste steht in der Leiste, ein unbekannter Kenner landet auf dem ersten", async () => {
  const { container, unmount, restore } = await mountSettings("?tab=gibt-es-nicht");
  try {
    for (const tab of SETTINGS_TABS) {
      assert.ok(
        container.querySelector(`[data-testid="settings-tab-${tab.id}"]`) !== null,
        `Reiter „${tab.id}“ fehlt in der Leiste`
      );
    }
    const current = container.querySelector('[aria-current="page"]');
    assert.ok(current !== null);
    assert.equal(current.getAttribute("data-testid"), `settings-tab-${SETTINGS_TABS[0].id}`);
  } finally {
    await unmount();
    restore();
  }
});
