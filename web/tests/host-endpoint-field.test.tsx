import { DEFAULT_SELF_HEALING_CONFIG } from "contract";
// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG: der DOM muss stehen, bevor
// React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GLOBAL_THEME } from "contract";

import type { Settings } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { HostCreateDialog } from "../src/features/hosts/HostCreateDialog.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der Anlege-Dialog ist seit #4 nach ART ZUGESCHNITTEN, und jede Hälfte dieses
// Schnitts kann still falsch werden:
//
//   1. DAS FELD AM FALSCHEN ARM. Für einen INTERNEN Arm ist die Adresse des
//      Hubs fest — es ist seine Adresse im eigenen Netz —, und ein Feld dafür
//      kann nur falsch ausgefüllt werden. Erscheint es dort wieder, stellt der
//      Dialog eine Frage, die der Betreiber nicht beantworten kann, und ein
//      eingetippter Wert landete in einer wg0.conf, in der er nichts verloren
//      hat.
//   2. DIE FEHLENDE PFLICHT AM RICHTIGEN. Für einen EXTERNEN Arm ist sie die
//      eine Angabe, ohne die sein Tunnel nie zustande kommt. Fehlt sie und
//      geht die Anfrage trotzdem hinaus, entsteht ein Archiv mit einer
//      privaten Adresse — und das gibt es nach Bauart genau einmal.
//   3. DIE ADRESSE AM FALSCHEN ORT. „Merken“ heißt: sie gehört dem HUB. Wird
//      sie zusätzlich als `endpointOverride` an diesen Arm geschrieben, hat sie
//      zwei Wohnsitze; wer sie später in den Einstellungen ändert, ändert sie
//      überall außer bei diesem einen Arm, und genau der fällt still aus.
//
// Alle drei Fassungen übersetzen und bündeln sich. Geprüft wird deshalb am
// gerenderten Baum und an dem, was `fetch` zu sehen bekommt.

type Call = { method: string; url: string; body: unknown };

const REACHABLE = {
  externalEndpoint: "hub.dyndns.invalid",
  internalTarget: "192.0.2.31:51821",
  externalTarget: "hub.dyndns.invalid:51821",
  externalTargetUnreachable: false,
};

const UNREACHABLE = {
  externalEndpoint: null,
  internalTarget: "192.0.2.31:51821",
  externalTarget: "192.0.2.31:51821",
  externalTargetUnreachable: true,
};

function stubHub(network: typeof REACHABLE | typeof UNREACHABLE): {
  calls: Call[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });

    if (url.includes("/api/settings/network")) {
      return Promise.resolve(
        json({
          network: {
            externalEndpoint: (
              body as never as { network: { externalEndpoint: string } }
            ).network.externalEndpoint,
          },
        }),
      );
    }
    if (url.includes("/api/settings")) {
      // A complete wire shape: every reader of `/api/settings` parses it against the
      // contract since #248.
      const settings: Settings = {
        theme: DEFAULT_GLOBAL_THEME,
        runtime: { applyComposeDefinition: true },
        selfHealing: { config: DEFAULT_SELF_HEALING_CONFIG, revision: 1, hosts: [] },
        logs: { tailLines: 500 },
        containers: { showSystem: false },
        network,
      };
      return Promise.resolve(json(settings));
    }
    return Promise.resolve(
      json(
        {
          host: {
            id: "host-1",
            name: "arm",
            agentUrl: "http://10.254.0.2:8099",
            kind: "external",
            state: "pending",
            status: "pending",
            agentVersion: null,
            tunnelAddress: "10.254.0.2",
            display: { hue: "neutral", ink: "head" },
            agentUpdate: null,
            lastSeenAt: null,
          },
        },
        201,
      ),
    );
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

function at(testId: string): HTMLElement | null {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  return element instanceof HTMLElement ? element : null;
}

function need(testId: string): HTMLElement {
  const element = at(testId);
  assert.ok(element, `„${testId}“ steht nicht im Dokument`);
  return element;
}

function field(id: string): HTMLInputElement {
  const element = document.body.querySelector(`#${id}`);
  assert.ok(
    element instanceof HTMLInputElement,
    `das Feld „${id}“ steht im Formular`,
  );
  return element;
}

async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

async function typeInto(element: HTMLElement, value: string): Promise<void> {
  assert.ok(
    element instanceof HTMLInputElement,
    "das Feld ist ein Eingabefeld",
  );
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  assert.ok(setter !== undefined, "der Setter des Prototyps ist da");
  await React.act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Die Art auf „extern“ stellen.
 *
 * ⚠️ ÜBER DIE TASTATUR und nicht über einen Zeiger. Der Ausklärer von Radix
 * ruft beim Öffnen  auf dem Auslöser auf; happy-dom kennt
 * die Methode nicht, und der Aufruf endet in einem Fehler, bevor irgendetwas
 * aufgeht. Die Tastaturbedienung ist ohnehin der Weg, den ein Wächter prüfen
 * sollte: sie muss funktionieren, der Zeiger ist nur die zweite Möglichkeit.
 */
async function chooseExternal(): Promise<void> {
  const trigger = document.body.querySelector("#host-kind");
  assert.ok(
    trigger instanceof HTMLElement,
    "das Auswahlfeld für die Art steht da",
  );
  await React.act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
  assert.equal(
    trigger.getAttribute("aria-expanded"),
    "true",
    "die Auswahl steht offen",
  );
  await click(need("host-kind-external"));
}

async function mount(network: typeof REACHABLE | typeof UNREACHABLE) {
  const server = stubHub(network);
  const created: string[] = [];
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCreateDialog onCreated={(host) => created.push(host.id)} />
    </AppLanguageProvider>,
  );
  // ⚠️ Das Formular steht IM Dialog und trägt dessen Fußzeile. Für sich
  // gerendert wirft Radix „DialogClose must be used within Dialog" — geprüft
  // wird deshalb die echte Zusammensetzung und keine Attrappe drumherum.
  const trigger = document.body.querySelector("button");
  assert.ok(trigger instanceof HTMLElement, "der Auslöser des Dialogs steht da");
  await click(trigger);
  await settle();
  return { server, created, mounted };
}

async function fillBase(): Promise<void> {
  await typeInto(field("host-name"), "remote-host");
  await typeInto(field("host-docker-gid"), "0");
}

async function submit(): Promise<void> {
  const form = document.body.querySelector("form");
  assert.ok(form instanceof HTMLFormElement, "das Formular steht da");
  await React.act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

test("ein interner Arm bekommt gar kein Adressfeld — aber die Auskunft, was er anwählt", async () => {
  const { server, mounted } = await mount(REACHABLE);
  try {
    // ⚠️ Gegen einen Wahrheitswert verglichen und nicht gegen den Knoten. Ein
    // `assert.equal(knoten, null)` geht im grünen Fall durch und reicht im
    // ROTEN das gefundene Element an die Fehlerausgabe weiter; unter happy-dom
    // hängt daran der halbe Fensterbaum mit Zyklen. Gemessen in der
    // Mutationsprobe „field-always": 60 Sekunden bis zum Speicherfehler statt
    // eines Satzes. Derselbe Fund wie in #90 — hier noch einmal gemacht.
    assert.ok(
      document.body.querySelector("#host-endpoint-override") === null,
      "für einen internen Arm gibt es nichts einzutragen: die Adresse des Hubs im eigenen Netz steht fest"
    );
    // ⚠️ Die INTERNE Adresse und nicht die externe. Ein interner Arm, der die
    // DynDNS-Adresse bekäme, führte seinen Tunnel über das Internet und die
    // eigene Portfreigabe statt über zwei Meter Kabel — er liefe, und niemand
    // sähe es.
    assert.match(
      need("host-endpoint-target").textContent ?? "",
      /192\.0\.2\.31:51821/,
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein externer Arm bekommt das Feld und die Adresse, die für ihn gilt", async () => {
  const { server, mounted } = await mount(REACHABLE);
  try {
    await chooseExternal();
    assert.ok(
      document.body.querySelector("#host-endpoint-override"),
      "das Feld steht bei „extern“ da",
    );
    assert.match(
      need("host-endpoint-target").textContent ?? "",
      /hub\.dyndns\.invalid:51821/,
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ohne brauchbare Adresse wird der externe Arm gar nicht erst abgeschickt", async () => {
  const { server, created, mounted } = await mount(UNREACHABLE);
  try {
    await chooseExternal();
    await fillBase();
    await submit();

    // ⚠️ NICHTS ist hinausgegangen. Der Server wiese es ohnehin ab — aber ein
    // Formular, das erst dorthin läuft, hat den Betreiber schon einen Klick
    // weit in eine Erzeugung gehen lassen, die es nur einmal gibt.
    assert.ok(
      !server.calls.some((call) => call.method === "POST"),
      `es wurde angelegt: ${server.calls.map((call) => `${call.method} ${call.url}`).join(", ")}`,
    );
    assert.deepEqual(created, []);
    // ⚠️ Und die Meldung steht da — geprüft am  und nicht am
    // Wortlaut: die Sprache des Testlaufs hängt am Browser, und ein Wächter,
    // der deutschen Text erwartet, wäre auf Englisch rot gegen eine richtige
    // Oberfläche. (Gemessen: genau so ist dieser Fall zuerst gescheitert.)
    assert.ok(
      document.body.querySelector('[role="alert"]'),
      "die Meldung steht im Formular",
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("„merken“ legt die Adresse beim HUB ab und nicht am Arm", async () => {
  const { server, mounted } = await mount(UNREACHABLE);
  try {
    await chooseExternal();
    await fillBase();
    await typeInto(field("host-endpoint-override"), "hub.dyndns.invalid");
    // Vorgabe ist gemerkt: die Adresse gehört dem Hub, nicht diesem Arm.
    const box = need("host-endpoint-remember");
    assert.ok(
      box instanceof HTMLInputElement && box.checked,
      "„merken“ ist die Vorgabe",
    );
    await submit();

    const settingsWrite = server.calls.find((call) =>
      call.url.includes("/api/settings/network"),
    );
    assert.ok(settingsWrite, "die Adresse wurde nicht am Hub abgelegt");
    assert.equal(settingsWrite.method, "PUT");
    assert.deepEqual(settingsWrite.body, {
      network: { externalEndpoint: "hub.dyndns.invalid" },
    });

    const create = server.calls.find((call) => call.method === "POST");
    assert.ok(create, "der Arm wurde nicht angelegt");
    // ⚠️ DIE ZUSAGE DIESES FALLS: der Arm bekommt KEINE eigene Kopie. Sonst
    // hätte die Adresse zwei Wohnsitze, und wer sie später in den Einstellungen
    // ändert, änderte sie überall außer hier.
    assert.equal(
      (create.body as { endpointOverride: unknown }).endpointOverride,
      null,
    );
    // Und die Reihenfolge: erst die Einstellung, dann der Arm. Andersherum
    // stünde bei einem Fehlschlag ein Arm da, dessen Adresse nirgends steht.
    assert.ok(
      server.calls.indexOf(settingsWrite) < server.calls.indexOf(create),
      "der Arm wurde angelegt, bevor die Adresse stand",
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("abgewähltes „merken“ schreibt die Adresse an genau diesen Arm", async () => {
  const { server, mounted } = await mount(UNREACHABLE);
  try {
    await chooseExternal();
    await fillBase();
    await typeInto(field("host-endpoint-override"), "nur.dieser.invalid");
    await click(need("host-endpoint-remember"));
    await submit();

    assert.ok(
      !server.calls.some((call) => call.url.includes("/api/settings/network")),
      "die Einstellung des Hubs wurde angefasst, obwohl „merken“ abgewählt war",
    );
    const create = server.calls.find((call) => call.method === "POST");
    assert.ok(create, "der Arm wurde nicht angelegt");
    assert.equal(
      (create.body as { endpointOverride: unknown }).endpointOverride,
      "nur.dieser.invalid",
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
