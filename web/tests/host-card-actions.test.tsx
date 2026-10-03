// ⚠️ The import order matters: the DOM must stand before React is loaded
// (see `dom-harness.tsx`).
import { renderInDom } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import type { DockerHost } from "../src/domain/hosts/index.js";
import type { HostStatus } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { HostCard } from "../src/features/hosts/HostCard.js";

// The action slot of a host card (#3): another feature's admin action shows on
// every kind of arm, and an arm without any action shows no empty bar.

function hostOf(overrides: Partial<DockerHost> = {}): DockerHost {
  return {
    id: "host-1",
    name: "local",
    agentUrl: "http://127.0.0.1:8099",
    kind: "local",
    state: "registered",
    status: "online" as HostStatus,
    agentVersion: "0.32.0",
    tunnelAddress: null,
    display: { hue: "neutral", ink: "head" },
    agentUpdate: null,
    lastSeenAt: null,
    ...overrides
  };
}

async function render(host: DockerHost, role: "admin" | "user") {
  return renderInDom(
    <AppLanguageProvider>
      <HostCard
        host={host}
        role={role}
        counters={{ state: "loading" }}
        onRemoved={() => {}}
        onAgentUpdated={() => {}}
        renderActions={(entry) => (entry.status === "online" ? <span data-testid="slot-action">x</span> : null)}
      />
    </AppLanguageProvider>
  );
}

test("the local arm shows the slot's action to an admin", async () => {
  const mounted = await render(hostOf(), "admin");
  try {
    assert.equal(mounted.container.querySelector('[data-testid="slot-action"]') !== null, true);
  } finally {
    await mounted.unmount();
  }
});

test("a local arm without an action shows no empty action bar", async () => {
  const mounted = await render(hostOf({ status: "offline" as HostStatus }), "admin");
  try {
    assert.equal(mounted.container.querySelector(".border-t") === null, true);
  } finally {
    await mounted.unmount();
  }
});

test("a user without admin rights sees no slot action", async () => {
  const mounted = await render(hostOf(), "user");
  try {
    assert.equal(mounted.container.querySelector('[data-testid="slot-action"]') === null, true);
  } finally {
    await mounted.unmount();
  }
});
