// ⚠️ The import order matters: the DOM must stand before React is loaded
// (see `dom-harness.tsx`).
import { renderInDom, waitFor } from "./dom-harness.js";

import React from "react";

import assert from "node:assert/strict";
import test from "node:test";

import { AppLanguageProvider } from "../src/app/i18n/AppLanguageProvider.js";
import { NewProjectDialog } from "../src/features/compose/NewProjectDialog.js";

// The dialog "new project" (#3) at the rendered tree: the create button stays
// locked until the dry run is confirmed exactly, a follow-up question of the
// agent is answered with the agent's own list, and a refusal that left data in
// the folder says so.

const PREVIEW = {
  projectDir: "/home/docker/notes",
  stackName: "notes",
  valid: true,
  reason: null,
  errors: [],
  configError: null,
  services: ["app"],
  imagesByService: { app: "example/notes:1.0" },
  missingImages: [],
  servicesWithoutImage: [],
  mountSources: [
    { service: "app", kind: "project", source: "/home/docker/notes/data", target: "/data", readOnly: false, shared: false }
  ],
  externalSources: []
};

type Reply = { status: number; body: unknown };

function stubHub(creates: Reply[]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    let reply: Reply;
    if (url.endsWith("/projects/preview")) reply = { status: 200, body: { preview: PREVIEW } };
    else if (url.endsWith("/projects")) {
      bodies.push(body);
      reply = creates.shift() ?? { status: 500, body: { error: "unexpected" } };
    } else reply = { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } })
    );
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(id: string): Promise<void> {
  const element = byTestId(id);
  assert.ok(element instanceof HTMLElement, `${id} is there`);
  await React.act(async () => {
    element.click();
  });
}

async function typeName(value: string): Promise<void> {
  const element = byTestId("project-name");
  assert.ok(element instanceof HTMLInputElement, "the name field is there");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter !== undefined);
  await React.act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openAndCheck(): Promise<void> {
  await click("project-new-host-1");
  assert.equal(await waitFor(() => byTestId("project-name") !== null), true, "the dialog opened");
  await typeName("notes");
  await click("project-check");
  assert.equal(await waitFor(() => byTestId("project-preview") !== null), true, "the dry run is shown");
}

async function mount(creates: Reply[]) {
  const hub = stubHub(creates);
  const mounted = await renderInDom(
    <AppLanguageProvider>
      <NewProjectDialog hostId="host-1" hostName="unraid" />
    </AppLanguageProvider>
  );
  return {
    hub,
    done: async () => {
      await mounted.unmount();
      hub.restore();
    }
  };
}

function createDisabled(): boolean {
  const button = byTestId("project-create");
  return button instanceof HTMLButtonElement && button.disabled;
}

test("create stays locked until every new service is confirmed", async () => {
  const { hub, done } = await mount([
    { status: 200, body: { outcome: { kind: "created", project: { projectDir: "/home/docker/notes", hubOwned: true }, resync: { status: "synced", error: null } } } }
  ]);
  try {
    await openAndCheck();
    assert.equal(createDisabled(), true);
    assert.equal(byTestId("project-sources")?.textContent?.includes("/home/docker/notes/data"), true);
    await click("project-confirm-service-app");
    assert.equal(createDisabled(), false);
    await click("project-create");
    assert.equal(await waitFor(() => byTestId("project-created") !== null), true, "the created card is shown");
    assert.deepEqual(hub.bodies[0], {
      name: "notes",
      content: "services:\n  app:\n    image: \n    restart: unless-stopped\n",
      confirmNew: ["app"],
      acknowledgeImagePull: [],
      acknowledgeHardening: [],
      confirmExternalSources: []
    });
  } finally {
    await done();
  }
});

test("a follow-up question is answered with the agent's list and sent again", async () => {
  const { hub, done } = await mount([
    {
      status: 200,
      body: { outcome: { kind: "question", question: { kind: "external-sources", sources: ["/mnt/user/media"] }, projectDirRemoved: true } }
    },
    { status: 200, body: { outcome: { kind: "created", project: { hubOwned: true }, resync: { status: "synced", error: null } } } }
  ]);
  try {
    await openAndCheck();
    await click("project-confirm-service-app");
    await click("project-create");
    assert.equal(await waitFor(() => byTestId("project-question") !== null), true, "the question is shown");
    await click("project-answer");
    assert.equal(await waitFor(() => byTestId("project-created") !== null), true);
    assert.deepEqual(hub.bodies[1]?.confirmExternalSources, ["/mnt/user/media"]);
  } finally {
    await done();
  }
});

test("a refused create says when data stayed in the folder", async () => {
  const { done } = await mount([
    { status: 409, body: { error: "agent-conflict", reason: "compose-up-failed", projectDirRemoved: false } }
  ]);
  try {
    await openAndCheck();
    await click("project-confirm-service-app");
    await click("project-create");
    assert.equal(await waitFor(() => byTestId("project-failure") !== null), true, "the failure is shown");
    const text = byTestId("project-failure")?.textContent ?? "";
    assert.equal(text.includes("Projektordner") || text.includes("project folder"), true, text);
  } finally {
    await done();
  }
});

test("editing after a question ends it, and a new check is needed before creating", async () => {
  const { hub, done } = await mount([
    {
      status: 200,
      body: { outcome: { kind: "question", question: { kind: "external-sources", sources: ["/mnt/user/media"] }, projectDirRemoved: true } }
    }
  ]);
  try {
    await openAndCheck();
    await click("project-confirm-service-app");
    await click("project-create");
    assert.equal(await waitFor(() => byTestId("project-question") !== null), true, "the question is shown");

    await typeName("notes2");
    assert.equal(byTestId("project-question"), null, "the question ended with the edit");
    assert.equal(createDisabled(), true, "creating waits for a new check");
    assert.equal(hub.bodies.length, 1, "nothing was sent for the edited draft");
  } finally {
    await done();
  }
});

test("checking again clears an open question", async () => {
  const { done } = await mount([
    {
      status: 200,
      body: { outcome: { kind: "question", question: { kind: "external-sources", sources: ["/mnt/user/media"] }, projectDirRemoved: true } }
    }
  ]);
  try {
    await openAndCheck();
    await click("project-confirm-service-app");
    await click("project-create");
    assert.equal(await waitFor(() => byTestId("project-question") !== null), true);
    await click("project-check");
    assert.equal(await waitFor(() => byTestId("project-question") === null), true, "the old question is gone");
  } finally {
    await done();
  }
});
