// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle, settleQueries } from "./dom-harness.js";
import { composeSettled } from "./compose-harness.js";

import React from "react";
import { clearEditorDrafts } from "../src/platform/editor/useEditorDocument.js";

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRouter, Route, Routes } from "react-router";

import { en } from "../src/app/i18n/messages.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { StackScreen } from "../src/app/screens/StackScreen.js";
import { TooltipProvider } from "../src/platform/ui/shadcn/tooltip.js";
import type { HostOverview } from "contract";
import type { Role } from "../src/platform/session/session-user.js";

// The compose tab is a lazy view (#265): `StackScreen` loads it with
// `React.lazy`, and the first `import()` of its module graph takes longer than
// a test waits. Loaded here, every later `import()` resolves at once.
// `import()` and not `import`: a `.lazy.tsx` entry is dynamic only
// (`lazy-only-dynamic`).
await import("../src/features/compose/ComposeView.lazy.js");

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Reiterleiste der Stack-Seite (#35) hängt an zwei Zusagen, und beide sind
// still falsch, wenn man sie nicht misst:
//
//   1. DER GESCHLOSSENE REITER HOLT NICHTS. `ComposeView` fragt die
//      Compose-Datei ab, sobald es eingehängt ist, und JEDER dieser Abrufe
//      schreibt einen Audit-Eintrag auf dem Arm. Eine Fassung mit `hidden`
//      statt einer Verzweigung sähe genauso aus und schickte die Anfrage
//      trotzdem. Geprüft wird deshalb am AUSGEBLIEBENEN AUFRUF und nicht am
//      Text — dieselbe Bauart wie in `container-screen.test.tsx`.
//   2. OHNE ADMINROLLE GIBT ES DEN COMPOSE-REITER NICHT. Alle drei
//      Compose-Routen stehen hinter `requireAdmin`; ein sichtbarer Reiter wäre
//      ein Bedienelement, das in einer `403` endet. Das Protokoll (#183) liest
//      dagegen jede Rolle — die Leiste steht deshalb seitdem für jeden da.

const HOST_ID = "arm-1";
const PROJECT = "medien";
const CONTAINER_ID = "c-sonarr";

type Call = { method: string; url: string; body?: unknown };

/** Was der Fake auf Vorschau und Anwenden antwortet. */
type Scripted = {
  preview?: Record<string, unknown>;
  /** Die NDJSON-Zeilen des Anwendens, je Versuch eine Liste. */
  applyRounds?: Record<string, unknown>[][];
  /**
   * Wie `compose up`: ein Anwenden mit Ergebnis ersetzt den Container durch
   * einen mit dieser Kennung, und die Datei trägt danach den angewandten Text
   * (#233). Die alte Kennung kennt der Fake danach nicht mehr.
   */
  replaceOnApply?: string;
};

// A complete wire shape: the screen parses `/api/overview` against the
// contract since #248, and an incomplete fixture fails there.
function overview(containerId = CONTAINER_ID): HostOverview[] {
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
      stacks: [
        {
          project: PROJECT,
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
              name: "sonarr",
              image: "sonarr:1",
              status: "running",
              running: true,
              startedAt: null,
              health: null,
              compose: { project: PROJECT, service: "sonarr" },
              stats: null,
              externalManagement: null,
              state: "ok",
              marks: [],
              system: false
            }
          ]
        }
      ],
      loose: [],
      error: null
    }
  ];
}

function dryRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "agent",
    valid: true,
    reason: null,
    errors: [],
    configError: null,
    services: ["sonarr", "radarr"],
    diff: { remaining: ["sonarr"], new: ["radarr"], removed: [] },
    imagesByService: { sonarr: "sonarr:1", radarr: "radarr:1" },
    missingImages: [],
    servicesWithoutImage: [],
    inventoryViolations: [],
    composeHash: "h1",
    stackName: PROJECT,
    currentServices: ["sonarr"],
    steps: ["validate", "confirm"],
    uncertainties: [],
    ...overrides
  };
}

function stubHub(scripted: Scripted = {}): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let applyRound = 0;
  let containerId = CONTAINER_ID;
  let content = "services:\n  sonarr:\n    image: sonarr:1\n";
  let hash = "h1";
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.includes("/api/overview")) return Promise.resolve(json({ hosts: overview(containerId) }));
    // Wie der Hub: eine Kennung, die der Arm nicht mehr führt, ist ein 404.
    if (url.includes("/containers/") && !url.includes(`/containers/${containerId}/`)) {
      return Promise.resolve(json({ error: "container-unknown", message: "gone" }, 404));
    }
    if (url.includes("/api/marks")) return Promise.resolve(json({ marks: [] }));
    if (url.endsWith("/compose/preview")) {
      return Promise.resolve(json({ preview: scripted.preview ?? dryRun() }));
    }
    if (method === "POST" && url.endsWith("/compose")) {
      const lines = scripted.applyRounds?.[applyRound] ?? [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "step", step: "write-file" },
        { kind: "result", applied: { ok: true }, resync: { status: "synced", error: null } }
      ];
      applyRound += 1;
      if (scripted.replaceOnApply !== undefined && lines.some((line) => line.kind === "result")) {
        containerId = scripted.replaceOnApply;
        content = (body as { content: string }).content;
        hash = `h${String(applyRound + 1)}`;
      }
      const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
      return Promise.resolve(
        new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson" } })
      );
    }
    // The `.env` of the project (#265): masked, the values only on `plaintext=1`.
    if (url.includes("/compose/env")) {
      const plaintext = url.includes("plaintext=1");
      return Promise.resolve(
        json({
          env: {
            projectDir: "/opt/stacks/medien",
            composeFileName: "compose.yaml",
            filePresent: true,
            plaintext,
            entries: [
              { key: "API_KEY", inFile: true, empty: false, ...(plaintext ? { value: "s3cret-value" } : {}) },
              { key: "PUBLIC", inFile: true, empty: false, ...(plaintext ? { value: "unrevealed-public-value" } : {}) },
              { key: "DB_PASSWORD", inFile: true, empty: false, ...(plaintext ? { value: "unrevealed-password-value" } : {}) }
            ]
          }
        })
      );
    }
    if (url.includes("/compose")) {
      return Promise.resolve(
        json({
          compose: {
            projectDir: "/opt/stacks/medien",
            composeFileName: "compose.yaml",
            stackName: PROJECT,
            content,
            composeHash: hash,
            services: ["sonarr"],
            servicesInFile: ["sonarr"],
            fileReadable: true,
            containerIds: { sonarr: containerId },
            inventoryViolations: []
          }
        })
      );
    }
    return Promise.resolve(json({}));
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

async function mount(tab: "overview" | "compose", role: Role = "admin", scripted: Scripted = {}) {
  clearEditorDrafts();
  const server = stubHub(scripted);
  // ⚠️ DER `TooltipProvider` GEHÖRT ZUM PRÜFSTAND UND NICHT ZUM BAUTEIL.
  // `StackScreen` steht in der Anwendung unter `AppShell`, und der setzt ihn an
  // die Wurzel (`AppShell.tsx`, `App.tsx` Z. 140); `host-status.tsx` hängt seit
  // #4 an derselben Zusage. Ohne ihn wirft Radix hier „`Tooltip` must be used
  // within `TooltipProvider`" — gemessen beim Einbau des Symbols in #157, mit
  // 16 roten Fällen aus einer Ursache. Der Prüfstand stellt damit die ECHTE
  // Zusammensetzung nach; ein Anbieter IM Bauteil wäre der zweite in derselben
  // Seite und hätte den Prüfstand statt der Anwendung bedient.
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/stack/${HOST_ID}/${PROJECT}${tab === "compose" ? "/compose" : ""}`]}>
          <Routes>
            <Route path="/stack/:hostId/:project" element={<StackScreen role={role} tab="overview" />} />
            <Route path="/stack/:hostId/:project/compose" element={<StackScreen role={role} tab="compose" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </AppLanguageProvider>
  );
  // The overview comes through Query since #271, the compose file only after
  // it: settled until no query is in flight, not by a counted `settle()`.
  await settleQueries(mounted.queryClient);
  if (tab === "compose" && role === "admin") {
    assert.ok(await composeSettled(), "ComposeView did not settle");
    await settleQueries(mounted.queryClient);
  }
  return { server, ...mounted };
}

function composeCalls(server: { calls: Call[] }): Call[] {
  return server.calls.filter((call) => call.url.includes("/containers/") && call.url.includes("/compose"));
}

test("der geschlossene Reiter holt keine Compose-Datei", async () => {
  const { server, unmount } = await mount("overview");
  try {
    // ⚠️ Am ausgebliebenen AUFRUF und nicht am Text. Eine Fassung mit `hidden`
    // bestünde jede Prüfung, die nur nachsieht, ob etwas sichtbar ist — und
    // schriebe trotzdem bei jedem Öffnen der Stack-Seite einen Audit-Eintrag
    // auf dem Arm.
    assert.deepEqual(composeCalls(server), []);
  } finally {
    server.restore();
    await unmount();
  }
});

test("der offene Reiter holt sie genau einmal", async () => {
  const { server, unmount } = await mount("compose");
  try {
    assert.equal(composeCalls(server).length, 1);
    assert.match(composeCalls(server)[0].url, /\/containers\/c-sonarr\/compose$/);
  } finally {
    server.restore();
    await unmount();
  }
});

/** Die Kennungen der Reiter, in der Reihenfolge, in der sie stehen. */
function tabIds(): string[] {
  return [...document.querySelectorAll('[data-testid^="stack-tab-"]')].map(
    (tab) => tab.getAttribute("data-testid") ?? ""
  );
}

test("drei Reiter für den Admin, zwei ohne Rolle — Compose fehlt dort", async () => {
  const asAdmin = await mount("overview", "admin");
  try {
    // ⚠️ Genau drei, in der Reihenfolge des Artboards. Es zeigt sechs; drei
    // davon gibt es nicht, und ein ausgegrauter Reiter ist ein Versprechen,
    // das die Fläche nicht hält.
    assert.deepEqual(tabIds(), ["stack-tab-overview", "stack-tab-logs", "stack-tab-compose"]);
  } finally {
    asAdmin.server.restore();
    await asAdmin.unmount();
  }

  const asUser = await mount("overview", "user");
  try {
    assert.deepEqual(tabIds(), ["stack-tab-overview", "stack-tab-logs"]);
  } finally {
    asUser.server.restore();
    await asUser.unmount();
  }
});

test("ein Stack ohne Container sagt das, statt einen Fehler zu zeigen", async () => {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    const hosts = overview();
    hosts[0].stacks[0].containers = [];
    const payload = url.includes("/api/marks") ? { marks: [] } : { hosts };
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
    );
  }) as typeof fetch;

  const mounted = await renderInDom(
    <AppLanguageProvider>
      <MemoryRouter initialEntries={[`/stack/${HOST_ID}/${PROJECT}/compose`]}>
        <Routes>
          <Route path="/stack/:hostId/:project/compose" element={<StackScreen role="admin" tab="compose" />} />
        </Routes>
      </MemoryRouter>
    </AppLanguageProvider>
  );
  try {
    assert.ok(await composeSettled(), "ComposeView did not settle");
    // ⚠️ KEIN AUFRUF. Ohne Container gibt es keinen Anker in die Datei, und
    // ein Abruf mit leerer Kennung liefe in eine 404, die wie eine Störung
    // aussieht.
    assert.deepEqual(
      calls.filter((call) => call.url.includes("/containers/")),
      []
    );
    // ⚠️ Gegen den TEXT AUS DER SPRACHDATEI und nicht gegen einen abgetippten
    // Satz: `LanguageProvider` steht im Test auf Englisch, und ein Test, der
    // den deutschen Wortlaut sucht, wäre grün oder rot je nach Vorgabesprache.
    assert.ok((document.body.textContent ?? "").includes(en.composeNoContainer));
  } finally {
    globalThis.fetch = original;
    await mounted.unmount();
  }
});


// ── Der Editor (Etappe E6a) ────────────────────────────────────────────────

/** Der Rumpf eines abgesetzten Aufrufs, mit den Feldern dieser Fläche. */
type SentBody = {
  confirmNew?: string[];
  confirmRemoved?: string[];
  acknowledgeImagePull?: string[];
  acknowledgeHardening?: string[];
  expectedComposeHash?: string;
  stackName?: string;
};

/** Ein Knopf mit dieser Kennung — als Knopf, nicht als beliebiges Element. */
function button(testId: string): HTMLButtonElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element, `Knopf „${testId}" fehlt`);
  return element as HTMLButtonElement;
}

/** Das Textfeld des Editors, nachdem „Bearbeiten" gedrückt wurde. */
function editorField(): HTMLTextAreaElement {
  const field = document.querySelector('[data-testid="compose-editor"]');
  assert.ok(field, "das Textfeld des Editors fehlt");
  return field as HTMLTextAreaElement;
}

async function click(testId: string): Promise<void> {
  const button = document.querySelector(`[data-testid="${testId}"]`);
  assert.ok(button, `Knopf „${testId}" fehlt`);
  (button as HTMLElement).click();
  await settle();
}

async function typeInto(field: HTMLTextAreaElement, text: string): Promise<void> {
  // React hört auf das native `input`-Ereignis; ein blosses Setzen von `value`
  // bliebe für den Zustand unsichtbar.
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    "value"
  )?.set;
  setter?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function openEditor(scripted: Scripted = {}) {
  const mounted = await mount("compose", "admin", scripted);
  const editButton = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === en.composeEdit
  );
  assert.ok(editButton, "der Knopf zum Bearbeiten fehlt");
  editButton.click();
  await settle();
  return mounted;
}

// ── Die Tastenbelegung für den Zeiger (#157) ────────────────────────────────
//
// Seit #135 rückt Tab im Editor ein, und der Satz dazu stand nur in einem
// `sr-only`-Absatz am Feld: mit der Maus war er nirgends zu sehen. Das Symbol
// in der Kopfkarte holt ihn hervor, und drei Dinge daran können still falsch
// werden.

/** Öffnet den Tooltip am Symbol und gibt seinen Text zurück. */
async function hintText(): Promise<string> {
  const trigger = button("compose-keyboard-hint");
  // ⚠️ EIN `PointerEvent` UND KEIN `mouseenter`. Radix hört am Auslöser auf
  // `onPointerMove` und prüft dort `pointerType`; ein Mausereignis ohne diese
  // Angabe geht ins Leere, und der Tooltip bliebe zu — der Fall sähe dann aus,
  // als gäbe es ihn nicht (AGENTS.md, „Der Wächter passt sich dem Code an").
  await React.act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
  });
  await settle();
  // Der Inhalt hängt in einem Portal am `body` und nicht im Auslöser.
  const content = document.querySelector('[data-slot="tooltip-content"]');
  assert.ok(content, "der Tooltip öffnet nicht");
  return content.textContent ?? "";
}

test("das Symbol steht erst da, wenn der Editor offen ist", async () => {
  const mounted = await mount("compose");
  try {
    // ⚠️ Im Reiter „Datei" gibt es kein Feld, in dem Tab etwas täte. Ein
    // Symbol, das dort schon steht, verspricht eine Tastenbelegung für eine
    // Fläche, die nur liest.
    assert.ok(
      document.querySelector('[data-testid="compose-keyboard-hint"]') === null,
      "das Symbol steht schon im Lesereiter"
    );
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }

  const editing = await openEditor();
  try {
    assert.ok(
      document.querySelector('[data-testid="compose-keyboard-hint"]') !== null,
      "das Symbol fehlt, während der Editor offen ist"
    );
  } finally {
    editing.server.restore();
    await editing.unmount();
  }
});

test("der Tooltip sagt dasselbe wie die Beschreibung des Feldes", async () => {
  const mounted = await openEditor();
  try {
    // ⚠️ GEGEN DIE BESCHREIBUNG DES FELDES und nicht zweimal gegen die
    // Sprachdatei. Was hier fällt, ist der Fall, dass jemand für den Tooltip
    // einen zweiten Schlüssel anlegt: dann stehen zwei Sätze im Repo, und der
    // ungelesene veraltet still. Ein Vergleich beider Orte gegen `en` wäre mit
    // genau diesem Fehler einverstanden.
    const describedBy = editorField().getAttribute("aria-describedby");
    assert.ok(describedBy, "das Feld verweist auf keine Beschreibung");
    const description = document.getElementById(describedBy)?.textContent ?? "";

    assert.equal(await hintText(), description);
    // Und die Gegenprobe, dass beide überhaupt etwas sagen.
    assert.equal(description, en.editorKeyboardHint);
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("das Symbol bleibt in der Tab-Reihenfolge und trägt einen Namen", async () => {
  const mounted = await openEditor();
  try {
    const trigger = button("compose-keyboard-hint");
    // ⚠️ KEIN `tabindex="-1"`. Es herauszunehmen ist naheliegend — die
    // Vorlesehilfe bekommt den Satz am Feld ohnehin —, und es nähme genau
    // demjenigen den Zugang, um dessen Bedienung es hier geht.
    assert.ok(
      trigger.getAttribute("tabindex") !== "-1",
      "der Auslöser ist aus der Tab-Reihenfolge genommen"
    );
    // Ein Knopf, der nur ein Symbol trägt, heißt für eine Vorlesehilfe „Knopf".
    assert.match(trigger.textContent ?? "", new RegExp(en.composeEditKeyboardTitle));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("das Textfeld trägt den geladenen Stand, zeichengenau", async () => {
  const mounted = await openEditor();
  try {
    assert.equal(editorField().value, "services:\n  sonarr:\n    image: sonarr:1\n");
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("eine Änderung wird als ungespeichert ausgewiesen", async () => {
  const mounted = await openEditor();
  try {
    assert.equal(document.querySelector('[data-testid="compose-dirty"]'), null);
    await typeInto(editorField(), "services:\n  sonarr:\n    image: sonarr:2\n");
    // ⚠️ Der Hinweis ist die einzige Auskunft darüber, dass etwas zu verlieren
    // ist. Ohne ihn sieht ein bearbeiteter Entwurf aus wie ein geladener.
    assert.ok(document.querySelector('[data-testid="compose-dirty"]'));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("Verwerfen fragt zurück und nennt dabei, was verloren geht", async () => {
  const mounted = await openEditor();
  const originalConfirm = window.confirm;
  const asked: string[] = [];
  try {
    await typeInto(editorField(), "services:\n  sonarr:\n    image: sonarr:2\n");

    // ⚠️ ERST ABLEHNEN. Ein „Verwerfen", das trotz Nein verwirft, wäre genau
    // der Datenverlust, gegen den die Rückfrage steht — und ein Test, der nur
    // den Ja-Fall prüft, sähe ihn nicht.
    window.confirm = ((message: string) => {
      asked.push(message);
      return false;
    }) as typeof window.confirm;
    await click("compose-discard");
    assert.ok(document.querySelector('[data-testid="compose-dirty"]'), "bei Nein bleibt der Entwurf");
    assert.equal(asked.length, 1);
    assert.ok(asked[0].length > 20, "die Rückfrage nennt, was verloren geht, statt bloss zu fragen");

    window.confirm = (() => true) as typeof window.confirm;
    await click("compose-discard");
    assert.equal(document.querySelector('[data-testid="compose-dirty"]'), null, "bei Ja ist er weg");
  } finally {
    window.confirm = originalConfirm;
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("der Reiterwechsel fragt bei geändertem Entwurf und behält ihn nach Nein", async () => {
  const mounted = await openEditor();
  const originalConfirm = window.confirm;
  const asked: string[] = [];
  try {
    await typeInto(editorField(), "services:\n  sonarr:\n    image: sonarr:2\n");
    window.confirm = ((message: string) => {
      asked.push(message);
      return false;
    }) as typeof window.confirm;

    await click("stack-tab-overview");
    assert.deepEqual(asked, [en.composeDiscardConfirm]);
    assert.equal(editorField().value, "services:\n  sonarr:\n    image: sonarr:2\n");
    assert.ok(document.querySelector('[data-testid="compose-dirty"]'));
    assert.equal(document.querySelector('[data-testid="stack-tab-compose"]')?.getAttribute("aria-current"), "page");

    window.confirm = ((message: string) => {
      asked.push(message);
      return true;
    }) as typeof window.confirm;
    await click("stack-tab-overview");
    assert.deepEqual(asked, [en.composeDiscardConfirm, en.composeDiscardConfirm]);
    assert.ok(editorFieldOrNull() === null, "nach Ja ist der Editor ausgehängt");
    assert.equal(document.querySelector('[data-testid="stack-tab-overview"]')?.getAttribute("aria-current"), "page");

    // The draft is gone with the view; coming back must not ask again for a
    // draft that no longer exists (#265).
    window.confirm = (() => {
      throw new Error("nach dem Verwerfen darf beim Zurückwechseln keine Rückfrage kommen");
    }) as typeof window.confirm;
    await click("stack-tab-compose");
    assert.equal(composeCalls(mounted.server).length, 2, "nach Rückkehr wird die Datei neu geholt");
    assert.ok(document.querySelector('[data-testid="compose-dirty"]') === null);
  } finally {
    window.confirm = originalConfirm;
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("der Reiterwechsel ohne Änderung fragt nicht", async () => {
  const mounted = await openEditor();
  const originalConfirm = window.confirm;
  try {
    window.confirm = (() => {
      throw new Error("ohne Änderung darf keine Rückfrage kommen");
    }) as typeof window.confirm;
    await click("stack-tab-overview");
    assert.equal(document.querySelector('[data-testid="stack-tab-overview"]')?.getAttribute("aria-current"), "page");
  } finally {
    window.confirm = originalConfirm;
    mounted.server.restore();
    await mounted.unmount();
  }
});

function editorFieldOrNull(): HTMLTextAreaElement | null {
  return document.querySelector('[data-testid="compose-editor"]');
}

test("Neu laden fragt genau einmal neu und nimmt den Entwurf mit (#265)", async () => {
  const mounted = await openEditor();
  const originalConfirm = window.confirm;
  try {
    await typeInto(editorField(), "services:\n  sonarr:\n    image: sonarr:2\n");
    assert.equal(composeCalls(mounted.server).length, 1);

    window.confirm = (() => true) as typeof window.confirm;
    await click("compose-reload");

    assert.equal(composeCalls(mounted.server).length, 2, "genau eine Anfrage mehr");
    assert.equal(document.querySelector('[data-testid="compose-dirty"]'), null, "der Entwurf ist weg");
    assert.ok(document.querySelector('[data-testid="compose-reload"]'), "die Datei steht wieder da");
  } finally {
    window.confirm = originalConfirm;
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("die .env steht maskiert da, der Klartext kommt auf Klick und geht mit Verbergen, ohne neue Anfrage (#265)", async () => {
  const mounted = await mount("compose");
  const envCalls = () => mounted.server.calls.filter((call) => call.url.includes("/compose/env"));
  try {
    assert.deepEqual(envCalls(), [], "ohne den Reiter .env keine Anfrage");
    const envTab = [...document.querySelectorAll("button")].find((entry) => entry.textContent === en.composeEnvFileName);
    assert.ok(envTab, "der Reiter .env fehlt");
    envTab.click();
    await settle();

    assert.equal(envCalls().length, 1);
    const content = () => document.querySelector('[data-testid="compose-env-content"]')?.textContent ?? "";
    assert.ok(content().includes("API_KEY"));
    assert.ok(!content().includes("s3cret-value"), "maskiert");

    const reveal = [...document.querySelectorAll("button")].find((entry) => entry.textContent === en.editorRevealValue.replace("{key}", "API_KEY"));
    assert.ok(reveal, "der Knopf zum Anzeigen fehlt");
    reveal.click();
    await settle();
    assert.equal(envCalls().length, 2);
    assert.match(envCalls()[1].url, /compose\/env\?plaintext=1$/);
    assert.ok(content().includes("s3cret-value"), "Klartext nach dem Klick");
    assert.equal(content().includes("unrevealed-public-value"), false);
    assert.equal(content().includes("unrevealed-password-value"), false);

    const hide = [...document.querySelectorAll("button")].find((entry) => entry.textContent === en.editorHideValue.replace("{key}", "API_KEY"));
    assert.ok(hide, "der Knopf zum Verbergen fehlt");
    hide.click();
    await settle();
    assert.equal(envCalls().length, 2, "Verbergen fragt nicht neu");
    assert.ok(!content().includes("s3cret-value"), "wieder maskiert");
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("der Vergleich zeigt genau die eine geänderte Zeile", async () => {
  const mounted = await openEditor();
  try {
    await typeInto(editorField(), "services:\n  sonarr:\n    image: sonarr:2\n");
    await click("compose-show-diff");
    const text = document.body.textContent ?? "";
    // +1 · −1 — nicht „alles ab Zeile 3 ist neu".
    assert.ok(text.includes("+1"), `„+1" fehlt in: ${text.slice(0, 200)}`);
    assert.ok(text.includes("−1"));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("ohne Änderung sagt der Vergleich das, statt eine leere Fläche zu zeigen", async () => {
  const mounted = await openEditor();
  try {
    await click("compose-show-diff");
    assert.ok((document.body.textContent ?? "").includes(en.composeDiffNone));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});


// ── Vorschau, Bestätigungen, Anwenden (Etappe E6b) ─────────────────────────

const CHANGED = "services:\n  sonarr:\n    image: sonarr:1\n  radarr:\n    image: radarr:1\n";

async function toPreview(scripted = {}) {
  const mounted = await openEditor(scripted);
  await typeInto(editorField(), CHANGED);
  await click("compose-to-apply");
  return mounted;
}

test("die Vorschau sagt, WER gerechnet hat", async () => {
  const mounted = await toPreview();
  try {
    // ⚠️ Beim eigenen Rechenweg sind `extends` und Profile NICHT aufgelöst und
    // die fehlenden Images kennt niemand. Eine Vorschau, die verschweigt, dass
    // sie eine Näherung ist, wiegt den Betreiber in Sicherheit.
    const source = document.querySelector('[data-testid="compose-preview-source"]');
    assert.ok(source);
    assert.equal(source.textContent, en.composePreviewByAgent);
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("der Knopf bleibt gesperrt, bis jeder neue Service bestätigt ist", async () => {
  const mounted = await toPreview();
  try {
    assert.equal(button("compose-apply").disabled, true, "ohne Bestätigung darf nichts hinausgehen");
    assert.ok(document.querySelector('[data-testid="compose-blocker"]'), "und der Grund steht daneben");

    await click("confirm-new-radarr");
    assert.equal(button("compose-apply").disabled, false);
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("das Anwenden schickt die bestätigte Liste und meldet die Schritte", async () => {
  const mounted = await toPreview();
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();

    const sent = mounted.server.calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/compose")
    );
    assert.ok(sent, "das Anwenden ist nicht hinausgegangen");
    const body = sent.body as SentBody;
    // ⚠️ GENAU die bestätigte Menge. Der Agent prüft Mengengleichheit.
    assert.deepEqual(body.confirmNew, ["radarr"]);
    assert.equal(body.expectedComposeHash, "h1");
    // ⚠️ Der Stackname steht NICHT im Rumpf: den setzt der Server aus seinem
    // eigenen Leseaufruf ein. Stünde er hier, prüfte der Agent, ob der Browser
    // sich selbst zustimmt.
    assert.equal(body.stackName, undefined);

    assert.ok(document.querySelector('[data-testid="compose-applied"]'));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("ein gescheiterter Abgleich wird gesagt, obwohl das Anwenden gilt", async () => {
  const mounted = await toPreview({
    applyRounds: [
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "result", applied: { ok: true }, resync: { status: "failed", error: "Arm abgelehnt" } }
      ]
    ]
  });
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();
    // ⚠️ Ohne diese Zeile lehnt der Arm jede weitere Aktion an diesem Stack ab,
    // und das sieht wie ein Rechteproblem aus.
    assert.ok(document.querySelector('[data-testid="compose-resync-warning"]'));
    assert.ok(document.querySelector('[data-testid="compose-applied"]'), "das Anwenden gilt trotzdem");
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("ein unveränderter Abgleich warnt nicht: die quittierte Liste stimmt (#179)", async () => {
  const mounted = await toPreview({
    applyRounds: [
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "result", applied: { ok: true }, resync: { status: "unchanged", error: null } }
      ]
    ]
  });
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();
    assert.ok(document.querySelector('[data-testid="compose-applied"]'));
    assert.ok(
      document.querySelector('[data-testid="compose-resync-warning"]') === null,
      "unchanged heißt: die Liste beim Agenten ist die gerechnete"
    );
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("nach dem Anwenden liest der Reiter mit der NEUEN Kennung neu, und ein zweites Anwenden geht durch (#233)", async () => {
  // Gemessen am 2026-09-30 am Arm `local`: nach „Angewandt." hielt der Reiter
  // den alten Text als geladenen Stand und die alte Kennung als Anker; das
  // zweite Anwenden im selben Reiter endete im `404 container-unknown`.
  const mounted = await toPreview({ replaceOnApply: "c-sonarr-2" });
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();
    await settle();

    assert.ok(document.querySelector('[data-testid="compose-applied"]'), "der Vermerk steht über der Datei");
    assert.ok(
      !(document.body.textContent ?? "").includes(en.composeUnsaved),
      "der angewandte Text ist der geladene Stand und kein Entwurf mehr"
    );
    assert.ok(
      document.querySelector('[data-testid="compose-error"]') === null,
      "kein Neulesen mit der alten Kennung"
    );
    const reads = composeCalls(mounted.server).filter((call) => call.method === "GET");
    assert.match(reads.at(-1)?.url ?? "", /\/containers\/c-sonarr-2\/compose$/);
    assert.equal(
      mounted.server.calls.filter((call) => call.url.includes("/api/overview")).length,
      2,
      "die Übersicht ist nach dem Anwenden neu gelesen"
    );

    // Zweite Runde im selben Reiter, ohne Neuladen der Seite.
    const edit = [...document.querySelectorAll("button")].find((button) => button.textContent === en.composeEdit);
    assert.ok(edit, "der Knopf zum Bearbeiten fehlt nach dem Anwenden");
    edit.click();
    await settle();
    assert.ok(document.querySelector('[data-testid="compose-applied"]') === null, "Bearbeiten räumt den Vermerk weg");
    await typeInto(editorField(), `${CHANGED}  # zweite Runde\n`);
    await click("compose-to-apply");
    const previews = mounted.server.calls.filter((call) => call.url.endsWith("/compose/preview"));
    assert.match(previews.at(-1)?.url ?? "", /\/containers\/c-sonarr-2\/compose\/preview$/);
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("eine Rückfrage nach Images schickt die Liste DES ARMS zurück", async () => {
  const mounted = await toPreview({
    // Der Arm kennt die fehlenden Images vorab nicht.
    preview: dryRun({ missingImages: null }),
    applyRounds: [
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "question", question: { kind: "images", missing: ["radarr:1"] } }
      ],
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "result", applied: { ok: true }, resync: { status: "synced", error: null } }
      ]
    ]
  });
  try {
    // Ohne erhobene Images sperrt nichts — der Arm fragt danach.
    assert.ok(document.querySelector('[data-testid="compose-images-unknown"]'));
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();

    assert.ok(document.querySelector('[data-testid="compose-question"]'));
    await click("compose-answer");
    await settle();

    const attempts = mounted.server.calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/compose")
    );
    assert.equal(attempts.length, 2);
    // ⚠️ Die Liste kommt AUS DER ANTWORT DES ARMS und wird nicht selbst
    // gebildet: die Prüfung ist Mengengleichheit.
    assert.deepEqual((attempts[1].body as SentBody).acknowledgeImagePull, ["radarr:1"]);
    assert.ok(document.querySelector('[data-testid="compose-applied"]'));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("die unlesbare Image-Angabe steht als Rückfrage ohne Knopf da", async () => {
  // ⚠️ Diese Rückfrage fällt in der Prüfphase, bevor der Arm schreibt. Sie
  // trägt die Angabe mit, weil der Arm nur den String kennt und keine Zeile.
  // Es folgt KEIN zweiter Versuch: darum nur eine Runde.
  const mounted = await toPreview({
    preview: dryRun(),
    applyRounds: [
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "question", question: { kind: "image-ref-unreadable", ref: "sonarr::2" } }
      ]
    ]
  });
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();

    const card = document.querySelector('[data-testid="compose-question"]');
    assert.ok(card);
    // ⚠️ Die Fläche rendert in dieser Datei ENGLISCH — geprüft wird gegen en.ts.
    const text = card.textContent ?? "";
    assert.ok(text.includes("sonarr::2"), "die Angabe des Arms steht in der Karte");
    assert.ok(text.includes("Nothing"), "die Karte sagt, dass nichts geschrieben wurde");
    // ⚠️ Kein Knopf: eine Bestätigung läuft in dieselbe Ablehnung. Und keine
    // Zeile zum Rollback: geschrieben ist nichts, es gibt nichts zu rollen.
    assert.ok(!document.querySelector('[data-testid="compose-answer"]'));
    assert.ok(!document.querySelector('[data-testid="compose-not-rolled-back"]'));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("der veraltete Anker steht als Rückfrage ohne Knopf da", async () => {
  // ⚠️ Der Eintrag des Stacks wandert bei jedem Ersetzen des Containers auf
  // eine neue Id; der Hub spricht dann eine an, die es beim Arm nicht mehr
  // gibt. Auch das fällt vor dem Schreiben, und auch das hat keine Antwort.
  const mounted = await toPreview({
    preview: dryRun(),
    applyRounds: [
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "question", question: { kind: "anchor-stale" } }
      ]
    ]
  });
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();

    const card = document.querySelector('[data-testid="compose-question"]');
    assert.ok(card);
    assert.ok((card.textContent ?? "").includes("Nothing"), "die Karte sagt, dass nichts geschrieben wurde");
    assert.ok(!document.querySelector('[data-testid="compose-answer"]'));
    assert.ok(!document.querySelector('[data-testid="compose-not-rolled-back"]'));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});

test("ein Strom ohne Ergebnis heißt UNBEKANNT und nicht „nicht angewandt“", async () => {
  const mounted = await toPreview({
    applyRounds: [
      [
        { kind: "start", stackName: PROJECT, projectDir: "/opt", composeFileName: "compose.yaml" },
        { kind: "step", step: "write-file" }
      ]
    ]
  });
  try {
    await click("confirm-new-radarr");
    await click("compose-apply");
    await settle();
    // ⚠️ Die Datei kann geschrieben und der Stack halb gestartet sein. „Ging
    // nicht" schickte den Betreiber in einen zweiten Versuch gegen einen Hash,
    // der nicht mehr stimmt.
    assert.ok(document.querySelector('[data-testid="compose-failed"]'));
    assert.ok((document.body.textContent ?? "").includes(en.composeApplyUnknown));
  } finally {
    mounted.server.restore();
    await mounted.unmount();
  }
});
