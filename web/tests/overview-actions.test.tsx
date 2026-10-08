import { renderInDom, settleQueries, waitFor } from "./dom-harness.js";
import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, Route, Routes } from "react-router";
import { DEFAULT_GLOBAL_THEME, DEFAULT_SELF_HEALING_CONFIG, type HostOverview, type Settings } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ContainerScreen } from "../src/app/screens/ContainerScreen.js";
import { ContainersScreen } from "../src/app/screens/ContainersScreen.js";
import { OverviewScreen } from "../src/app/screens/OverviewScreen.js";
import { StackScreen } from "../src/app/screens/StackScreen.js";
import { GlobalThemeProvider } from "../src/features/appearance/index.js";
import { LifecycleProvider } from "../src/features/containers/LifecycleProvider.js";
import { TooltipProvider } from "../src/platform/ui/shadcn/tooltip.js";
import { container, host, stack } from "./lifecycle-test-support.js";

// The overview and the container list show state and navigation only. Start,
// stop, restart, maintenance, update, restore and the self-healing lines belong
// to the container page and the stack page.

const HOST_ID = "demo-host";
const STACK_TARGET = { kind: "compose" as const, projectName: "demo", serviceName: "web" };

// One crashed stack container with a self-healing budget and a running loose
// container: every row kind of both lists carries lifecycle data.
function fixtureHost(): HostOverview {
  const current = host([container("exited", { exitCode: 1 })]);
  current.loose = [container("running", { id: "loose-id", name: "demo-loose", compose: null })];
  current.stacks = [stack(current.stacks[0]!.containers)];
  current.lifecycle!.selfHealing!.budgets = [{ target: STACK_TARGET, containerId: "demo-web-id", usedAttempts: 2, remainingAttempts: 1,
    attempts: [], nextAttemptAt: null, runningSince: null }];
  current.lifecycle!.selfHealing!.maintenance = [STACK_TARGET, { kind: "stack" as const, projectName: "demo" }].map((target) =>
    ({ target, actor: "user:demo-human", startedAt: "2026-10-07T01:00:00Z", expiresAt: null }));
  return current;
}

function stubHub(): () => void {
  const original = globalThis.fetch;
  const languages = Object.getOwnPropertyDescriptor(globalThis.navigator, "languages");
  Object.defineProperty(globalThis.navigator, "languages", { configurable: true, value: ["de"] });
  const json = (payload: unknown) => Response.json(payload);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/overview")) return json({ hosts: [fixtureHost()] });
    if (url.includes("/api/marks")) return json({ marks: [] });
    if (url.includes("/api/settings")) {
      const settings: Settings = { theme: DEFAULT_GLOBAL_THEME, runtime: { applyComposeDefinition: true },
        selfHealing: { config: DEFAULT_SELF_HEALING_CONFIG, revision: 1, hosts: [] }, logs: { tailLines: 500 },
        containers: { showSystem: false },
        network: { externalEndpoint: null, internalTarget: null, externalTarget: null, externalTargetUnreachable: false } };
      return json(settings);
    }
    if (url.includes("/jobs?")) return json({ active: [], recent: [] });
    if (url.includes("/update-settings")) return json({ startDeadlineSeconds: 120 });
    if (url.endsWith("/stats")) return json({ stats: null });
    if (url.includes("/logs-stream")) return new Response(new ReadableStream({ start() { /* stays open */ } }));
    return json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    if (languages) Object.defineProperty(globalThis.navigator, "languages", languages);
    else Reflect.deleteProperty(globalThis.navigator, "languages");
  };
}

async function mountAt(path: string, routes: React.ReactNode) {
  const restore = stubHub();
  const mounted = await renderInDom(
    <AppLanguageProvider><GlobalThemeProvider><TooltipProvider><LifecycleProvider role="admin">
      <MemoryRouter initialEntries={[path]}><Routes>{routes}</Routes></MemoryRouter>
    </LifecycleProvider></TooltipProvider></GlobalThemeProvider></AppLanguageProvider>
  );
  await settleQueries(mounted.queryClient);
  return { ...mounted, unmount: async () => { await mounted.unmount(); restore(); } };
}

const has = (selector: string) => document.querySelector(selector) !== null;
const count = (selector: string) => document.querySelectorAll(selector).length;
const shows = (text: string) => document.body.textContent?.includes(text) === true;

function assertNoActions() {
  assert.equal(has("[data-lifecycle]"), false, "no lifecycle controls");
  assert.equal(has("[data-action]"), false, "no start, stop or restart button");
  assert.equal(has("[data-update]"), false, "no update control");
  assert.equal(shows("Wartung"), false, "no maintenance control or notice");
  assert.equal(shows("Selbstheilungsbudget"), false, "no self-healing line");
  assert.equal(shows("abgestürzt"), false, "no crash line");
  assert.equal(shows("Daten wiederherstellen"), false, "no restore control");
}

async function expandStack() {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((entry) => entry.textContent?.includes("demo"));
  assert.equal(trigger !== undefined, true, "the stack row has a disclosure button");
  await React.act(async () => { trigger!.click(); });
  assert.equal(await waitFor(() => has('[data-testid="container-open-demo-web"]')), true, "the stack's container row is shown");
}

test("the overview shows stacks and containers without actions or self-healing lines", async () => {
  const view = await mountAt("/", <Route path="/" element={<OverviewScreen role="admin" />} />);
  try {
    await expandStack();
    assert.equal(has('[data-testid="container-open-demo-loose"]'), true, "the loose container row is shown");
    assertNoActions();
  } finally { await view.unmount(); }
});

test("the container list shows stacks and containers without actions or self-healing lines", async () => {
  const view = await mountAt("/", <Route path="/" element={<ContainersScreen role="admin" />} />);
  try {
    assert.equal(await waitFor(() => has('[data-testid="container-open-demo-web"]')), true, "the stack's container row is shown");
    assert.equal(has('[data-testid="container-open-demo-loose"]'), true, "the loose container row is shown");
    assertNoActions();
  } finally { await view.unmount(); }
});

test("the container page offers every action and the self-healing status", async () => {
  const view = await mountAt(`/container/${HOST_ID}/demo-web`, <Route path="/container/:hostId/:name" element={<ContainerScreen tab="overview" />} />);
  try {
    assert.equal(await waitFor(() => has("[data-lifecycle]")), true, "the lifecycle controls are rendered");
    assert.equal(count("[data-lifecycle]"), 1);
    assert.deepEqual(["start", "stop", "restart"].map((kind) => has(`[data-action="${kind}"]`)), [true, true, true]);
    assert.equal(has("[data-update]"), true, "update control");
    assert.equal(shows("Wartung ausschalten"), true, "maintenance control");
    assert.equal(shows("Daten wiederherstellen"), true, "restore control");
    assert.equal(shows("Selbstheilungsbudget"), true, "self-healing budget line");
    assert.equal(shows("abgestürzt · Exit-Code 1"), true, "crash line");
  } finally { await view.unmount(); }
});

test("the stack page offers every action and the self-healing status once, not per container row", async () => {
  const view = await mountAt(`/stack/${HOST_ID}/demo`, <Route path="/stack/:hostId/:project" element={<StackScreen role="admin" tab="overview" />} />);
  try {
    assert.equal(await waitFor(() => has("[data-lifecycle]")), true, "the lifecycle controls are rendered");
    assert.equal(has('[data-testid="container-open-demo-web"]'), true, "the container row is listed");
    assert.equal(count("[data-lifecycle]"), 1);
    assert.deepEqual(["start", "stop", "restart"].map((kind) => has(`[data-action="${kind}"]`)), [true, true, true]);
    assert.equal(has("[data-update]"), true, "update control");
    assert.equal(shows("Wartung ausschalten"), true, "maintenance control");
    assert.equal(shows("Selbstheilungsbudget"), true, "self-healing budget line");
  } finally { await view.unmount(); }
});
