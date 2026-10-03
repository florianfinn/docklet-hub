// Das Ausblenden eines Stacks auf der Übersicht: Kontextmenü an der
// Stack-Zeile und der zugeklappte Abschnitt am Ende des Hosts.
//
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — die
// Begründung steht im Kopf von `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRouter } from "react-router";

import type { HostOverview, OverviewContainer, StackView } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import { HostGroup } from "../src/features/containers/HostGroup.js";

// WAS DIESE DATEI PRÜFT
//
//   1. Ein ausgeblendeter Stack steht NICHT zwischen den übrigen, sondern in
//      einem Abschnitt am Ende des Hosts, und der fängt zugeklappt an.
//   2. Eine Suche, die ihn trifft, klappt den Abschnitt auf — sonst fände sie
//      ihn nicht sichtbar.
//   3. Ein Rechtsklick auf die Stack-Zeile öffnet das Menü, und „Ausblenden"
//      meldet Projekt und neuen Stand nach oben.
//   4. Ohne Rückruf (keine Adminrolle) fehlt der Eintrag, „Stack öffnen"
//      bleibt.
//
// NICHT geprüft: dass der Server `hidden` speichert — das prüft
// `server/src/app/mark-routes.test.ts`.
//
// ⚠️ Die Sprache des Prüfstands folgt der des Browsers, und happy-dom meldet
// Englisch. Verglichen wird deshalb gegen die Texte BEIDER Sprachdateien —
// dieselbe Bauart wie `agent-update.test.tsx`.

/** Ob ein Text der deutschen oder der englischen Fassung eines Schlüssels entspricht. */
function isEither(text: string | null | undefined, key: keyof typeof de): boolean {
  return text === de[key] || text === en[key];
}

function containerOf(project: string): OverviewContainer {
  return {
    id: `${project}-id`,
    name: `${project}-web-1`,
    image: "demo:1.0.0",
    status: "Up 2 hours",
    running: true,
    startedAt: null,
    health: null,
    compose: { project, service: "web" },
    stats: null,
    externalManagement: null,
    state: "ok",
    marks: [],
    system: false
  };
}

function stackOf(project: string, hidden: boolean): StackView {
  return {
    project,
    state: "ok",
    running: 1,
    marks: [],
    indent: "nested",
    hidden,
    system: false,
    total: 1,
    containers: [containerOf(project)]
  };
}

function hostOf(stacks: StackView[]): HostOverview {
  return {
    host: {
      id: "host-1",
      name: "haus",
      agentUrl: "https://agent.test",
      kind: "internal",
      state: "registered",
      status: "online",
      agentVersion: "0.18.1",
      tunnelAddress: null,
      display: { hue: "neutral", ink: "edge" },
      agentUpdate: null,
      lastSeenAt: null
    },
    agent: { reachable: true, version: "0.18.1", contractVersion: null, readOnly: false, entries: null },
    stacks,
    loose: [],
    error: null
  };
}

async function mount(
  entry: HostOverview,
  options: { query?: string; onHiddenChange?: (project: string, hidden: boolean) => void } = {}
) {
  return renderInDom(
    <AppLanguageProvider>
      <MemoryRouter>
        <HostGroup entry={entry} filter="all" query={options.query ?? ""} onHiddenChange={options.onHiddenChange} />
      </MemoryRouter>
    </AppLanguageProvider>
  );
}

/** Die Stack-Zeile zu einem Projekt: der Knopf, der seinen Namen trägt. */
function rowOf(container: HTMLElement, project: string): HTMLElement {
  const name = [...container.querySelectorAll("span.font-mono")].find((node) => node.textContent === project);
  assert.ok(name, `keine Zeile für ${project}`);
  const row = name.closest("div");
  assert.ok(row, `keine Zeile um ${project}`);
  return row as HTMLElement;
}

async function openMenu(row: HTMLElement): Promise<void> {
  await React.act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await settle();
}

test("ein ausgeblendeter Stack steht zugeklappt am Ende des Hosts", async () => {
  const mounted = await mount(hostOf([stackOf("alpha", true), stackOf("beta", false)]));
  try {
    const section = mounted.container.querySelector('[data-testid="hidden-stacks"]');
    assert.ok(section !== null, "kein Abschnitt für ausgeblendete Stacks");
    // Zugeklappt zeichnet Radix den Inhalt nicht: „alpha" steht nirgends.
    assert.ok(!(mounted.container.textContent ?? "").includes("alpha"), "der ausgeblendete Stack ist sichtbar");
    assert.match(section.textContent ?? "", /· 1 stack$/i);
    // „beta" steht VOR dem Abschnitt.
    const beta = rowOf(mounted.container, "beta");
    assert.ok(
      (beta.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      "der Abschnitt steht nicht am Ende"
    );

    const trigger = section.querySelector("button");
    assert.ok(trigger !== null);
    await React.act(async () => trigger.click());
    assert.ok((mounted.container.textContent ?? "").includes("alpha"), "Aufklappen zeigt den Stack nicht");
  } finally {
    await mounted.unmount();
  }
});

test("eine Suche, die einen ausgeblendeten Stack trifft, klappt den Abschnitt auf", async () => {
  const mounted = await mount(hostOf([stackOf("alpha", true), stackOf("beta", false)]), { query: "alpha" });
  try {
    assert.ok((mounted.container.textContent ?? "").includes("alpha"), "der Treffer steht zugeklappt");
  } finally {
    await mounted.unmount();
  }
});

test("Rechtsklick → „Ausblenden“ meldet Projekt und neuen Stand", async () => {
  const calls: [string, boolean][] = [];
  const mounted = await mount(hostOf([stackOf("beta", false)]), {
    onHiddenChange: (project, hidden) => calls.push([project, hidden])
  });
  try {
    await openMenu(rowOf(mounted.container, "beta"));
    const item = document.querySelector<HTMLElement>('[data-testid="stack-menu-hidden"]');
    assert.ok(item !== null, "kein Eintrag „Ausblenden“ im Kontextmenü");
    assert.ok(isEither(item.textContent, "stackMenuHide"), `der Eintrag heißt „${item.textContent}“`);
    await React.act(async () => item.click());
    await settle();
    assert.deepEqual(calls, [["beta", true]]);
  } finally {
    await mounted.unmount();
  }
});

test("ohne Adminrolle steht im Kontextmenü nur „Stack öffnen“", async () => {
  const mounted = await mount(hostOf([stackOf("beta", false)]));
  try {
    await openMenu(rowOf(mounted.container, "beta"));
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu !== null, "das Kontextmenü ist nicht aufgegangen");
    assert.ok(isEither(menu.textContent, "stackMenuOpen"), `das Menü trägt „${menu.textContent}“`);
    assert.ok(document.querySelector('[data-testid="stack-menu-hidden"]') === null, "Ausblenden ohne Adminrolle");
  } finally {
    // Das Menü schließen, sonst stünde sein Portal im Dokument des nächsten Falls.
    await React.act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await mounted.unmount();
  }
});
