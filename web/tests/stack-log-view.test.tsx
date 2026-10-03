// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle, waitFor } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, Route, Routes } from "react-router";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { StackScreen } from "../src/app/screens/StackScreen.js";
import { TooltipProvider } from "../src/platform/ui/shadcn/tooltip.js";
import type { HostOverview, OverviewContainer } from "contract";

// ⚠️ THE LAZY VIEW IS LOADED ONCE BEFORE THE FIRST CASE (#258). The screen
// loads it with `React.lazy`; the first `import()` of the module graph takes
// longer than the `settle()` after mounting, and the first case would see the
// loading text instead of the view. Loaded here, every later `import()`
// resolves at once. `import()` and not `import`: a `.lazy.tsx` entry is
// dynamic only (`lazy-only-dynamic`).
await import("../src/features/logs/StackLogView.lazy.js");

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Reiter „Protokoll" der Stack-Seite (#183) öffnet je gewähltem Container
// einen Log-Strom. Der Arm führt eine begrenzte Zahl davon für alle Menschen
// zusammen (`MAX_OPEN_STREAMS`, #234); die
// Zusagen dieses Reiters sind deshalb Zusagen über OFFENE STRÖME, und sie
// werden an den Aufrufen und ihren Abbrüchen geprüft, nicht am Text:
//
//   1. Der geschlossene Reiter öffnet keinen Strom.
//   2. Alle lesbaren Ströme ohne Obergrenze, die laufenden zuerst, kein
//      fremdverwalteter.
//   3. Abwählen bricht genau DIESEN Strom ab und nimmt seine Zeilen mit.
//   4. Die Zeilen zweier Ströme stehen nach Zeit gemischt da, mit ihrem Dienst.
//
// Der Rumpf ist von Hand gebaut, aus demselben Grund wie in
// `log-view.test.tsx`: ob happy-dom einen `ReadableStream` durchreicht, wäre
// eine Zusage der Attrappe und nicht des Bauteils.

const ENCODER = new TextEncoder();
const HOST_ID = "arm-1";
const PROJECT = "arr";

type Reader = { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> };

/** Ein Rumpf, in den der Test einspeist, wann er will. */
function pipe(signal: AbortSignal | undefined): { push: (text: string) => void; reader: Reader } {
  const queue: Uint8Array[] = [];
  let waiting: { resolve: (value: { done: boolean; value?: Uint8Array }) => void; reject: (error: unknown) => void } | null =
    null;
  let failure: unknown = null;
  signal?.addEventListener("abort", () => {
    failure = Object.assign(new Error("aborted"), { name: "AbortError" });
    waiting?.reject(failure);
    waiting = null;
  });
  return {
    push: (text) => {
      const chunk = ENCODER.encode(text);
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending.resolve({ done: false, value: chunk });
      } else {
        queue.push(chunk);
      }
    },
    reader: {
      read: () => {
        if (failure !== null) return Promise.reject(failure);
        const chunk = queue.shift();
        if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
        return new Promise((resolve, reject) => {
          waiting = { resolve, reject };
        });
      },
      cancel: () => Promise.resolve()
    }
  };
}

type Stream = { containerId: string; signal: AbortSignal; push: (text: string) => void };

function container(id: string, running = true, external = false): OverviewContainer {
  return {
    id,
    name: `${id}_arr`,
    image: "img:1",
    status: running ? "running" : "exited",
    running,
    startedAt: null,
    health: null,
    compose: { project: PROJECT, service: id },
    stats: null,
    externalManagement: external ? { manager: "unraid" } : null,
    state: running ? "ok" : "down",
    marks: [],
    system: false
  };
}

function stubHub(containers: ReturnType<typeof container>[]): { streams: Stream[]; restore: () => void } {
  const original = globalThis.fetch;
  const streams: Stream[] = [];
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  // A complete wire shape: the screen parses `/api/overview` against the
  // contract since #248.
  const hosts: HostOverview[] = [
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
          running: containers.filter((entry) => entry.running).length,
          marks: [],
          indent: "nested",
          hidden: false,
          total: containers.length,
          system: false,
          containers
        }
      ],
      loose: [],
      error: null
    }
  ];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts }));
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks: [] }));
    const match = /\/containers\/([^/]+)\/logs-stream/.exec(url);
    if (match !== null && init?.signal) {
      const body = pipe(init.signal);
      streams.push({ containerId: match[1], signal: init.signal, push: body.push });
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => body.reader } } as unknown as Response);
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;

  return { streams, restore: () => (globalThis.fetch = original) };
}

async function mount(tab: "overview" | "logs", containers: ReturnType<typeof container>[]) {
  const server = stubHub(containers);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/stack/${HOST_ID}/${PROJECT}${tab === "logs" ? "/logs" : ""}`]}>
          <Routes>
            <Route path="/stack/:hostId/:project" element={<StackScreen role="user" tab="overview" />} />
            <Route path="/stack/:hostId/:project/logs" element={<StackScreen role="user" tab="logs" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </AppLanguageProvider>
  );
  await settle();
  if (tab === "logs") await waitFor(() => document.querySelector('[data-testid="stack-log-view"]') !== null);
  await settle();
  return { server, ...mounted };
}

/** Die Container mit offenem (nicht abgebrochenem) Strom. */
function openStreams(streams: Stream[]): string[] {
  return streams.filter((stream) => !stream.signal.aborted).map((stream) => stream.containerId).sort();
}

function envelope(ts: string, text: string): string {
  return `${JSON.stringify({ kind: "line", stream: "stdout", ts, text })}\n`;
}

async function click(testId: string): Promise<void> {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element, `„${testId}" fehlt`);
  (element as HTMLElement).click();
  await settle();
}

test("der geschlossene Reiter öffnet keinen Strom", async () => {
  const { server, unmount } = await mount("overview", [container("sonarr"), container("radarr")]);
  try {
    assert.equal(server.streams.length, 0);
  } finally {
    server.restore();
    await unmount();
  }
});

test("das Protokoll des Stacks füllt das Fenster und scrollt in sich", async () => {
  // Dieselbe Bauweise wie am Container (`container-screen.test.tsx`, dort
  // steht die Messung): bis hierher stand das Feld auf `h-[60vh]`, fest und
  // unabhängig davon, was über ihm Platz brauchte. happy-dom rechnet kein
  // Layout — geprüft wird, dass die Höhe vom Fenster bis zum Feld durchreicht.
  const { server, unmount } = await mount("logs", [container("sonarr")]);
  try {
    const field = document.querySelector('[data-testid="stack-log-lines"]');
    assert.ok(field !== null, "das Feld der Zeilen fehlt");
    assert.ok(
      /(^|\s)flex-1(\s|$)/.test(field.className) && !/(^|\s)h-\[/.test(field.className),
      `das Feld hat eine feste Höhe („${field.className}")`
    );
    const card = field.parentElement;
    assert.ok(card !== null && /(^|\s)flex-1(\s|$)/.test(card.className) && /(^|\s)min-h-0(\s|$)/.test(card.className));
    const page = card.parentElement;
    assert.ok(page !== null && page.className.includes("h-[calc(100svh-var(--shell-header-height))]"));
  } finally {
    server.restore();
    await unmount();
  }
});

test("alle Ströme, die laufenden zuerst, auch ein fremdverwalteter (#124)", async () => {
  // Neun lesbare: mehr als die acht Plätze, die ein Arm bis v0.29.0 hatte, und
  // mehr als die vier, auf die dieser Reiter bis zum 2026-09-29 deckelte.
  const running = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => container(id));
  const containers = [container("stopped", false), container("foreign", true, true), ...running];
  const { server, unmount } = await mount("logs", containers);
  try {
    assert.deepEqual(openStreams(server.streams), ["a", "b", "c", "d", "e", "f", "foreign", "g", "h", "stopped"]);
    // Die laufenden gehen zuerst auf.
    assert.deepEqual(
      server.streams.map((stream) => stream.containerId),
      ["foreign", "a", "b", "c", "d", "e", "f", "g", "h", "stopped"]
    );
    const last = document.querySelector('[data-testid="stack-log-pick-h_arr"]') as HTMLButtonElement;
    assert.equal(last.disabled, false);
    assert.equal(last.getAttribute("aria-pressed"), "true");
    const foreign = document.querySelector('[data-testid="stack-log-pick-foreign_arr"]') as HTMLButtonElement;
    assert.equal(foreign.disabled, false);
    assert.equal(foreign.getAttribute("aria-pressed"), "true");
  } finally {
    server.restore();
    await unmount();
  }
});

test("die Zeilen zweier Ströme stehen nach Zeit gemischt da", async () => {
  const { server, unmount } = await mount("logs", [container("sonarr"), container("radarr")]);
  try {
    const byId = (id: string) => server.streams.find((stream) => stream.containerId === id);
    byId("sonarr")?.push(envelope("2026-09-29T10:00:01Z", "s1") + envelope("2026-09-29T10:00:03Z", "s3"));
    await settle();
    byId("radarr")?.push(envelope("2026-09-29T10:00:02Z", "r2"));
    await settle();
    const lines = [...document.querySelectorAll('[data-testid="stack-log-line"]')];
    assert.deepEqual(
      lines.map((entry) => `${entry.getAttribute("data-service")}:${entry.lastElementChild?.textContent}`),
      ["sonarr:s1", "radarr:r2", "sonarr:s3"]
    );
  } finally {
    server.restore();
    await unmount();
  }
});

test("Abwählen bricht genau diesen Strom ab und nimmt seine Zeilen mit", async () => {
  const { server, unmount } = await mount("logs", [container("sonarr"), container("radarr")]);
  try {
    server.streams.find((stream) => stream.containerId === "radarr")?.push(envelope("2026-09-29T10:00:02Z", "r2"));
    server.streams.find((stream) => stream.containerId === "sonarr")?.push(envelope("2026-09-29T10:00:01Z", "s1"));
    await settle();
    const opened = server.streams.length;

    await click("stack-log-pick-radarr_arr");
    assert.deepEqual(openStreams(server.streams), ["sonarr"]);
    // ⚠️ Kein neuer Strom für den verbliebenen: sein Effekt blieb stehen.
    assert.equal(server.streams.length, opened);
    const services = [...document.querySelectorAll('[data-testid="stack-log-line"]')].map((entry) =>
      entry.getAttribute("data-service")
    );
    assert.deepEqual(services, ["sonarr"]);

    // Wieder wählen öffnet einen frischen Strom.
    await click("stack-log-pick-radarr_arr");
    assert.deepEqual(openStreams(server.streams), ["radarr", "sonarr"]);
  } finally {
    server.restore();
    await unmount();
  }
});

test("Farbe: ANSI gelesen, Stufe erkannt, stderr nicht mehr rot, je Dienst eine eigene", async () => {
  const esc = String.fromCharCode(27);
  const { server, unmount } = await mount("logs", [container("overseerr"), container("adguard")]);
  try {
    const byId = (id: string) => server.streams.find((stream) => stream.containerId === id);
    byId("overseerr")?.push(envelope("2026-09-29T10:00:01Z", `${esc}[34mdebug${esc}[39m[Jobs]: Download Sync`));
    byId("adguard")?.push(
      `${JSON.stringify({ kind: "line", stream: "stderr", ts: "2026-09-29T10:00:02Z", text: "[info] dnsproxy: ok" })}\n`
    );
    await settle();
    const lines = [...document.querySelectorAll('[data-testid="stack-log-line"]')] as HTMLElement[];
    assert.deepEqual(
      lines.map((entry) => [entry.getAttribute("data-service"), entry.getAttribute("data-level"), entry.getAttribute("data-stream")]),
      [
        ["overseerr", "debug", "stdout"],
        ["adguard", "info", "stderr"]
      ]
    );
    // Kein ESC mehr im Text, und die Farbe des Dienstes steht an der Farbfolge.
    const text = lines[0].querySelector('[data-testid="log-line-text"]');
    assert.equal(text?.textContent, "debug[Jobs]: Download Sync");
    const colored = text?.querySelector("span[style]") as HTMLElement | null;
    assert.ok(colored !== null && colored.style.color === "var(--terminal-ansi-blue)", "debug steht nicht in Blau");
    // stderr färbt die Zeile nicht: der Text trägt die gewöhnliche Schrift.
    const adguardText = lines[1].querySelector('[data-testid="log-line-text"]');
    assert.ok(adguardText !== null && !adguardText.className.includes("state-down"), "stderr ist wieder rot");
    const names = lines.map((entry) => (entry.querySelector("span[title]") as HTMLElement | null)?.style.color);
    assert.ok(names[0] !== undefined && names[0] !== "" && names[0] !== names[1], `Dienstfarben: ${names.join(", ")}`);
  } finally {
    server.restore();
    await unmount();
  }
});

test("das Aushängen bricht alle Ströme ab", async () => {
  const { server, unmount } = await mount("logs", [container("sonarr"), container("radarr")]);
  server.restore();
  await unmount();
  assert.deepEqual(openStreams(server.streams), []);
});
