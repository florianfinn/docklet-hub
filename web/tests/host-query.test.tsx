// ⚠️ The order of imports is MEANING, not formatting: the DOM must stand
// before React is loaded (see `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React is named although no line calls it — `tsx` compiles the JSX of this
// file with the classic runtime (`React.createElement`). The reason and the
// measurement are in the head of `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { focusManager } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

// WHAT THIS FILE CHECKS (#256)
//
// The hosts screen loads through TanStack Query since #256. Four mistakes in
// that move are valid TypeScript and a green chain:
//
//   1. THE THREE STATES GET LOST. A query has loading, error and success; a
//      screen that reads only `data` shows an empty list while loading and an
//      empty list on failure, and both look like "no hosts".
//   2. TWO SCREENS, TWO REQUESTS. The colour panel in the settings reads the
//      same list. With a key written differently in one place (a literal
//      instead of `queryKeys`), both load on their own and the shared cache is
//      a claim only.
//   3. THE 401 IS SWALLOWED. A query catches its error and shows it as state;
//      if the 401 then stopped at the query, an expired session would read as
//      "hosts could not be loaded" again — the finding of #127.
//   4. THE DEFAULTS OF THE LIBRARY. Out of the box TanStack Query retries
//      three times and reloads on every window focus. The first turns a 404
//      into four requests, the second writes an agent audit entry on every tab
//      switch (#117 Befund 9).
//
// NOT checked: the network. `fetch` is a stub; the hub's answers are its own.

// ⚠️ The `src` modules of the signed-in app come through `await import(…)` and
// a loader that turns every `.css` into an empty module; the reason and the
// measurement are in the head of `session-expiry.test.tsx`.
register("./xterm-stub-loader.mjs", import.meta.url, {
  data: { doubleUrl: new URL("./xterm-double.mjs", import.meta.url).href }
});
(globalThis as unknown as { __HUB_VERSION__: string }).__HUB_VERSION__ = "0.0.0-test";

const { DEFAULT_GLOBAL_THEME } = await import("contract");
const { App } = await import("../src/App.js");
const { ApiError, ResponseShapeError } = await import("../src/platform/http/transport.js");
const { GlobalThemeProvider } = await import("../src/features/appearance/index.js");
const { AppLanguageProvider } = await import("../src/app/i18n/AppLanguageProvider.js");
const { de, en } = await import("../src/app/i18n/messages.js");
const { createQueryClient, shouldRetry } = await import("../src/platform/query/query-client.js");
const { queryKeys } = await import("../src/platform/query/query-keys.js");
const { HostsScreen } = await import("../src/app/screens/HostsScreen.js");
const { HostColorPanel } = await import("../src/features/appearance/HostColorPanel.js");

type Answer = { status: number; body: unknown };

const HOST = {
  id: "host-1",
  name: "unraid",
  agentUrl: "http://10.254.0.2:8099",
  kind: "internal",
  state: "registered",
  status: "online",
  agentVersion: "0.19.1",
  tunnelAddress: "10.254.0.2",
  display: { hue: "neutral", ink: "head" },
  agentUpdate: null,
  lastSeenAt: null
};

const USER = { id: "u1", name: "Betreiberin", email: "b@hub.test", role: "admin", language: "de" };

/**
 * The hub without a hub. `hosts` decides the answer of `GET /api/hosts`;
 * `hold()` keeps the next one back until `release()`, so "loading" can be
 * seen at all.
 */
function stubHub(hosts: () => Answer) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let holding = false;
  let held: (() => void) | null = null;

  const json = ({ status, body }: Answer) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const routes: Record<string, () => Answer> = {
    "/api/setup": () => ({ status: 200, body: { open: false } }),
    "/api/session": () => ({ status: 200, body: { user: USER } }),
    "/api/settings": () => ({
      status: 200,
      body: {
        theme: DEFAULT_GLOBAL_THEME,
        logs: { tailLines: 200 },
        containers: { showSystem: false },
        network: {
          externalEndpoint: null,
          internalTarget: null,
          externalTarget: null,
          externalTargetUnreachable: false
        }
      }
    }),
    "/api/hosts": hosts,
    "/api/hosts/host-1/containers": () => ({
      status: 200,
      body: {
        host: HOST,
        agent: { reachable: true, version: null, contractVersion: null, readOnly: null, entries: null },
        containers: [],
        load: null,
        error: null
      }
    })
  };

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://hub.test/").pathname;
    calls.push(path);
    const route = routes[path];
    // A route this stub does not know is a finding, not a reason to invent an
    // answer.
    const answer = () => (route ? json(route()) : new Response(null, { status: 501 }));
    if (path !== "/api/hosts" || !holding) return Promise.resolve(answer());
    return new Promise<Response>((resolve) => {
      held = () => resolve(answer());
    });
  }) as typeof fetch;

  return {
    hostsCalls: () => calls.filter((path) => path === "/api/hosts").length,
    hold: () => {
      holding = true;
    },
    release: async () => {
      holding = false;
      held?.();
      held = null;
      await settle();
    },
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const ok = (): Answer => ({ status: 200, body: { hosts: [HOST] } });

function shows(container: HTMLElement, texts: string[]): boolean {
  const shown = container.textContent ?? "";
  return texts.some((text) => shown.includes(text));
}

function present(selector: string): boolean {
  return document.body.querySelector(selector) !== null;
}

// ---------------------------------------------------------------------------
// 1. The policy, without a DOM
// ---------------------------------------------------------------------------

test("keine Wiederholung auf eine Antwort des Hubs, eine bei einem Netzfehler", () => {
  for (const status of [400, 401, 403, 404, 409, 500, 502]) {
    assert.equal(shouldRetry(0, new ApiError(status, "{}")), false, `no retry after ${status}`);
  }
  assert.equal(shouldRetry(0, new ResponseShapeError("/api/hosts", [])), false, "no retry on a contract mismatch");
  assert.equal(shouldRetry(0, new TypeError("Failed to fetch")), true, "a network failure is tried once more");
  assert.equal(shouldRetry(1, new TypeError("Failed to fetch")), false, "and only once");
});

test("der Client lädt weder bei Fensterfokus noch bei neuer Verbindung nach", () => {
  const defaults = createQueryClient().getDefaultOptions().queries;
  assert.equal(defaults?.refetchOnWindowFocus, false);
  assert.equal(defaults?.refetchOnReconnect, false);
});

// ---------------------------------------------------------------------------
// 2. The hosts screen: loading, error, success
// ---------------------------------------------------------------------------

test("der Host-Bildschirm zeigt erst das Laden, dann die Liste", async () => {
  const hub = stubHub(ok);
  hub.hold();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <HostsScreen role="admin" />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  try {
    await settle();
    assert.ok(shows(mounted.container, [de.loading, en.loading]), "while the hub is silent, the screen says it loads");
    assert.ok(!present('[data-testid="archive-reload-host-1"]'), "and shows no card yet");

    await hub.release();
    await settle();
    assert.ok(present('[data-testid="archive-reload-host-1"]'), "the card stands once the list arrived");
    assert.ok(!shows(mounted.container, [de.loading, en.loading]), "and the loading line is gone");
    assert.ok(!present('[data-testid="hosts-failed"]'), "no error line on success");
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("der Host-Bildschirm zeigt seinen Fehler, nach genau einer Anfrage", async () => {
  const hub = stubHub(() => ({ status: 500, body: { error: "boom" } }));
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <HostsScreen role="admin" />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  try {
    await settle();
    await settle();
    assert.ok(present('[data-testid="hosts-failed"]'), "the failure is shown as such");
    assert.ok(!shows(mounted.container, [de.loading, en.loading]), "and not as an endless load");
    assert.equal(hub.hostsCalls(), 1, "a 5xx of the hub is not asked again");
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

// ---------------------------------------------------------------------------
// 3. Two screens, one request
// ---------------------------------------------------------------------------

test("Host-Bildschirm und Farbtafel teilen sich eine Anfrage", async () => {
  const hub = stubHub(ok);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <HostsScreen role="admin" />
      </MemoryRouter>
      <HostColorPanel role="admin" />
    </AppLanguageProvider>
  );
  try {
    await settle();
    await settle();
    assert.equal(hub.hostsCalls(), 1, "two screens with the same query ask the hub once");
    assert.ok(present('[data-testid="archive-reload-host-1"]'), "the hosts screen has the list");
    assert.ok(
      (mounted.container.textContent ?? "").split("unraid").length - 1 >= 2,
      "and the colour panel has it too"
    );
    assert.ok(
      mounted.queryClient.getQueryData(queryKeys.hosts.list()) !== undefined,
      "under the key from `queryKeys`, not under a literal"
    );
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("ein Fensterfokus fragt den Hub nicht erneut", async () => {
  const hub = stubHub(ok);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <HostsScreen role="admin" />
      </MemoryRouter>
    </AppLanguageProvider>
  );
  try {
    await settle();
    const before = hub.hostsCalls();
    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await settle();
    assert.equal(hub.hostsCalls(), before, "the focus reload is off by default (#117 Befund 9)");
  } finally {
    focusManager.setFocused(undefined);
    await mounted.unmount();
    hub.restore();
  }
});

// ---------------------------------------------------------------------------
// 4. A 401 from a query leads to the sign-in
// ---------------------------------------------------------------------------

test("ein 401 aus der Host-Abfrage führt zur Anmeldung und leert den Zwischenspeicher", async () => {
  let expired = false;
  const hub = stubHub(() => (expired ? { status: 401, body: { error: "unauthenticated" } } : ok()));
  const mounted = await renderInDom(
    <MemoryRouter initialEntries={["/hosts"]}>
      <AppLanguageProvider>
        <GlobalThemeProvider>
          <App />
        </GlobalThemeProvider>
      </AppLanguageProvider>
    </MemoryRouter>
  );
  try {
    await settle();
    await settle();
    assert.ok(present('[data-testid="hosts-refresh"]'), "the signed-in hosts screen stands");
    assert.ok(
      mounted.queryClient.getQueryData(queryKeys.hosts.list()) !== undefined,
      "with the list in the cache"
    );

    expired = true;
    await React.act(async () => {
      (document.body.querySelector('[data-testid="hosts-refresh"]') as HTMLElement).click();
    });
    await settle();
    await settle();

    assert.ok(
      document.body.querySelector("#sign-in-email") instanceof HTMLInputElement,
      "the 401 of the query leads to the sign-in form"
    );
    assert.ok(
      shows(mounted.container, [de.signInExpired, en.signInExpired]),
      "with the reason next to it"
    );
    assert.equal(
      mounted.queryClient.getQueryCache().getAll().length,
      0,
      "the cache of the ended session is empty; the next account does not see its arms"
    );
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});
