// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import { ComposeApply, HELD_STEP_CAP } from "../src/features/compose/ComposeApply.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Die Schrittliste des Anwendens wuchs bis #131 mit jedem `step`, den der
// Arm meldet — und wie viele das sind, entscheidet der Arm und nicht diese
// Fläche. Am Augenschein ist das nicht zu sehen: ein Anwenden mit fünf
// Schritten sieht mit und ohne Deckel gleich aus. Drei Fälle:
//
//   1. DER DECKEL GREIFT, und zwar vorne: das Neueste ist das, was jemand
//      liest — beim Anwenden noch mehr als im Log, weil der letzte Schritt der
//      laufende ist.
//   2. DIE VERWORFENEN WERDEN GESAGT. Ein stiller Deckel behauptet, der Vorgang
//      habe mit dem Schritt begonnen, der jetzt oben steht.
//   3. UNTER DEM DECKEL STEHT NICHTS DAVON. Ein Hinweis, der immer da ist, ist
//      keiner — und er wäre die bequemste Fassung, die Fall 2 besteht.

const ENCODER = new TextEncoder();

const PREVIEW = {
  source: "agent",
  valid: true,
  reason: null,
  errors: [],
  configError: null,
  services: ["sonarr"],
  // Kein neuer und kein entfallender Service: dann sperrt `blockerOf` nicht,
  // und der Knopf ist ohne einen einzigen Haken zu drücken.
  diff: { new: [], removed: [], kept: ["sonarr"] },
  imagesByService: { sonarr: "sonarr:1" },
  missingImages: [],
  servicesWithoutImage: [],
  inventoryViolations: [],
  composeHash: "h1",
  stackName: "media",
  currentServices: ["sonarr"],
  steps: [] as string[],
  uncertainties: []
};

type Chunk = { done: boolean; value?: Uint8Array };

type Pipe = {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
  reader: { read: () => Promise<Chunk>; cancel: () => Promise<void> };
};

/** Ein Rumpf, in den der Test einspeist — wann er will. */
function pipe(): Pipe {
  const queue: Uint8Array[] = [];
  let waiting: ((chunk: Chunk) => void) | null = null;
  let closed = false;

  return {
    push: (chunk: Uint8Array) => {
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending({ done: false, value: chunk });
        return;
      }
      queue.push(chunk);
    },
    finish: () => {
      closed = true;
      if (waiting !== null) {
        const pending = waiting;
        waiting = null;
        pending({ done: true });
      }
    },
    reader: {
      read: (): Promise<Chunk> => {
        const chunk = queue.shift();
        if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
        if (closed) return Promise.resolve({ done: true });
        return new Promise<Chunk>((resolve) => {
          waiting = resolve;
        });
      },
      cancel: (): Promise<void> => Promise.resolve()
    }
  };
}

/**
 * Der Hub als Attrappe: die Vorschau als Statusantwort, das Anwenden als Strom.
 *
 * ⚠️ DIE VORSCHAU KOMMT ZUERST UND IST KEIN STROM. Die Fläche holt sie beim
 * Einhängen; ohne sie steht sie für immer auf „wird geholt", und der Knopf, den
 * dieser Test drückt, existiert gar nicht.
 */
function stubHub(preview: typeof PREVIEW = PREVIEW): { body: Pipe; restore: () => void } {
  const original = globalThis.fetch;
  const body = pipe();

  globalThis.fetch = ((input: RequestInfo | URL) => {
    if (String(input).endsWith("/compose/preview")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ preview })
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      body: { getReader: () => body.reader }
    } as unknown as Response);
  }) as typeof fetch;

  return {
    body,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

async function mount(preview: typeof PREVIEW = PREVIEW) {
  const server = stubHub(preview);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <ComposeApply
        hostId="host-1"
        containerId="container-1"
        draft={"services:\n  sonarr:\n    image: sonarr:1\n"}
        expectedComposeHash="h1"
        changed
        onApplied={() => undefined}
        onReload={() => undefined}
        onClose={() => undefined}
      />
    </AppLanguageProvider>
  );
  // Die Vorschau hängt an einer Zusage: ohne diesen Durchlauf steht sie nicht.
  await settle();
  return { server, mounted };
}

function at(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function shownSteps(): string[] {
  const running = at("compose-running");
  return [...(running?.querySelectorAll("li") ?? [])].map((node) => node.textContent ?? "");
}

/** Den Knopf drücken und die Runde machen lassen. */
async function clickApply(): Promise<void> {
  const button = at("compose-apply");
  assert.ok(button !== null, "die Vorschau zeigt keinen Knopf zum Anwenden");
  await React.act(async () => {
    (button as HTMLButtonElement).click();
  });
  await settle();
}

/** Einspeisen und React die Runde machen lassen. */
async function send(server: { body: { push: (chunk: Uint8Array) => void } }, text: string): Promise<void> {
  await React.act(async () => {
    server.body.push(ENCODER.encode(text));
  });
  await settle();
}

const stepLine = (name: string): string => `${JSON.stringify({ kind: "step", step: name, detail: null })}\n`;

test("über der Obergrenze fallen die ältesten Schritte weg, und die Fläche sagt es", async () => {
  const { server, mounted } = await mount();
  try {
    await clickApply();
    // Der Arm meldet zuerst, dass er Schritte sendet.
    await send(server, `${JSON.stringify({ kind: "start", live: true, stackName: "media" })}\n`);

    const excess = 3;
    // Alles in EINEM Chunk: der Deckel hat mit dem Schnitt der Chunks nichts zu
    // tun, und ein Chunk je Schritt machte aus diesem Fall einen Zeitfresser.
    const all = Array.from({ length: HELD_STEP_CAP + excess }, (_, index) => stepLine(`step-${index}`)).join("");
    await send(server, all);

    const shown = shownSteps();
    assert.equal(shown.length, HELD_STEP_CAP, `gehalten werden ${shown.length} Schritte statt ${HELD_STEP_CAP}`);
    // ⚠️ Vorne wird weggeworfen und nicht hinten: der letzte Schritt ist der
    // laufende.
    assert.equal(shown[0], `step-${excess}`, "die ältesten Schritte stehen noch da");
    assert.equal(shown[shown.length - 1], `step-${HELD_STEP_CAP + excess - 1}`, "die neuesten Schritte fehlen");
    assert.ok(at("compose-steps-trimmed") !== null, "die Fläche verschweigt, dass sie Schritte verworfen hat");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("unter der Obergrenze steht kein Wort von verworfenen Schritten", async () => {
  const { server, mounted } = await mount();
  try {
    await clickApply();
    await send(server, `${JSON.stringify({ kind: "start", live: true, stackName: "media" })}\n`);
    await send(server, [stepLine("pull"), stepLine("create"), stepLine("run")].join(""));

    assert.deepEqual(shownSteps(), ["pull", "create", "run"], "die Schritte kommen nicht durch");
    assert.ok(at("compose-steps-trimmed") === null, "der Hinweis steht da, obwohl nichts verworfen wurde");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

// ── Die Schritte als Text ───────────────────────────────────────────────────

// Die Sprache folgt im Prüfstand der Browsersprache von happy-dom; geprüft
// wird deshalb gegen beide Fassungen.
const either = (key: keyof typeof de & keyof typeof en): string[] => [de[key], en[key]];

test("die Schritte stehen als Text da, nicht als Schlüssel — ein unbekannter wörtlich", async () => {
  const { server, mounted } = await mount({ ...PREVIEW, steps: ["validate", "pull-images", "remove-containers"] });
  try {
    const planned = [...(at("compose-steps")?.querySelectorAll("li") ?? [])].map((node) => node.textContent ?? "");
    assert.equal(planned.length, 3, `gesehen: ${JSON.stringify(planned)}`);
    assert.ok(either("composeStepValidate").includes(planned[0]), `gesehen: ${planned[0]}`);
    assert.ok(either("composeStepPullImages").includes(planned[1]), `gesehen: ${planned[1]}`);
    assert.ok(either("composeStepRemoveContainers").includes(planned[2]), `gesehen: ${planned[2]}`);

    await clickApply();
    await send(server, `${JSON.stringify({ kind: "start", live: true, stackName: "media" })}\n`);
    await send(
      server,
      [
        stepLine("check"),
        `${JSON.stringify({ kind: "step", step: "pull-images", detail: "sonarr:2" })}\n`,
        stepLine("resolve-containers"),
        stepLine("neuer-schritt")
      ].join("")
    );

    const shown = shownSteps();
    assert.equal(shown.length, 4, `gesehen: ${JSON.stringify(shown)}`);
    assert.ok(either("composeStepValidate").includes(shown[0]), `gesehen: ${shown[0]}`);
    assert.ok(
      either("composeStepPullImages").some((label) => shown[1] === `${label} · sonarr:2`),
      `das Detail geht verloren, gesehen: ${shown[1]}`
    );
    assert.ok(either("composeStepResolveContainers").includes(shown[2]), `gesehen: ${shown[2]}`);
    assert.equal(shown[3], "neuer-schritt", "ein Schritt, den der Hub nicht kennt, verschwindet");
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
