// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — `tsx`
// übersetzt das JSX dieser Datei mit dem alten Laufzeitmodell.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GLOBAL_THEME } from "contract";

import type { Settings } from "contract";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { DIRECTORY_NAME, HostCreateDialog } from "../src/features/hosts/HostCreateDialog.js";
import { DEFAULT_BIND_BASE_PATH } from "../src/features/hosts/HostForm.js";

// WAS DIESE DATEI PRÜFT UND WARUM GERADE DAS
//
// Der zweite Schritt des Anlege-Dialogs sagt seit D7c, WOHIN das Archiv auf dem
// Zielhost gehört — mit dem Pfad, den der Betreiber eine Maske vorher selbst
// eingetragen hat. Das ist die einzige Stelle der Oberfläche, an der eine
// Eingabe des ersten Schritts im zweiten wieder auftaucht, und sie kann auf
// zwei Arten still falsch werden:
//
//   1. DER PFAD IST NICHT DER, DER HINAUSGING. `HostForm` rechnet ihn einmal
//      (`bindBasePath.trim() || DEFAULT_BIND_BASE_PATH`) und schickt ihn an den
//      Server. Wer denselben Ausdruck ein zweites Mal für die Anzeige schreibt,
//      hat zwei Wahrheiten: der Dialog nennte dann ein Verzeichnis, das im
//      erzeugten Paket nicht steht, und der Betreiber legte den Arm woanders ab
//      als der Agent ihn erwartet.
//   2. DAS LEERE FELD. Der Pfad ist vorbelegt, aber löschbar. Ein Dialog, der
//      den ROHWERT anzeigte statt des gerechneten, schriebe dann
//      `/docklet-agent` — also ein Verzeichnis direkt in der Wurzel,
//      mit einem führenden Schrägstrich, der wie Absicht aussieht.
//
// Beide Fassungen übersetzen und bündeln sich; kein Wächter über Dateitexte
// sieht sie. Geprüft wird deshalb am gerenderten Baum.

const NAME_ID = "host-name";
const GID_ID = "host-docker-gid";
const PATH_ID = "host-bind-base-path";

function field(id: string): HTMLElement {
  const element = document.body.querySelector(`#${id}`);
  assert.ok(element instanceof HTMLElement, `das Feld „${id}" steht im Dialog`);
  return element;
}

/**
 * Einen Wert in ein Eingabefeld schreiben, so dass React ihn sieht.
 *
 * ⚠️ Über den Setter des Prototyps und nicht über `element.value = …`: React
 * merkt sich den zuletzt gesetzten Wert am Knoten und hielte eine direkte
 * Zuweisung für seine eigene. Das Ereignis liefe dann ohne Wirkung, der Zustand
 * bliebe leer, und der Test wäre grün an einer Stelle, an der er nichts misst.
 */
async function typeInto(element: HTMLElement, value: string): Promise<void> {
  assert.ok(element instanceof HTMLInputElement, "das Feld ist ein Eingabefeld");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter !== undefined, "der Setter des Prototyps ist da");
  await React.act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

/** Der Hub antwortet auf das Anlegen mit einem Arm — mehr braucht der Fall nicht. */
function stubCreate(refusal?: { status: number; body: unknown }): { bodies: unknown[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // The form reads the hub's network on opening; a complete wire shape,
    // since every reader of `/api/settings` parses it against the contract (#248).
    if (String(input).includes("/api/settings")) {
      const settings: Settings = {
        theme: DEFAULT_GLOBAL_THEME,
        logs: { tailLines: 500 },
        containers: { showSystem: false },
        network: { externalEndpoint: null, internalTarget: null, externalTarget: null, externalTargetUnreachable: false }
      };
      return Promise.resolve(
        new Response(JSON.stringify(settings), { status: 200, headers: { "content-type": "application/json" } })
      );
    }
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    if (refusal) {
      return Promise.resolve(
        new Response(JSON.stringify(refusal.body), {
          status: refusal.status,
          headers: { "content-type": "application/json" }
        })
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          host: {
            id: "host-1",
            name: "unraid",
            agentUrl: "http://10.254.0.2:8099",
            kind: "internal",
            state: "pending",
            status: "pending",
            agentVersion: null,
            tunnelAddress: "10.254.0.2",
            display: { hue: "neutral", ink: "head" },
            agentUpdate: null,
            lastSeenAt: null
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
  }) as typeof fetch;
  return { bodies, restore: () => (globalThis.fetch = original) };
}

/** Den Dialog öffnen, ausfüllen und absenden. `path` leer heißt: Feld leeren. */
async function createArm(path: string, name = "unraid"): Promise<void> {
  const trigger = document.body.querySelector("button");
  assert.ok(trigger instanceof HTMLElement, "der Auslöser des Dialogs steht da");
  await click(trigger);

  await typeInto(field(NAME_ID), name);
  await typeInto(field(GID_ID), "281");
  await typeInto(field(PATH_ID), path);

  const form = document.body.querySelector("form");
  assert.ok(form instanceof HTMLFormElement, "der Dialog trägt ein Formular");
  await React.act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Der Text aller `code`-Zeilen des zweiten Schritts. */
function commands(): string[] {
  return [...document.body.querySelectorAll("code")].map((element) => element.textContent ?? "");
}

test("der zweite Schritt nennt den Pfad, der wirklich hinausgegangen ist", async () => {
  const server = stubCreate();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCreateDialog onCreated={() => {}} />
    </AppLanguageProvider>
  );

  try {
    await createArm("/mnt/cache/docker");

    const sent = server.bodies.at(0) as { bindBasePath?: string } | undefined;
    assert.equal(sent?.bindBasePath, "/mnt/cache/docker", "der Pfad ging so an den Hub");

    // ⚠️ Gegen den GESENDETEN Wert geprüft und nicht gegen die Zeichenkette aus
    // dem Test: nur so fällt auf, wenn Anzeige und Paket auseinanderlaufen.
    const target = `${sent?.bindBasePath ?? ""}/${DIRECTORY_NAME}`;
    assert.ok(
      commands().some((command) => command.includes(target)),
      `keine Befehlszeile nennt „${target}" — gefunden: ${commands().join(" | ")}`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("ein geleertes Pfadfeld zeigt die Vorgabe und nicht die Wurzel", async () => {
  const server = stubCreate();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCreateDialog onCreated={() => {}} />
    </AppLanguageProvider>
  );

  try {
    await createArm("");

    // The server receives the default, so the dialog must show it too. A dialog
    // on the raw value would show `/docklet-agent`, a directory in the root.
    const sent = server.bodies.at(0) as { bindBasePath?: string } | undefined;
    assert.equal(sent?.bindBasePath, DEFAULT_BIND_BASE_PATH, "leer heißt: die Vorgabe geht hinaus");

    const shown = commands().filter((command) => command.includes(DIRECTORY_NAME));
    assert.equal(shown.length, 1, `genau eine Zeile nennt das Verzeichnis: ${shown.join(" | ")}`);
    assert.ok(
      shown[0]?.includes(`${DEFAULT_BIND_BASE_PATH}/${DIRECTORY_NAME}`),
      `die Zeile nennt die Vorgabe: „${shown[0] ?? ""}"`
    );
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("der Prompt steht vor dem Befehl, aber nicht im kopierbaren Text", async () => {
  const server = stubCreate();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCreateDialog onCreated={() => {}} />
    </AppLanguageProvider>
  );

  try {
    await createArm("/mnt/cache/docker");

    const lines = [...document.body.querySelectorAll("code")];
    assert.equal(lines.length, 3, "drei Befehlszeilen im zweiten Schritt");
    for (const code of lines) {
      const text = code.textContent ?? "";
      assert.equal(text.startsWith("$"), false, `„${text}" enthält den Prompt`);
      const prompt = code.previousElementSibling;
      assert.equal(prompt?.textContent?.trim() === "$", true, `„${text}" hat keinen Prompt davor`);
      assert.equal(prompt?.getAttribute("aria-hidden") === "true", true, "der Prompt wird vorgelesen");
    }
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("a name with a control character is refused before anything is sent", async () => {
  const server = stubCreate();
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCreateDialog onCreated={() => {}} />
    </AppLanguageProvider>
  );
  try {
    await createArm("/mnt/cache/docker", `arm${String.fromCharCode(9)}x`);
    assert.equal(server.bodies.length, 0, "no request left the form");
    const alert = document.body.querySelector("[role=alert]");
    assert.equal(alert?.textContent?.includes("control characters") === true, true, `shown: ${alert?.textContent ?? ""}`);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});

test("the hub's name-invalid code becomes its own text, not the generic one", async () => {
  const server = stubCreate({ status: 400, body: { error: "name-invalid", message: "Serversatz" } });
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCreateDialog onCreated={() => {}} />
    </AppLanguageProvider>
  );
  try {
    await createArm("/mnt/cache/docker");
    const alert = document.body.querySelector("[role=alert]");
    const text = alert?.textContent ?? "";
    assert.equal(text.includes("control characters") && !text.includes("Serversatz"), true, `shown: ${text}`);
  } finally {
    await mounted.unmount();
    server.restore();
  }
});
