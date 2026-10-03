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

// The compose tab is a lazy view (#265): `StackScreen` loads it with
// `React.lazy`, and the first `import()` of its module graph takes longer than
// a test waits. Loaded here, every later `import()` resolves at once.
// `import()` and not `import`: a `.lazy.tsx` entry is dynamic only
// (`lazy-only-dynamic`).
await import("../src/features/compose/ComposeView.lazy.js");

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Compose-Reiter fragt die Datei über einen Container des Stacks (#183).
// Gemessen am 2026-09-29 am Arm `unraid`: im Stack `minecraft_arc_2026` trug
// genau der ERSTE Container Labels, zu denen der Arm keine Datei fand
// (`409`, `reason: compose-file-missing`), während die anderen beiden sie
// lieferten. Drei Zusagen hängen daran:
//
//   1. Über `compose-file-missing` hinweg wird der nächste Container gefragt,
//      und DER wird der Anker — auch für Vorschau und Anwenden.
//   2. Über JEDEN ANDEREN Fehler hinweg nicht: der gilt dem Stack, und ein
//      zweiter Versuch schriebe nur einen Audit-Eintrag mehr.
//   3. Liefert keiner die Datei, steht der eigene Satz da und nicht der
//      allgemeine.

const HOST_ID = "arm-1";
const PROJECT = "minecraft";
const IDS = ["c-timelapse", "c-geometry", "c-server"];

function container(id: string): OverviewContainer {
  return {
    id,
    name: id,
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

// A complete wire shape: the screen parses `/api/overview` against the
// contract since #248.
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
  hubOwnStack: false
};

/** Wie der Hub die Datei ausliefert — wahlweise als seinen eigenen Stack. */
let fileOverrides: Record<string, unknown> = {};

/** Wie der Hub antwortet, je Container: die Datei oder ein Fehlerrumpf. */
type Answer = { status: 200 } | { status: number; body: Record<string, unknown> };

/** Die Antwort des Hubs seit #183: eigene Kennung, der Grund des Arms und wo er gesucht hat. */
function missing(projectDir: string): Answer {
  return {
    status: 409,
    body: { error: "compose-file-missing", message: "keine Datei", reason: "compose-file-missing", projectDir }
  };
}
const MISSING = missing("/mnt/cache/docker/c-timelapse");

function stubHub(answers: Record<string, Answer>): { composeUrls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const composeUrls: string[] = [];
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts: overview() }));
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks: [] }));
    const match = /\/containers\/([^/]+)\/compose$/.exec(url);
    if (match !== null) {
      composeUrls.push(url);
      const answer = answers[match[1]] ?? { status: 200 };
      return Promise.resolve("body" in answer ? json(answer.body, answer.status) : json({ compose: { ...FILE, ...fileOverrides } }));
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;

  return { composeUrls, restore: () => (globalThis.fetch = original) };
}

async function mount(answers: Record<string, Answer>) {
  const server = stubHub(answers);
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
  return { server, ...mounted };
}

/** Welcher Container gefragt wurde, in der Reihenfolge der Anfragen. */
function asked(urls: string[]): string[] {
  return urls.map((url) => /\/containers\/([^/]+)\/compose$/.exec(url)?.[1] ?? "?");
}

test("fehlt die Datei am ersten Container, trägt der zweite", async () => {
  const { server, unmount } = await mount({ "c-timelapse": MISSING });
  try {
    // ⚠️ Genau zwei Anfragen: der dritte wird nicht mehr gefragt, sobald der
    // zweite geliefert hat — jede Anfrage schreibt einen Audit-Eintrag.
    assert.deepEqual(asked(server.composeUrls), ["c-timelapse", "c-geometry"]);
    const text = document.body.textContent ?? "";
    assert.ok(text.includes("/mnt/cache/docker/minecraft"), "die geladene Datei steht nicht da");
    assert.ok(!text.includes(en.composeErrorFileMissing));
    assert.ok(!text.includes(en.composeErrorGeneric));
  } finally {
    server.restore();
    await unmount();
  }
});

test("ein anderer Fehler wird nicht übergangen", async () => {
  const { server, unmount } = await mount({
    "c-timelapse": { status: 403, body: { error: "agent-forbidden", message: "Allowlist" } }
  });
  try {
    assert.deepEqual(asked(server.composeUrls), ["c-timelapse"]);
    assert.ok((document.body.textContent ?? "").includes(en.composeErrorNotAllowlisted));
    // Ein anderer Fehler hat keinen Ort — also keine Pfadliste.
    assert.ok(document.querySelector('[data-testid="compose-searched"]') === null);
  } finally {
    server.restore();
    await unmount();
  }
});

test("liefert keiner die Datei, steht der eigene Satz da — mit den Verzeichnissen", async () => {
  const { server, unmount } = await mount({
    "c-timelapse": MISSING,
    "c-geometry": missing("/mnt/cache/docker/minecraft"),
    "c-server": missing("/mnt/cache/docker/minecraft")
  });
  try {
    assert.deepEqual(asked(server.composeUrls), IDS);
    const text = document.body.textContent ?? "";
    assert.ok(text.includes(en.composeErrorFileMissing), "der eigene Satz fehlt");
    assert.ok(!text.includes(en.composeErrorGeneric), "der allgemeine Satz steht noch da");
    // ⚠️ Jedes Verzeichnis EINMAL, in der Reihenfolge der Suche: zwei
    // Container desselben Verzeichnisses sind eine Auskunft, nicht zwei.
    const dirs = [...document.querySelectorAll('[data-testid="compose-searched"] li')].map(
      (entry) => entry.textContent
    );
    assert.deepEqual(dirs, ["/mnt/cache/docker/c-timelapse", "/mnt/cache/docker/minecraft"]);
  } finally {
    server.restore();
    await unmount();
  }
});

test("der eigene Stack des Hubs wird gezeigt, aber nicht zum Bearbeiten angeboten", async () => {
  fileOverrides = { hubOwnStack: true };
  const { server, unmount } = await mount({});
  try {
    const text = document.body.textContent ?? "";
    assert.ok(text.includes("/mnt/cache/docker/minecraft"), "die Datei steht nicht da");
    assert.ok(text.includes(en.composeHubOwnStack), "der Grund fehlt");
    // ⚠️ Am KNOPF und nicht am Text: ein ausgegrauter Knopf bestünde eine
    // Textprüfung und böte trotzdem einen Weg an, den die Route ablehnt.
    const edit = [...document.querySelectorAll("button")].find((button) => button.textContent === en.composeEdit);
    assert.ok(edit === undefined, "der Knopf zum Bearbeiten steht noch da");
  } finally {
    fileOverrides = {};
    server.restore();
    await unmount();
  }
});
