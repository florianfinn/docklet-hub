// ⚠️ Die Reihenfolge der Importe ist BEDEUTUNG und keine Formatierung: der DOM
// muss stehen, bevor React geladen wird (siehe `dom-harness.tsx`).
import { renderInDom, settle } from "./dom-harness.js";

// ⚠️ React steht hier NAMENTLICH, obwohl keine Zeile es aufruft — die
// Begründung steht im Kopf von `language-switch.test.tsx`.
import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import type { DockerHost } from "../src/domain/hosts/index.js";
import type { HostStatus } from "contract";
import type { Role } from "../src/platform/session/session-user.js";
import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { de, en } from "../src/app/i18n/messages.js";
import { formatAgo } from "../src/platform/i18n/time-format.js";
import { HostCard } from "../src/features/hosts/HostCard.js";

// WAS DIESE DATEI PRÜFT (#205)
//
// Die Karte eines Arms nennt zwei Zeitpunkte: wann sein Agent zuletzt
// geantwortet hat und wann sein Watcher zuletzt getauscht hat. Beide sind
// Auskünfte über die Vergangenheit, und beide haben einen Fall, in dem es
// sie nicht gibt — der muss als „noch nie“ dastehen und nicht als Fehler.

const TARGET = `ghcr.io/florianfinn/dashboard-docker-agent:v0.30.0@sha256:${"a".repeat(64)}`;

function hostOf(overrides: Partial<DockerHost> = {}): DockerHost {
  return {
    id: "host-1",
    name: "unraid",
    agentUrl: "http://10.254.0.2:8099",
    kind: "internal",
    state: "registered",
    status: "online" as HostStatus,
    agentVersion: "0.30.0",
    tunnelAddress: "10.254.0.2",
    display: { hue: "neutral", ink: "head" },
    agentUpdate: { targetVersion: "0.30.0", targetImageRef: TARGET, state: "current" },
    lastSeenAt: null,
    ...overrides
  };
}

function textOf(testId: string): string {
  const element = document.body.querySelector(`[data-testid="${testId}"]`);
  assert.ok(element instanceof HTMLElement, `„${testId}" steht nicht im Dokument`);
  return element.textContent ?? "";
}

// Als Wahrheitswert und nie als Knoten — AGENTS.md, Falle 2.
function nothingAt(selector: string): boolean {
  return document.body.querySelector(selector) === null;
}

type Call = { url: string; method: string };

function stubFetch(answer: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: (init?.method ?? "GET").toUpperCase() };
    calls.push(call);
    return Promise.resolve(answer(call));
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

async function card(host: DockerHost, role: Role = "admin") {
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <HostCard host={host} role={role} counters={{ state: "loading" }} onRemoved={() => {}} onAgentUpdated={() => {}} />
    </AppLanguageProvider>
  );
  await settle();
  return mounted;
}

test("das Alter eines Zeitpunkts in beiden Sprachen, ohne Blick in die Zukunft", () => {
  const now = new Date("2026-09-29T20:15:00.000Z");
  assert.equal(formatAgo("de", new Date("2026-09-29T20:12:00.000Z"), now), "vor 3 Minuten");
  assert.equal(formatAgo("en", new Date("2026-09-29T18:15:00.000Z"), now), "2 hours ago");
  assert.equal(formatAgo("de", new Date("2026-09-27T20:15:00.000Z"), now), "vorgestern");
  // Die Uhr des Hubs geht ein paar Sekunden vor: das ist „jetzt“ und nicht
  // „in 4 Sekunden“.
  assert.equal(formatAgo("de", new Date("2026-09-29T20:15:04.000Z"), now), "jetzt");
});

test("„Zuletzt erreichbar“ nennt den Zeitpunkt oder „noch nie“", async () => {
  const stub = stubFetch(() => json({}, 500));
  const seen = await card(hostOf({ status: "offline", lastSeenAt: "2026-09-29T20:12:00.000Z" }));
  try {
    const time = document.body.querySelector('[data-testid="last-seen-host-1"] time');
    assert.ok(time instanceof HTMLElement, "der Zeitpunkt steht als `time`");
    assert.equal(time.getAttribute("datetime"), "2026-09-29T20:12:00.000Z");
  } finally {
    await seen.unmount();
  }

  const never = await card(hostOf({ lastSeenAt: null }));
  try {
    const text = textOf("last-seen-host-1");
    assert.ok(text === de.hostLastSeenNever || text === en.hostLastSeenNever, `„noch nie“ statt „${text}“`);
  } finally {
    await never.unmount();
  }

  const pending = await card(hostOf({ status: "pending", state: "pending", agentUpdate: null }));
  try {
    assert.ok(nothingAt('[data-testid="last-seen-host-1"]'), "ein wartender Arm hat keine Zeile dafür");
  } finally {
    await pending.unmount();
    stub.restore();
  }
});

test("„Letztes Agent-Update“ nennt Zeitpunkt und Ausgang des Watchers", async () => {
  const stub = stubFetch(() =>
    json({
      running: false,
      version: "0.30.0",
      last: {
        jobId: "j-1",
        outcome: "ok",
        reason: null,
        fromVersion: "0.29.1",
        toVersion: "0.30.0",
        finishedAt: "2026-09-29T20:10:00.000Z"
      }
    })
  );
  const mounted = await card(hostOf());
  try {
    assert.deepEqual(stub.calls, [{ url: "/api/hosts/host-1/agent-update", method: "GET" }]);
    const row = document.body.querySelector('[data-testid="last-agent-update-host-1"]');
    assert.ok(row instanceof HTMLElement, "die Zeile steht da");
    assert.equal(row.querySelector("time")?.getAttribute("datetime"), "2026-09-29T20:10:00.000Z");
    assert.ok(row.textContent?.includes("0.30.0"), "der Ausgang nennt die Fassung");
  } finally {
    await mounted.unmount();
    stub.restore();
  }
});

test("ohne Lauf des Watchers steht „noch keines“ da, ohne Antwort gar nichts", async () => {
  const none = stubFetch(() => json({ running: false, version: "0.30.0", last: null }));
  const first = await card(hostOf());
  try {
    const text = textOf("last-agent-update-host-1");
    assert.ok(text === de.hostLastUpdateNone || text === en.hostLastUpdateNone, `„noch keines“ statt „${text}“`);
  } finally {
    await first.unmount();
    none.restore();
  }

  const failing = stubFetch(() => json({ error: "agent-unreachable", message: "weg" }, 502));
  const second = await card(hostOf());
  try {
    assert.ok(nothingAt('[data-testid="last-agent-update-host-1"]'), "ein stummer Arm bekommt keine Fehlerzeile");
  } finally {
    await second.unmount();
    failing.restore();
  }
});

test("wer nicht Administrator ist, fragt den Stand des Watchers gar nicht erst", async () => {
  // Die Route ist `requireAdmin`; die Frage endete in einem 403.
  const stub = stubFetch(() => json({}, 500));
  const mounted = await card(hostOf(), "user");
  try {
    assert.equal(stub.calls.length, 0);
    assert.ok(nothingAt('[data-testid="last-agent-update-host-1"]'));
  } finally {
    await mounted.unmount();
    stub.restore();
  }
});
