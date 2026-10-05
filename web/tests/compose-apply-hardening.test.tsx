// ⚠️ The import order matters: the DOM must stand before React is loaded
// (see `dom-harness.tsx`).
import { renderInDom, settle, waitFor } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { ComposeApply } from "../src/features/compose/ComposeApply.js";

// Applying a draft that introduces risky settings (#8): the findings the agent
// already measured are explained, and new ones are confirmed one by one with
// exactly the agent's list before the draft goes out again.

const EXISTING = "web:docker-socket-mount — /var/run/docker.sock";
const NEW = ["web:privileged — privileged=true", "web:sensitive-host-path — /etc/ssl"];

const PREVIEW = {
  source: "agent",
  valid: true,
  reason: null,
  errors: [],
  configError: null,
  services: ["web"],
  diff: { new: [], removed: [], kept: ["web"] },
  imagesByService: { web: "example/web:1" },
  missingImages: [],
  servicesWithoutImage: [],
  inventoryViolations: [EXISTING],
  composeHash: "h1",
  stackName: "site",
  currentServices: ["web"],
  steps: [],
  uncertainties: []
};

const QUESTION = [
  JSON.stringify({ kind: "start", live: true, stackName: "site" }),
  JSON.stringify({ kind: "question", question: { kind: "hardening", newViolations: NEW, rolledBack: true } })
].join("\n");

function stubHub(replies: string[] = [QUESTION]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/compose/preview")) {
      return Promise.resolve(
        new Response(JSON.stringify({ preview: PREVIEW }), { status: 200, headers: { "content-type": "application/json" } })
      );
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)] ?? QUESTION;
    return Promise.resolve(new Response(`${reply}\n`, { status: 200 }));
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function at(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string): Promise<void> {
  const element = at(testId);
  assert.ok(element instanceof HTMLElement, `${testId} is there`);
  await React.act(async () => {
    element.click();
  });
  await settle();
}

function answerLocked(): boolean {
  const button = at("compose-answer");
  return button instanceof HTMLButtonElement && button.disabled;
}

async function mountApply() {
  return renderInDom(
    <AppLanguageProvider>
      <ComposeApply
        hostId="host-1"
        containerId="container-1"
        draft={"services:\n  web:\n    image: example/web:1\n    privileged: true\n"}
        expectedComposeHash="h1"
        changed
        onApplied={() => undefined}
        onReload={() => undefined}
        onClose={() => undefined}
      />
    </AppLanguageProvider>
  );
}

test("existing findings are explained, new ones are confirmed one by one", async () => {
  const hub = stubHub();
  const mounted = await mountApply();

  try {
    assert.equal(await waitFor(() => at("compose-existing-violations") !== null), true, "the inventory is explained");
    assert.equal(at("compose-existing-violations")?.textContent?.includes("/var/run/docker.sock"), true);
    assert.equal(at("compose-existing-violations-delegation-lock") !== null, true);

    await click("compose-apply");
    assert.equal(await waitFor(() => at("compose-new-violations") !== null), true, "the new findings are shown");
    assert.equal(document.body.querySelectorAll('[data-testid="compose-new-violations-item"]').length, 2);
    assert.equal(answerLocked(), true, "no confirmation with one click");
    assert.equal(at("compose-hardening-missing") !== null, true);

    await click(`compose-new-violations-check-${NEW[0]}`);
    assert.equal(answerLocked(), true, "one finding is still open");
    await click(`compose-new-violations-check-${NEW[1]}`);
    assert.equal(answerLocked(), false);
    assert.equal(at("compose-hardening-missing"), null);

    await click("compose-answer");
    assert.equal(await waitFor(() => hub.bodies.length === 2), true, "the draft goes out again");
    assert.deepEqual(hub.bodies[0]?.acknowledgeHardening, []);
    assert.deepEqual(hub.bodies[1]?.acknowledgeHardening, NEW);
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});

test("a second question starts with no ticks, even for a finding confirmed before", async () => {
  const further = [...NEW, "web:host-namespace — pid=host"];
  const second = [
    JSON.stringify({ kind: "start", live: true, stackName: "site" }),
    JSON.stringify({ kind: "question", question: { kind: "hardening", newViolations: further, rolledBack: true } })
  ].join("\n");
  const hub = stubHub([QUESTION, second]);
  const mounted = await mountApply();
  try {
    assert.equal(await waitFor(() => at("compose-apply") !== null), true);
    await click("compose-apply");
    assert.equal(await waitFor(() => at("compose-new-violations") !== null), true);
    for (const key of NEW) await click(`compose-new-violations-check-${key}`);
    await click("compose-answer");

    assert.equal(
      await waitFor(() => document.body.querySelectorAll('[data-testid="compose-new-violations-item"]').length === 3),
      true,
      "the second question is shown"
    );
    for (const key of further) {
      const box = at(`compose-new-violations-check-${key}`);
      assert.equal(box instanceof HTMLInputElement && box.checked, false, `${key} starts unticked`);
    }
    assert.equal(answerLocked(), true);
  } finally {
    await mounted.unmount();
    hub.restore();
  }
});
