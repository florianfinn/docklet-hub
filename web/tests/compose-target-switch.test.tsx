// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle, settleQueries } from "./dom-harness.js";
import { composeSettled } from "./compose-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router";

import { en } from "../src/app/i18n/messages.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { StackScreen } from "../src/app/screens/StackScreen.js";
import { TooltipProvider } from "../src/platform/ui/shadcn/tooltip.js";
import type { HostOverview, StackView } from "contract";

// Loaded once up front, like in `stack-tabs.test.tsx`: the first `import()` of
// the lazy compose view takes longer than a test waits.
await import("../src/features/compose/ComposeView.lazy.js");

// What this file checks (#286, P1 from the review of #301): the compose draft
// belongs to ONE stack. Moving from the compose tab of stack A to the compose
// tab of stack B keeps the same route, and React reuses the mounted
// `ComposeView` unless its target is part of its key. Measured on
// `355779c` before the fix: the editor of B still held the draft typed for A,
// while file, anchor and hash came from B, so "apply" would have written A's
// text against B's hash.

const HOST_ID = "arm-1";

function stack(project: string, containerId: string): StackView {
  return {
    project,
    state: "ok",
    running: 1,
    marks: [],
    indent: "nested",
    hidden: false,
    total: 1,
    system: false,
    containers: [
      {
        id: containerId,
        name: project,
        image: `${project}:1`,
        status: "running",
        running: true,
        startedAt: null,
        health: null,
        compose: { project, service: project },
        stats: null,
        externalManagement: null,
        state: "ok",
        marks: [],
        system: false
      }
    ]
  };
}

function overview(): HostOverview[] {
  return [
    {
      host: {
        id: HOST_ID,
        name: "local-host",
        agentUrl: "http://arm",
        kind: "internal",
        state: "registered",
        status: "online",
        agentVersion: null,
        tunnelAddress: null,
        display: { hue: "neutral", ink: "edge" },
        agentUpdate: null,
        lastSeenAt: null
      },
      agent: null,
      stacks: [stack("alpha", "c-alpha"), stack("beta", "c-beta")],
      loose: [],
      error: null
    }
  ];
}

const FILES: Record<string, { project: string; content: string; hash: string }> = {
  "c-alpha": { project: "alpha", content: "services:\n  alpha:\n    image: alpha:1\n", hash: "hash-alpha" },
  "c-beta": { project: "beta", content: "services:\n  beta:\n    image: beta:1\n", hash: "hash-beta" }
};

function stubHub(): () => void {
  const original = globalThis.fetch;
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts: overview() }));
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks: [] }));
    const match = /\/containers\/([^/]+)\/compose$/.exec(url);
    const file = match === null ? undefined : FILES[match[1]];
    if (file !== undefined && match !== null) {
      return Promise.resolve(
        json({
          compose: {
            projectDir: `/opt/stacks/${file.project}`,
            composeFileName: "compose.yaml",
            stackName: file.project,
            content: file.content,
            composeHash: file.hash,
            services: [file.project],
            servicesInFile: [file.project],
            fileReadable: true,
            containerIds: { [file.project]: match[1] },
            inventoryViolations: []
          }
        })
      );
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

// Hands the router's `navigate` to the test, so the switch happens inside the
// same router and the same mounted route, as a link elsewhere in the app does.
let navigate: NavigateFunction | null = null;
function NavigateProbe() {
  navigate = useNavigate();
  return null;
}

async function typeInto(field: HTMLTextAreaElement, text: string): Promise<void> {
  // React listens to the native `input` event; setting `value` alone stays
  // invisible to its state.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field) as object, "value")?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

function editorField(): HTMLTextAreaElement | null {
  return document.querySelector('[data-testid="compose-editor"]');
}

test("ein Compose-Entwurf bleibt beim Wechsel in einen anderen Stack nicht stehen", async () => {
  const restore = stubHub();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/stack/${HOST_ID}/alpha/compose`]}>
          <NavigateProbe />
          <Routes>
            <Route path="/stack/:hostId/:project/compose" element={<StackScreen role="admin" tab="compose" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </AppLanguageProvider>
  );
  try {
    await settleQueries(mounted.queryClient);
    assert.ok(await composeSettled(), "ComposeView of stack alpha did not settle");
    const editButton = [...document.querySelectorAll("button")].find((button) => button.textContent === en.composeEdit);
    assert.ok(editButton, "the edit button of stack alpha is missing");
    editButton.click();
    await settle();
    const field = editorField();
    assert.ok(field, "the editor of stack alpha is missing");
    await typeInto(field, "DRAFT-FROM-ALPHA\n");
    assert.ok(document.querySelector('[data-testid="compose-dirty"]'), "alpha carries a draft");

    assert.ok(navigate, "the router did not hand out navigate");
    navigate(`/stack/${HOST_ID}/beta/compose`);
    await settle();
    await settleQueries(mounted.queryClient);
    assert.ok(await composeSettled(), "ComposeView of stack beta did not settle");

    assert.ok(editorField()?.value.includes("DRAFT-FROM-ALPHA") !== true, "the editor of beta does not hold alpha's draft");
    assert.ok(document.querySelector('[data-testid="compose-dirty"]') === null, "beta starts without a draft");
    const text = document.body.textContent ?? "";
    assert.ok(!text.includes("DRAFT-FROM-ALPHA"), "the draft of alpha does not reach beta");
    assert.ok(text.includes("beta:1"), "the file of stack beta is shown");
  } finally {
    restore();
    navigate = null;
    await mounted.unmount();
  }
});
