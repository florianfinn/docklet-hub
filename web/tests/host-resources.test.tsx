// ⚠️ The order of the imports matters: the DOM must stand before React loads
// (see `dom-harness.tsx`).
import { renderInDom, settle, waitFor } from "./dom-harness.js";

// ⚠️ React by name although no line calls it: `tsx` compiles the JSX of this
// file with the classic runtime (see the head of `language-switch.test.tsx`).
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router";

import assert from "node:assert/strict";
import test from "node:test";

import type { HostResourcesView, ResourceUser } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import { HostResourcesScreen } from "../src/app/screens/HostResourcesScreen.js";
import { isShared, usageState } from "../src/features/resources/resource-values.js";

// The acceptance of #10 at the drawn tree:
//
//   1. Usage, sharing and the marks of hub and agent are visible per item.
//   2. A section that could not be read says so; the others stay readable.
//   3. Unknown usage is shown as unknown, never as unused.
//   4. The page only reads: every request it makes is a GET to the one route.

const HOST_ID = "host-1";

const SHOP: ResourceUser = { name: "shop-web-1", running: true, image: "example/web:1.2.0", composeProject: "shop" };
const WORKER: ResourceUser = { name: "shop-worker-1", running: false, image: "example/web:1.2.0", composeProject: "shop" };

const RESOURCES: HostResourcesView = {
  readAt: "2026-10-04T12:00:00.000Z",
  storage: {
    ok: true,
    summary: {
      images: { count: 2, sizeBytes: 900 * 1024 * 1024, unusedBytes: 300 * 1024 * 1024 },
      containers: { count: 2, sizeBytes: 2048, unusedBytes: 1024 },
      volumes: { count: 2, sizeBytes: null, unusedBytes: null },
      buildCache: { count: 0, sizeBytes: null, unusedBytes: null }
    }
  },
  usage: { ok: true },
  images: {
    ok: true,
    items: [
      {
        id: "sha256:" + "a".repeat(64),
        tags: ["example/web:1.2.0"],
        sizeBytes: 600 * 1024 * 1024,
        sharedSizeBytes: 0,
        createdAt: null,
        usedBy: [SHOP, WORKER],
        system: false
      },
      {
        id: "sha256:" + "b".repeat(64),
        tags: [],
        sizeBytes: 300 * 1024 * 1024,
        sharedSizeBytes: null,
        createdAt: null,
        usedBy: [],
        system: false
      }
    ]
  },
  volumes: {
    ok: true,
    items: [
      { name: "docklet-hub_db", driver: "local", scope: "local", anonymous: false, composeProject: "docklet-hub", sizeBytes: null, usedBy: [], system: true },
      { name: "shop_data", driver: "local", scope: "local", anonymous: false, composeProject: "shop", sizeBytes: 4096, usedBy: [SHOP], system: false }
    ]
  },
  networks: { ok: false, reason: "engine-timeout" }
};

type Answer = { status: number; body: unknown };

function stubHub(answer: Answer): { calls: Array<{ url: string; method: string }>; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const body = url === "/api/hosts" ? { hosts: [] } : answer.body;
    const status = url === "/api/hosts" ? 200 : answer.status;
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function at(selector: string): HTMLElement | null {
  const element = document.body.querySelector(selector);
  return element instanceof HTMLElement ? element : null;
}

function textOf(selector: string): string {
  return at(selector)?.textContent ?? "";
}

function oneOf(shown: string, keys: Array<keyof typeof de>): boolean {
  return keys.every((key) => shown.includes(de[key]) || shown.includes(en[key]));
}

async function mount(role: "admin" | "user") {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter initialEntries={[`/hosts/${HOST_ID}/resources`]}>
        <Routes>
          <Route path="/hosts/:hostId/resources" element={<HostResourcesScreen role={role} />} />
        </Routes>
      </MemoryRouter>
    </AppLanguageProvider>
  );
  await settle();
  return mounted;
}

test("shows usage, sharing and the hub's own resources per item", async () => {
  const hub = stubHub({ status: 200, body: { resources: RESOURCES } });
  const mounted = await mount("admin");
  try {
    assert.equal(await waitFor(() => at('[data-testid="resources-images"] table') !== null), true);
    const used = textOf('[data-resource="sha256:' + "a".repeat(64) + '"]');
    assert.ok(oneOf(used, ["resourcesMarkInUse", "resourcesMarkShared"]), `seen: ${used}`);
    assert.ok(used.includes("shop-web-1"));
    const untagged = textOf('[data-resource="sha256:' + "b".repeat(64) + '"]');
    assert.ok(oneOf(untagged, ["resourcesMarkUnused", "resourcesMarkUntagged"]), `seen: ${untagged}`);
    const hubVolume = textOf('[data-resource="docklet-hub_db"]');
    assert.ok(oneOf(hubVolume, ["resourcesMarkSystem", "resourcesMarkUnused", "resourcesSizeUnknown"]), `seen: ${hubVolume}`);
    // The warning that unused is not the same as unimportant.
    assert.ok(oneOf(textOf('[data-testid="resources-volumes"]'), ["resourcesVolumesHint"]));
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("a failed section names its reason and the others stay readable", async () => {
  const hub = stubHub({ status: 200, body: { resources: RESOURCES } });
  const mounted = await mount("admin");
  try {
    assert.equal(await waitFor(() => at('[data-testid="resources-networks"] [role="alert"]') !== null), true);
    assert.ok(oneOf(textOf('[data-testid="resources-networks"]'), ["resourcesReasonTimeout"]));
    assert.equal(at('[data-testid="resources-images"] [role="alert"]') === null, true);
    assert.equal(at('[data-testid="resources-storage-images"]') !== null, true);
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("unknown usage is never shown as unused", async () => {
  const unknown: HostResourcesView = {
    ...RESOURCES,
    usage: { ok: false, reason: "engine-unreachable" },
    images: { ok: true, items: RESOURCES.images.ok ? RESOURCES.images.items.map((image) => ({ ...image, usedBy: null })) : [] }
  };
  const hub = stubHub({ status: 200, body: { resources: unknown } });
  const mounted = await mount("admin");
  try {
    assert.equal(await waitFor(() => at('[data-testid="resources-usage-unknown"]') !== null), true);
    const states = [...document.body.querySelectorAll('[data-testid="resources-images"] [data-usage]')].map((element) =>
      element.getAttribute("data-usage")
    );
    assert.deepEqual(states, ["unknown", "unknown"]);
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("the page only reads, with one GET to its route", async () => {
  const hub = stubHub({ status: 200, body: { resources: RESOURCES } });
  const mounted = await mount("admin");
  try {
    assert.equal(await waitFor(() => at('[data-testid="resources-images"] table') !== null), true);
    const own = hub.calls.filter((call) => call.url !== "/api/hosts");
    assert.deepEqual(own, [{ url: `/api/hosts/${HOST_ID}/resources`, method: "GET" }]);
    assert.ok(hub.calls.every((call) => call.method === "GET"));
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("an outdated agent is named as such", async () => {
  const hub = stubHub({ status: 409, body: { error: "agent-outdated", message: "zu alt" } });
  const mounted = await mount("admin");
  try {
    assert.equal(await waitFor(() => at('[data-testid="resources-failed"]') !== null), true);
    assert.ok(oneOf(textOf('[data-testid="resources-failed"]'), ["resourcesOutdated"]));
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("without the admin role the page asks nothing", async () => {
  const hub = stubHub({ status: 200, body: { resources: RESOURCES } });
  const mounted = await mount("user");
  try {
    await settle();
    assert.equal(at('[data-testid="host-resources"]') === null, true);
    assert.deepEqual(
      hub.calls.filter((call) => call.url.endsWith("/resources")),
      []
    );
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("usage and sharing come from the list of users", () => {
  assert.equal(usageState(null), "unknown");
  assert.equal(usageState([]), "unused");
  assert.equal(usageState([SHOP]), "in-use");
  assert.equal(isShared([SHOP]), false);
  assert.equal(isShared([SHOP, WORKER]), true);
  assert.equal(isShared(null), false);
});
