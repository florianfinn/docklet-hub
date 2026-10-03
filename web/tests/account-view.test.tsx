// The page "Benutzer & Profil" at a running tree (#269).
//
// ⚠️ The order of the imports is MEANING and not formatting: the DOM has to
// stand before React is loaded (see `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React is named although no line calls it: `tsx` compiles the JSX of this
// file with the old runtime (`React.createElement`); see `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { AccountView } from "../src/features/account/AccountView.js";
import type { SessionUser } from "../src/platform/session/session-user.js";

// WHAT THIS FILE CHECKS: the one rule of the page that no other guard sees. The
// list of accounts stands behind `requireAdmin`, so a user without the admin
// role must not even ask for it: a request that is known to end in 403 is a
// request with a run-up (the paragraph above `AccountView`). The list is read
// through a query now (`useAccounts`, #269), and `enabled` is the whole rule; a
// refactor that drops it keeps every type, every build and every guard green.
//
// NOT checked: the server. `fetch` is a stub that replays the contract of
// `server/src/features/account/routes.ts`; the real route runs in
// `server/src/app/users-route.test.ts`.

const ACCOUNTS = [
  { id: "u1", name: "Ada", email: "ada@hub.test", role: "admin", lastSignInAt: "2026-10-01T10:00:00.000Z", sessionCount: 2 },
  { id: "u2", name: "Ben", email: "ben@hub.test", role: "user", lastSignInAt: null, sessionCount: 0 }
];

function user(role: SessionUser["role"]): SessionUser {
  return { id: role === "admin" ? "u1" : "u2", name: "Ada", email: "ada@hub.test", role, language: "de" };
}

function stubUsers(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ users: ACCOUNTS }), { status: 200, headers: { "content-type": "application/json" } })
    );
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

async function mount(role: SessionUser["role"]) {
  const hub = stubUsers();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <AccountView user={user(role)} />
    </AppLanguageProvider>
  );
  await settle();
  return { hub, ...mounted };
}

test("ein Administrator sieht die Konten-Tafel samt Zählern", async () => {
  const { hub, container, unmount } = await mount("admin");
  try {
    assert.deepEqual(hub.urls, ["/api/users"]);
    assert.ok(container.textContent?.includes("Ben"), "das zweite Konto steht in der Tabelle");
    // The language is the browser's (English under the test DOM), so both are read.
    assert.match(container.textContent ?? "", /2 (Konten|accounts)/, "der Zähler kommt aus der Liste");
    assert.match(container.textContent ?? "", /1 (Administrator|administrator)/);
  } finally {
    await unmount();
    hub.restore();
  }
});

test("ein Benutzer fragt die Konten-Liste gar nicht erst und sieht keine Tafel", async () => {
  const { hub, container, unmount } = await mount("user");
  try {
    assert.deepEqual(hub.urls, [], "kein Aufruf, der im Voraus mit 403 endet");
    assert.ok(!container.textContent?.includes("ben@hub.test"), "keine Tafel „Konten“");
    assert.match(container.textContent ?? "", /(Mein Profil|My profile)/, "das eigene Profil steht da");
  } finally {
    await unmount();
    hub.restore();
  }
});
