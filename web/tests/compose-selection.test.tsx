// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, Route, Routes } from "react-router";

import { en } from "../src/app/i18n/messages.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { StackScreen } from "../src/app/screens/StackScreen.js";
import { TooltipProvider } from "../src/platform/ui/shadcn/tooltip.js";
import type { HostOverview, OverviewContainer } from "contract";

// The compose tab is a lazy view (#265); loaded here once, every later
// `import()` of `StackScreen` resolves at once (see `compose-anchor.test.tsx`).
await import("../src/features/compose/ComposeView.lazy.js");

// WHAT THIS FILE CHECKS AND WHY
//
// The selection of a container's compose file by hand (#185). Four promises of
// the decision of 2026-09-29 hang on the surface:
//
//   1. The agent's anchor reasons do not stop the walk over the stack — like
//      `compose-file-missing` since #183.
//   2. Where the hub does not offer the selection, there is neither a button
//      nor a request for candidates.
//   3. With more than one file in the labels, the warning lists each of them.
//   4. What is set is a path FROM THE LIST, and the file is fetched again
//      afterwards; clearing is a DELETE.

const HOST_ID = "arm-1";
const PROJECT = "minecraft";
const IDS = ["c-timelapse", "c-geometry", "c-server"];
const LABEL_FILES = ["/mnt/cache/docker/minecraft/compose.yaml", "/mnt/cache/docker/minecraft/compose.timelapse.yaml"];

function container(id: string): OverviewContainer {
  return {
    id,
    name: `${id}-name`,
    image: "img:1",
    status: "running",
    running: true,
    startedAt: null,
    health: null,
    compose: { project: PROJECT, service: id },
    stats: null,
    externalManagement: null,
    state: "ok",
    marks: [],
    system: false
  };
}

function overview(): HostOverview[] {
  return [
    {
      host: {
        id: HOST_ID,
        name: "unraid",
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
      stacks: [
        {
          project: PROJECT,
          state: "ok",
          running: 3,
          marks: [],
          indent: "nested",
          hidden: false,
          total: 3,
          system: false,
          containers: IDS.map(container)
        }
      ],
      loose: [],
      error: null
    }
  ];
}

const FILE = {
  projectDir: "/mnt/cache/docker/minecraft",
  composeFileName: "compose.yaml",
  stackName: PROJECT,
  content: "services:\n  server:\n    image: img:1\n",
  composeHash: "h1",
  services: ["server"],
  servicesInFile: ["server"],
  fileReadable: true,
  containerIds: {},
  inventoryViolations: [],
  hubOwnStack: false,
  selectionSupported: true
};

type Answer = { status: number; body: Record<string, unknown> };

/** The hub's answer since #185: its own code, the agent's anchor reason and the offer. */
function ambiguous(selectionSupported: boolean): Answer {
  return {
    status: 409,
    body: {
      error: "compose-file-missing",
      message: "keine Datei",
      reason: "compose-anchor-file-ambiguous",
      projectDir: "/mnt/cache/docker/minecraft",
      selectionSupported
    }
  };
}

function candidates(selectedFilePath: string | null) {
  return {
    anchor: { ok: false, reason: "compose-anchor-file-ambiguous", projectDir: "/mnt/cache/docker/minecraft" },
    selectedFilePath,
    labelFilePaths: LABEL_FILES,
    candidates: [
      { filePath: LABEL_FILES[0], projectDir: "/mnt/cache/docker/minecraft", composeFileName: "compose.yaml", source: "label" }
    ]
  };
}

type Call = { method: string; url: string; body: string | null };

function stubHub(answers: Record<string, Answer>, selected: string | null) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts: overview() }));
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks: [] }));
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    if (url.endsWith("/compose/candidates")) return Promise.resolve(json({ selection: candidates(selected) }));
    if (url.endsWith("/compose/selection")) {
      return Promise.resolve(json({ selectedFilePath: method === "PUT" ? LABEL_FILES[0] : null }));
    }
    const match = /\/containers\/([^/]+)\/compose$/.exec(url);
    if (match !== null) {
      const answer = answers[match[1]];
      return Promise.resolve(answer === undefined ? json({ compose: FILE }) : json(answer.body, answer.status));
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

async function mount(answers: Record<string, Answer>, selected: string | null = null) {
  const server = stubHub(answers, selected);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/stack/${HOST_ID}/${PROJECT}/compose`]}>
          <Routes>
            <Route path="/stack/:hostId/:project/compose" element={<StackScreen role="admin" tab="compose" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </AppLanguageProvider>
  );
  await settle();
  await settle();
  await settle();
  return { server, ...mounted };
}

function composeReads(calls: Call[]): string[] {
  return calls.flatMap((call) => {
    const match = /\/containers\/([^/]+)\/compose$/.exec(call.url);
    return match === null ? [] : [match[1]];
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

test("ein Ankergrund hält die Suche nicht an, und der übersprungene Container steht zur Wahl", async () => {
  const { server, unmount } = await mount({ "c-timelapse": ambiguous(true) });
  try {
    assert.deepEqual(composeReads(server.calls), ["c-timelapse", "c-geometry"]);
    const skipped = byTestId("compose-skipped");
    assert.ok(skipped !== null, "die übersprungenen Container fehlen");
    assert.ok((skipped.textContent ?? "").includes("c-timelapse-name"));
    // ⚠️ Nothing asked before someone asks: every request writes an audit
    // entry at the arm.
    assert.ok(!server.calls.some((call) => call.url.endsWith("/compose/candidates")));
  } finally {
    server.restore();
    await unmount();
  }
});

test("ohne Datei steht die Zuordnung offen, mit Warnung und jeder Datei aus den Labels", async () => {
  const { server, unmount } = await mount({
    "c-timelapse": ambiguous(true),
    "c-geometry": ambiguous(true),
    "c-server": ambiguous(true)
  });
  try {
    const text = document.body.textContent ?? "";
    assert.ok(text.includes(en.composeErrorAnchorAmbiguous), "der Satz zum Grund fehlt");
    assert.ok(byTestId("compose-searched") !== null, "das durchsuchte Verzeichnis fehlt");
    assert.ok(server.calls.some((call) => call.url.endsWith("/containers/c-timelapse/compose/candidates")));
    assert.ok(byTestId("compose-selection-warning") !== null, "die Warnung fehlt");
    const files = [...document.querySelectorAll('[data-testid="compose-selection-label-files"] li')].map(
      (entry) => entry.textContent
    );
    assert.deepEqual(files, LABEL_FILES);

    const confirm = byTestId("compose-selection-confirm") as HTMLButtonElement | null;
    assert.ok(confirm !== null && !confirm.disabled, "der Knopf zum Festlegen fehlt oder ist gesperrt");
    const readsBefore = composeReads(server.calls).length;
    confirm.click();
    await settle();
    await settle();
    const put = server.calls.find((call) => call.method === "PUT");
    assert.ok(put !== undefined, "es wurde nichts festgelegt");
    assert.ok(put.url.endsWith("/containers/c-timelapse/compose/selection"));
    assert.deepEqual(JSON.parse(put.body ?? "null"), { filePath: LABEL_FILES[0] });
    assert.ok(composeReads(server.calls).length > readsBefore, "die Datei wurde danach nicht neu geholt");
  } finally {
    server.restore();
    await unmount();
  }
});

test("bietet der Hub die Zuordnung nicht an, gibt es weder Schaltfläche noch Anfrage", async () => {
  const { server, unmount } = await mount({
    "c-timelapse": ambiguous(false),
    "c-geometry": ambiguous(false),
    "c-server": ambiguous(false)
  });
  try {
    assert.ok((document.body.textContent ?? "").includes(en.composeErrorAnchorAmbiguous));
    assert.ok(byTestId("compose-selection") === null, "die Zuordnung steht trotzdem da");
    assert.ok(byTestId("compose-skipped") === null);
    assert.ok(!server.calls.some((call) => call.url.includes("/compose/candidates")));
  } finally {
    server.restore();
    await unmount();
  }
});

test("eine festgelegte Zuordnung lässt sich am Anker aufheben", async () => {
  const { server, unmount } = await mount({}, LABEL_FILES[0]);
  try {
    const open = byTestId("compose-selection-open") as HTMLButtonElement | null;
    assert.ok(open !== null, "die Schaltfläche „Zuordnung“ fehlt");
    open.click();
    await settle();
    await settle();
    assert.ok(byTestId("compose-selection-current") !== null, "die geltende Zuordnung ist nicht markiert");
    const clear = byTestId("compose-selection-clear") as HTMLButtonElement | null;
    assert.ok(clear !== null, "der Knopf zum Aufheben fehlt");
    clear.click();
    await settle();
    await settle();
    const removed = server.calls.find((call) => call.method === "DELETE");
    assert.ok(removed !== undefined && removed.url.endsWith("/containers/c-timelapse/compose/selection"));
  } finally {
    server.restore();
    await unmount();
  }
});
