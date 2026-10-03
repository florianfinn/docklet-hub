// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — die
// Begründung steht im Kopf von `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "use-intl";

import type { AgentUpdateOffer, HostStatus } from "contract";
import type { DockerHost } from "../src/domain/hosts/index.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import { describeOutcome } from "../src/features/hosts/AgentUpdate.js";
import { HostCard } from "../src/features/hosts/HostCard.js";
import { TooltipProvider } from "../src/platform/ui/shadcn/tooltip.js";

// WAS DIESE DATEI PRÜFT
//
// Der Knopf „Agent aktualisieren" (#7) hat drei Zusagen, die keine Typprüfung
// sieht:
//
//   1. Er erscheint NUR bei `available`. Bei `manual` liest der Arm das Ziel
//      nicht, und ein Klick endete beim Watcher mit `unchanged` — die Karte
//      zeigt dort stattdessen die eine Zeile für den Schritt von Hand.
//   2. Der Anstoß steht hinter einer Rückfrage: er tauscht den Agenten, und
//      der Arm ist dabei Sekunden weg.
//   3. Ein Fehler beim Nachfragen ist „läuft noch" und kein Abbruch — während
//      des Tauschs antwortet der Arm nicht. Erst der Lauf mit DERSELBEN
//      Auftragsnummer beendet das Warten.

const TARGET = `ghcr.io/florianfinn/dashboard-docker-agent:v0.30.0@sha256:${"a".repeat(64)}`;

function hostOf(agentUpdate: AgentUpdateOffer | null): DockerHost {
  return {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    status: "online" as HostStatus,
    agentVersion: "0.29.1",
    tunnelAddress: "10.254.0.2",
    display: { hue: "neutral", ink: "head" },
    agentUpdate,
    lastSeenAt: null
  };
}

function offer(state: AgentUpdateOffer["state"]): AgentUpdateOffer {
  return { targetVersion: "0.30.0", targetImageRef: TARGET, state };
}

function find(testId: string): HTMLElement {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element instanceof HTMLElement, `„${testId}" steht nicht im Dokument`);
  return element;
}

// Als Wahrheitswert und nie als Knoten — AGENTS.md, Falle 2.
function nothingAt(selector: string): boolean {
  return document.body.querySelector(selector) === null;
}

async function click(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

async function card(host: DockerHost, onAgentUpdated: () => void = () => {}) {
  return renderInDom(
    <AppLanguageProvider>
      {/* The `outdated` badge carries a tooltip; in the app the provider sits at the root of `AppShell`. */}
      <TooltipProvider>
        <HostCard host={host} role="admin" counters={{ state: "loading" }} onRemoved={() => {}} onAgentUpdated={onAgentUpdated} />
      </TooltipProvider>
    </AppLanguageProvider>
  );
}

type Call = { url: string; method: string };

function stubFetch(answer: (call: Call, index: number) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: (init?.method ?? "GET").toUpperCase() };
    calls.push(call);
    return Promise.resolve(answer(call, calls.length - 1));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("bei `current` steht der Knopf gesperrt da, mit der Fassung", async () => {
  // Bis #202 war er hier ausgeblendet — auf dem ersten Arm mit v0.30.0 las
  // sich das als „der Knopf fehlt“.
  const stub = stubFetch(() => json({}, 500));
  const mounted = await card(hostOf(offer("current")));
  try {
    const button = find("agent-update-host-1");
    assert.equal(button.tagName, "BUTTON");
    assert.ok(button.hasAttribute("disabled"), "gesperrt: der Watcher zöge denselben Pin");
    assert.ok(button.textContent?.includes("0.30.0"), "die Beschriftung nennt die Fassung");
    await click(button);
    // Gezählt werden POSTs: den Stand des Watchers liest die Karte beim
    // Aufbau ohnehin (`LastAgentUpdate`, #205), angestoßen wird nichts.
    assert.ok(!stub.calls.some((call) => call.method === "POST"), "ein Klick stößt nichts an");
    assert.ok(nothingAt('[role="dialog"]'), "und öffnet keine Rückfrage");
    assert.ok(nothingAt('[data-testid="agent-update-manual-host-1"]'), "kein Hinweis für den Handschritt");
  } finally {
    await mounted.unmount();
    stub.restore();
  }
});

test("bei `manual` steht statt des Knopfs die Zeile für die .env", async () => {
  const mounted = await card(hostOf(offer("manual")));
  try {
    assert.ok(nothingAt('[data-testid="agent-update-host-1"]'), "kein Knopf, der nur `unchanged` ergäbe");
    const hint = find("agent-update-manual-host-1");
    assert.ok(hint.textContent?.includes(`DOCKER_AGENT_IMAGE=${TARGET}`), "die Zeile nennt den vollen Ref");
  } finally {
    await mounted.unmount();
  }
});

test("ein Arm mit altem Agenten zeigt die Anleitung zum Umstieg, die Zeile nur einmal", async () => {
  // R38 (#280): `outdated` heißt zu alte Fassung ODER zu altes Protokoll; die
  // Karte sagt in beiden Fällen dasselbe und nennt den Ref, den der Hub pinnt.
  const stub = stubFetch(() => json({ running: false, version: "0.31.0", last: null }));
  const mounted = await card({ ...hostOf(offer("manual")), status: "outdated" as HostStatus, agentVersion: "0.31.0" });
  try {
    const note = find("agent-migration-host-1");
    assert.ok(note.textContent?.includes(`DOCKER_AGENT_IMAGE=${TARGET}`), "die Zeile nennt den vollen Ref");
    assert.ok(note.textContent?.includes("sudo docker compose up -d"), "der Neustart steht dabei");
    assert.ok(nothingAt('[data-testid="agent-update-manual-host-1"]'), "die Zeile steht nicht doppelt auf der Karte");
    assert.ok(nothingAt('[data-testid="agent-update-host-1"]'), "kein Knopf, der nur `unchanged` ergäbe");
  } finally {
    await mounted.unmount();
    stub.restore();
  }
});

test("ein Arm, der nur am Protokoll veraltet ist und das Ziel liest, zieht mit dem Knopf um", async () => {
  // Review of #294: from 0.32.0 on the agent reads the target, so an arm that
  // is `outdated` by its protocol alone moves with the button. A note that
  // sends the operator to the host by hand would contradict it.
  const mounted = await card({ ...hostOf(offer("available")), status: "outdated" as HostStatus, agentVersion: "0.32.0" });
  try {
    assert.ok(nothingAt('[data-testid="agent-migration-host-1"]'), "kein Handschritt neben dem Knopf");
    find("agent-update-host-1");
  } finally {
    await mounted.unmount();
  }
});

test("die Anleitung zum Umstieg steht in beiden Sprachen und nur bei `outdated`", async () => {
  for (const [name, messages] of [["de", de], ["en", en]] as const) {
    const t = createTranslator({ locale: name, messages });
    for (const key of ["hostMigrationTitle", "hostMigrationBody", "hostMigrationStepImage", "hostMigrationStepRestart"] as const) {
      assert.notEqual(t(key), "", `${name}: ${key} ist leer`);
    }
  }
  const mounted = await card(hostOf(offer("current")));
  try {
    assert.ok(nothingAt('[data-testid="agent-migration-host-1"]'), "ein aktueller Arm trägt keinen Hinweis");
  } finally {
    await mounted.unmount();
  }
});

test("bei `available` stößt erst die Rückfrage an, und das Warten endet am eigenen Auftrag", async () => {
  let finished = 0;
  // Ein Objekt und keine Variable: TypeScript verengte eine Variable nach der
  // ersten Prüfung auf `null` und sähe die spätere Zuweisung im Rückruf nicht.
  const posted: { at: number | null } = { at: null };
  const stub = stubFetch((call, index) => {
    if (call.method === "POST") {
      posted.at = index;
      return json({ jobId: "j-2", targetVersion: "0.30.0" }, 202);
    }
    // Vor dem Anstoß: die Karte liest den letzten Lauf (#205), es gibt keinen.
    if (posted.at === null) return json({ running: false, version: "0.29.1", last: null });
    // Erste Nachfrage: der Arm tauscht gerade und antwortet nicht.
    if (index === posted.at + 1) return json({ error: "agent-unreachable", message: "weg" }, 502);
    return json({
      running: false,
      version: "0.30.0",
      last: { jobId: "j-2", outcome: "ok", reason: null, fromVersion: "0.29.1", toVersion: "v0.30.0", finishedAt: null }
    });
  });
  const mounted = await card(hostOf(offer("available")), () => {
    finished += 1;
  });
  try {
    await click(find("agent-update-host-1"));
    assert.equal(posted.at, null, "das Öffnen der Rückfrage stößt noch nichts an");

    await click(find("agent-update-confirm-host-1"));
    assert.ok(posted.at !== null, "erst die Bestätigung stößt an");
    const start = posted.at ?? 0;
    assert.deepEqual(stub.calls[start], { url: "/api/hosts/host-1/agent-update", method: "POST" });
    // Gegen beide Sprachdateien: welche gilt, entscheidet die Sprache des
    // Prüfstands (happy-dom meldet `en-US`), und die ist nicht Gegenstand hier.
    const running = find("agent-update-status-host-1").textContent;
    assert.ok(running === de.hostAgentUpdateRunning || running === en.hostAgentUpdateRunning, "der Stand sagt „läuft“");
    assert.ok(nothingAt('[data-testid="agent-update-host-1"]'), "während des Tauschs kein zweiter Knopf");

    // Zwei Takte zu je drei Sekunden: der erste endet im 502, der zweite im
    // Ausgang. Echt gewartet — der Takt ist Teil dessen, was hier gilt.
    for (let round = 0; round < 2; round += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_100));
      });
      await settle();
    }

    assert.equal(stub.calls.length - start, 3, "ein POST und zwei Nachfragen");
    assert.equal(stub.calls[start + 1].method, "GET");
    assert.ok(
      find("agent-update-status-host-1").textContent?.includes("v0.30.0"),
      "der Ausgang nennt die neue Fassung"
    );
    assert.equal(finished, 1, "die Liste wird genau einmal neu gemessen");
  } finally {
    await mounted.unmount();
    stub.restore();
  }
});

test("eine Ablehnung des Arms steht in der Rückfrage, mit seinem Schlüssel übersetzt", async () => {
  const stub = stubFetch(() => json({ error: "agent-conflict", message: "x", reason: "already-running" }, 409));
  const mounted = await card(hostOf(offer("available")));
  try {
    await click(find("agent-update-host-1"));
    await click(find("agent-update-confirm-host-1"));
    const alert = document.body.querySelector('[role="alert"]');
    assert.ok(alert instanceof HTMLElement, "eine Fehlermeldung steht im Dialog");
    assert.ok(
      alert.textContent === de.hostAgentUpdateBusy || alert.textContent === en.hostAgentUpdateBusy,
      "`already-running` wird zum eigenen Satz und nicht zum Sammeltext"
    );
  } finally {
    await mounted.unmount();
    stub.restore();
  }
});

test("jeder Ausgang des Watchers hat einen Satz, auch ein unbekannter", () => {
  const t = createTranslator({ locale: "de", messages: de });
  const run = { jobId: "j", reason: null, fromVersion: "0.29.1", toVersion: "v0.30.0", finishedAt: null };
  assert.equal(describeOutcome(t, { ...run, outcome: "ok" }).tone, "ok");
  assert.equal(describeOutcome(t, { ...run, outcome: "unchanged" }).tone, "ok");
  for (const outcome of ["aborted", "rolled-back", "failed"]) {
    assert.equal(describeOutcome(t, { ...run, outcome }).tone, "error", outcome);
  }
  const unknown = describeOutcome(t, { ...run, outcome: "paused" });
  assert.equal(unknown.tone, "error");
  assert.ok(unknown.message.includes("paused"), "der unbekannte Ausgang steht wörtlich da");
});
